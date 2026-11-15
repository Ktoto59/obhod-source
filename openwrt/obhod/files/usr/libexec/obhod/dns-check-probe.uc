// SPDX-License-Identifier: Apache-2.0
import * as socket from 'socket';
import { readfile } from 'fs';

function now() {
    let stamp = clock(true);
    return stamp[0] * 1000 + int(stamp[1] / 1000000);
}
function word(packet, offset) { return ord(packet, offset) * 256 + ord(packet, offset + 1); }

let tests = json(readfile(ARGV[0]));
let started = now(), watched = [], results = [];
for (let index, test in tests) {
    let id = index + 1;
    let packet = sprintf('%c%c', 0, id) + "\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03org\x00\x00\x01\x00\x01";
    let fd = socket.create(socket.AF_INET, socket.SOCK_DGRAM | socket.SOCK_NONBLOCK);
    let result = { kind: test.kind, number: test.number, ok: false };
    push(results, result);
    if (fd && fd.connect({ address: '127.0.0.1', port: test.port }) && fd.send(packet) == length(packet))
        push(watched, [fd, socket.POLLIN, index, id]);
    else if (fd) fd.close();
}
while (length(watched) && now() - started < 5000) {
    // The poll API replaces requested flags with returned events in each entry.
    for (let entry in watched) entry[1] = socket.POLLIN;
    for (let event in socket.poll(max(0, 5000 - (now() - started)), ...watched) || []) {
        if (!event[1]) continue;
        let fd = event[0], result = results[event[2]], packet = fd.recv(4096);
        if (length(packet || '') >= 12 && word(packet, 0) == event[3] && (ord(packet, 2) & 128)) {
            result.rcode = ord(packet, 3) & 15;
            result.ok = result.rcode == 0 && word(packet, 6) > 0;
            if (result.ok) result.ms = now() - started;
        }
        fd.close();
    }
    watched = filter(watched, index => index[0].fileno() >= 0);
}
for (let pending in watched) pending[0].close();
printf('%J\n', { ok: true, results });
