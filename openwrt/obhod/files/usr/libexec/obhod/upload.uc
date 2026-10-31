// SPDX-License-Identifier: Apache-2.0
import { readfile, writefile, open, lsdir, mkdir, unlink, rmdir } from 'fs';
let run = '/var/run/obhod', request = json(readfile(ARGV[0]));
function remove(path) { unlink(path + '/data'); unlink(path + '/meta'); rmdir(path); }
function fail(message) { printf('%J\n', { ok: false, error: message }); exit(0); }
if (request.action == 'begin') {
    let count = 0;
    for (let name in lsdir(run) || []) {
        if (!match(name, /^upload-[a-f0-9-]{36}$/)) continue;
        let path = run + '/' + name, meta = json(readfile(path + '/meta') || '{}');
        if (!meta.updatedAt || time() - meta.updatedAt > 600) remove(path);
        else count++;
    }
    if (count >= 2) fail('Уже загружаются два профиля. Повторите через несколько минут.');
    let token = trim(readfile('/proc/sys/kernel/random/uuid') || '');
    if (!match(token, /^[a-f0-9-]{36}$/)) fail('Не удалось создать загрузку.');
    let path = run + '/upload-' + token;
    if (!mkdir(path, 0700)) fail('Не удалось создать загрузку.');
    writefile(path + '/data', ''); writefile(path + '/meta', sprintf('%J', { next: 0, bytes: 0, updatedAt: time() }));
    printf('%J\n', { ok: true, upload: token, next: 0 }); exit(0);
}
if (!match(request.upload || '', /^[a-f0-9-]{36}$/)) fail('Недопустимая загрузка.');
let path = run + '/upload-' + request.upload;
if (request.action == 'discard') { remove(path); print('{"ok":true}\n'); exit(0); }
let meta = json(readfile(path + '/meta') || '{}');
if (request.action != 'chunk' || !meta.updatedAt || time() - meta.updatedAt > 600) fail('Загрузка истекла. Сохраните настройки ещё раз.');
if (request.index != meta.next || type(request.data) != 'string' || length(request.data) > 16384 || !match(request.data, /^[A-Za-z0-9+\/=]+$/)) fail('Нарушен порядок загрузки профиля.');
let data = b64dec(request.data);
if (!length(data) || length(data) > 12288 || meta.bytes + length(data) > 196608) fail('Профиль превышает допустимый размер 192 КБ.');
let output = open(path + '/data', 'a');
if (!output || output.write(data) != length(data)) fail('Не удалось записать профиль.');
output.close();
meta.next++; meta.bytes += length(data); meta.updatedAt = time();
writefile(path + '/meta', sprintf('%J', meta));
printf('%J\n', { ok: true, next: meta.next });
