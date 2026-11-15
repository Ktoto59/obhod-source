// SPDX-License-Identifier: Apache-2.0
import { readfile, lsdir } from 'fs';
let mode = ARGV[0];
if (mode == 'interfaces') {
    let network = json(readfile(ARGV[1]) || '{}'), devices = [];
    for (let name in lsdir('/sys/class/net') || []) {
        if (name == 'lo' || name == 'obhod-tun' || !match(name, /^[a-zA-Z0-9_.-]{1,15}$/)) continue;
        let labels = [], addresses = [];
        for (let iface in network.interface || []) {
            if (iface.device != name && iface.l3_device != name) continue;
            push(labels, iface.interface);
            for (let address in iface['ipv4-address'] || []) push(addresses, address.address);
        }
        push(devices, { name, label: (length(labels) ? join(', ', labels) + ' · ' : '') + name + (length(addresses) ? ' · ' + join(', ', addresses) : ''), up: trim(readfile('/sys/class/net/' + name + '/operstate') || '') == 'up' });
    }
    printf('%J\n', { devices });
    exit(0);
}
let settings = json(readfile('/etc/obhod/settings.json'));
let routing = settings.profile.routing;
let tag = 'tunnel-' + replace(routing.activeTunnelId || '', /[^a-z0-9_-]/gi, '_');
let proxies = json(readfile(ARGV[1]) || '{}').proxies || {};
if (routing.failoverEnabled) tag = proxies.proxy?.now || '';
if (!match(tag, /^tunnel-[a-zA-Z0-9_-]+$/)) tag = '';
if (mode == 'tag') { if (!routing.failoverEnabled || ARGV[2] == 'diagnose') print(tag); exit(0); }
let delay = json(readfile(ARGV[2]) || '{}').delay;
let explicit = ARGV[3] == 'diagnose', active = explicit || ARGV[3] == 'active';
let startedFor = ARGV[5], probeAt = int(ARGV[4] || 0);
function validDelay(value) { return type(value) == 'int' && value > 0 && value < 60000; }
// Clash serializes URLTestHistory.Time as RFC3339, including fractional seconds
// and local UTC offsets. Interpret the sample independently of the router's TZ.
function historyTime(value) {
    let parts = match(value || '', /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$/);
    if (!parts) return null;
    let stamp = timegm({ year: int(parts[1]), mon: int(parts[2]), mday: int(parts[3]),
        hour: int(parts[4]), min: int(parts[5]), sec: int(parts[6]) });
    if (parts[8] != 'Z') {
        let offset = int(substr(parts[8], 1, 2)) * 3600 + int(substr(parts[8], 4, 2)) * 60;
        stamp -= substr(parts[8], 0, 1) == '+' ? offset : -offset;
    }
    return stamp > 0 ? stamp : null;
}
let receivedAt = time();
let oldSamples = json(readfile('/var/run/obhod/telemetry.json') || '{}').samples || {};
let samples = {}, selected, historyUnavailable = false, probeOk = false;
for (let tunnel in settings.profile.tunnels) {
    let key = 'tunnel-' + replace(tunnel.id, /[^a-z0-9_-]/gi, '_');
    let proxy = proxies[key], history = proxy?.history || [];
    let latest = length(history) ? history[length(history) - 1] : null;
    let stamp = historyTime(latest?.time);
    let sample = oldSamples[key] || {};
    if (stamp != null && stamp > (sample.checkedAt || 0) && stamp > (sample.failedAt || 0)) {
        if (validDelay(latest.delay)) sample = { delay: latest.delay, checkedAt: stamp };
        else sample.failedAt = stamp;
    }
    if (key == tag) {
        selected = tunnel;
        if (active && key == startedFor && probeAt > 0) {
            probeOk = validDelay(delay);
            if (probeOk) sample = { delay, checkedAt: probeAt };
            else sample.failedAt = probeAt;
        }
        // A failed probe or connection can remove urltest history. The API
        // doesn't expose why it was removed or when, so report only its absence.
        historyUnavailable = !active && !!proxy && !latest && !!sample.checkedAt;
    }
    if (sample.checkedAt || sample.failedAt) samples[key] = sample;
}
let sample = samples[tag] || {};
let interval = match(routing.failoverInterval || '15s', /^([0-9]+)(s|m|h)$/);
let maxAge = !routing.failoverEnabled || active ? 90 : interval ? int(interval[1]) * (interval[2] == 'h' ? 3600 : interval[2] == 'm' ? 60 : 1) : 15;
let route = { name: selected?.name || '', tag, delay: sample.delay,
    checkedAt: sample.checkedAt, receivedAt, diagnosedAt: explicit && startedFor == tag && probeAt > 0 ? probeAt : null,
    failedAt: sample.failedAt, historyUnavailable, maxAge, probeOk };
printf('%J\n', { route, samples });
