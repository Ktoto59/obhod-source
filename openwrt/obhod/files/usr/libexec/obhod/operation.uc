// SPDX-License-Identifier: Apache-2.0
// Short atomic transitions only. No supervisor, polling loop or long-held lock.
import { open, fdopen, readfile, writefile, mkdir, rmdir, unlink, lsdir, popen } from 'fs';
const RUN = '/var/run/obhod/', GLOBAL = '/var/lock/obhod-apply.lock';
let guard = open('/var/lock/obhod-operations.guard', 'a');
if (!guard || !guard.lock('x')) die('Cannot lock operation state');
let kinds = ['core', 'update', 'job', 'apply'];
function path(kind) { return kind == 'apply' ? GLOBAL : '/var/lock/obhod-' + kind + '.lock'; }
function get(dir, name) { return trim(readfile(dir + '/' + name) || ''); }
function put(dir, name, value) { if (writefile(dir + '/' + name, value + '\n') == null) die('Cannot save operation state'); }
function birth(pid) {
    let record = readfile('/proc/' + pid + '/stat');
    // comm may contain spaces and closing parentheses. State is field 3.
    let fields = record ? split(replace(record, /^.*\) /, ''), ' ') : [];
    return { state: fields[0], start: fields[19] || '' };
}
function alive(pid, start) {
    if (!match(pid, /^[1-9][0-9]*$/)) return false;
    let record = birth(pid);
    if (record.state == 'Z' || record.state == 'X' || (start && record.start != start)) return false;
    // kill also covers a live process when /proc is temporarily unavailable.
    return system('/bin/kill -0 ' + pid + ' 2>/dev/null') == 0;
}
function packagesBusy() {
    let cmd = popen('pidof apk opkg 2>/dev/null', 'r');
    if (!cmd) return true;
    let pids = split(trim(cmd.read('all') || ''), /\s+/); cmd.close();
    for (let pid in pids) if (alive(pid, '')) return true;
    return false;
}
function clear(dir) {
    // Never recurse into a path supplied by a caller or remove unknown files.
    for (let name in ['pid', 'birth', 'started', 'token', 'phase', 'kind', 'work', 'lease']) unlink(dir + '/' + name);
    if (!rmdir(dir)) die('Cannot release operation lock');
}
function result(kind, state, message) {
    if (kind == 'apply') return;
    put(RUN, kind + '-message', message); put(RUN, kind + '-state', state);
}
function release(kind) {
    let dir = path(kind), token = get(dir, 'token');
    if (kind != 'apply') clear(dir);
    if (kind == 'apply' || (get(GLOBAL, 'kind') == kind && (!token || get(GLOBAL, 'token') == token)) || !get(GLOBAL, 'kind')) {
        if (lsdir(GLOBAL) != null) clear(GLOBAL);
    }
}
function recover() {
    for (let kind in kinds) {
        let dir = path(kind);
        if (lsdir(dir) == null) continue;
        // A required core migration is a child of synchronous apply/recovery.
        // Its lock must protect it even if that parent's PID has disappeared.
        if (kind == 'apply' && length(filter(['core','update','job'], k => lsdir(path(k)) != null))) continue;
        // FD 9 is inherited by control/package-manager children. A worker killed
        // by OOM may still have live descendants doing real work. Never recover
        // their operation merely because the recorded parent PID disappeared.
        let lease = open(dir + '/lease', 'a');
        if (!lease) die('Cannot inspect operation lease');
        let available = lease.lock('xn'); lease.close();
        if (!available) continue;
        let pid = get(dir, 'pid'), phase = get(dir, 'phase');
        if (pid && alive(pid, get(dir, 'birth'))) continue;
        let started = get(dir, 'started');
        // Old empty locks get one startup grace period too. New owners publish
        // started before launching procd; workers claim under this same guard.
        if (!pid || phase == 'pending') {
            if (!match(started, /^[0-9]+$/) || int(started) > time()) { put(dir, 'started', time()); continue; }
            if (time() - int(started) <= 30) continue;
        }
        if (packagesBusy()) continue;
        put(dir, 'phase', 'recovering');
        result(kind, 'error', 'Операция прервана или не запустилась. Проверьте память, состояние службы и пакетов; повторите попытку.');
        if (kind == 'apply') put(RUN, 'error', 'Применение настроек прервано. Проверьте состояние службы и повторите операцию.');
        let work = get(dir, 'work');
        let expected = kind == 'update' ? /^\/tmp\/obhod-update\.[a-zA-Z0-9]+$/ :
            kind == 'core' ? /^\/tmp\/obhod-core\.[a-zA-Z0-9]+$/ : /^\/var\/run\/obhod\/diagnostics\.[a-zA-Z0-9]+$/;
        if (work && match(work, expected) && system('rm -rf -- ' + work) != 0)
            result(kind, 'error', 'Операция прервана. Не удалось очистить временные файлы; проверьте свободное место и состояние пакетов.');
        release(kind);
    }
}
let action = ARGV[0], kind = ARGV[1];
if (action == 'alive') exit(alive(kind, '') ? 0 : 1);
if (action == 'recover') { recover(); exit(0); }
if (index(kinds, kind) < 0) die('Invalid operation');
let dir = path(kind), token = ARGV[2], pid = ARGV[3];
if (action == 'acquire') {
    recover();
    if (lsdir(GLOBAL) != null || lsdir(dir) != null) exit(1);
    if (!mkdir(GLOBAL, 0700)) exit(1);
    if (kind != 'apply' && !mkdir(dir, 0700)) { rmdir(GLOBAL); exit(1); }
    token = trim(readfile('/proc/sys/kernel/random/uuid') || '') || sprintf('%s-%.9f', pid, clock(true)[0] + clock(true)[1] / 1e9);
    put(GLOBAL, 'started', time()); put(GLOBAL, 'kind', kind); put(GLOBAL, 'token', token);
    put(dir, 'started', time()); put(dir, 'token', token);
    put(dir, 'pid', pid); put(dir, 'birth', birth(pid).start);
    put(dir, 'phase', kind == 'apply' ? 'running' : 'pending');
    print(token, '\n'); exit(0);
}
if (!token || get(dir, 'token') != token || get(GLOBAL, 'token') != token) exit(1);
if (action == 'claim' || action == 'hold') {
    if (action == 'claim' && get(dir, 'phase') != 'pending') exit(1);
    let lease = fdopen(9, 'a');
    if (!lease || !lease.lock('xn')) exit(1);
    put(dir, 'pid', pid); put(dir, 'birth', birth(pid).start); put(dir, 'phase', 'running');
} else if (action == 'release') {
    result(kind, ARGV[4] || 'error', ARGV[5] || 'Операция прервана. Повторите попытку.');
    release(kind);
} else die('Invalid operation transition');
