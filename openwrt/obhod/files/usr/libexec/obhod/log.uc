// SPDX-License-Identifier: Apache-2.0
import { open, fdopen, readfile, writefile, rename } from 'fs';
let path = '/var/run/obhod/service.log';
let input = fdopen(0, 'r');
let output = open(path, 'a');
let size = length(readfile(path) || '');
for (let line; (line = input.read('line')) != null && length(line); ) {
    line = replace(line, /(vless|ss|trojan|hysteria2|hy2|tuic|anytls|socks5?|https?):\/\/[^[:space:]"'<>]+/gi, '[URL скрыт]');
    line = replace(line, /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '[ID скрыт]');
    line = replace(line, /(password|private_key|privatekey|token|secret|uuid)[[:space:]]*[:=][[:space:]]*[^[:space:],}]+/gi, '[секрет скрыт]');
    line = substr(trim(line), 0, 1024) + '\n';
    if (size + length(line) > 32768) {
        output.close();
        let tail = substr(readfile(path) || '', -16384);
        let newline = index(tail, '\n');
        if (newline >= 0) tail = substr(tail, newline + 1);
        writefile(path + '.tmp', tail); rename(path + '.tmp', path);
        size = length(tail); output = open(path, 'a');
    }
    output.write(line); output.flush(); size += length(line);
}
output.close(); input.close();
