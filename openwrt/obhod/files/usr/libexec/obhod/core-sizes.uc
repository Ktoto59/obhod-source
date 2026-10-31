// SPDX-License-Identifier: Apache-2.0
import { readfile } from 'fs';
let text = readfile(ARGV[1]) || '', rows = [], sizes = {};
if (ARGV[0] == 'apk') {
    let data;
    try { data = json(text); } catch (_) { data = []; }
    rows = type(data) == 'array' ? data : (data?.packages || []);
} else {
    for (let record in split(text, /\n\s*\n/)) {
        let row = {};
        for (let line in split(record, '\n')) {
            let pair = match(line, /^([^:]+):\s*(.*)$/);
            if (!pair) continue;
            if (pair[1] == 'Package') row.name = pair[2];
            if (pair[1] == 'Version') row.version = pair[2];
            if (pair[1] == 'Size') row['file-size'] = int(pair[2]);
            if (pair[1] == 'Installed-Size') row['installed-size'] = int(pair[2]);
        }
        push(rows, row);
    }
}
for (let row in rows) {
    let key = row.name == 'sing-box-tiny' ? 'lite' : row.name == 'sing-box' ? 'full' : null;
    if (!key || type(row['installed-size']) != 'int' || type(row['file-size']) != 'int'
        || row['installed-size'] <= 0 || row['file-size'] <= 0) continue;
    // Multiple signed feeds may contain the same package. Show a conservative size.
    if (sizes[key] && sizes[key].installedBytes >= row['installed-size']) continue;
    sizes[key] = { version: row.version, downloadBytes: row['file-size'], installedBytes: row['installed-size'] };
}
printf('%J\n', sizes);
