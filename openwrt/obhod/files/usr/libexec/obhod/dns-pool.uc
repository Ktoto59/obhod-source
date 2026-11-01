// SPDX-License-Identifier: Apache-2.0
// Bounded, loopback-only DNS race. Encryption and egress stay in sing-box.
import * as socket from 'socket';
import { readfile } from 'fs';

let config = json(readfile(ARGV[0]) || '{}');
if (!match(config.mode || '', /^(parallel|balanced)$/) ||
    type(config.port) != 'int' || index([1153, 1154, 1155], config.port) < 0 || type(config.servers) != 'array' ||
    length(config.servers) < 2 || length(config.servers) > 4) die('Invalid DNS pool configuration');
let firstPort = config.port == 1153 ? 12053 : config.port == 1154 ? 12057 : 12061;
let bootstrap = config.port == 1155;
if (!bootstrap && length(filter(config.servers, p => type(p) != 'int' || p < firstPort || p > firstPort + 3))) die('DNS pool cannot cross routing groups');
if (bootstrap) {
    if (type(config.mark) != 'int' || config.mark < 1 || config.mark > 2147483647) die('Invalid DNS bypass mark');
    for (let server in config.servers) {
        if (type(server.port) != 'int' || server.port < 1 || server.port > 65535 ||
            !((match(server.address || '', /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/)) || match(server.address || '', /^[0-9a-fA-F]*:[0-9a-fA-F:]+$/))) die('Bootstrap accepts only IP addresses');
        if (!length(socket.addrinfo(server.address, null, { flags: socket.AI_NUMERICHOST, socktype: socket.SOCK_DGRAM }))) die('Invalid bootstrap IP');
        if (index([1153,1154,1155],server.port)>=0 || (server.port>=12053&&server.port<=12064) || (server.port==53 && (match(server.address,/^127\./)||server.address=='::1'))) die('Bootstrap cannot point back to the DNS pool');
    }
}
if (ARGV[1] == '--check') exit(0);

const LIMIT = 64, TIMEOUT = 4000;
let pending = {}, clients = {}, streams = [], sources = [];
let sequence = 0, counter = 0, clientSequence = 0;
function now() { let c = clock(true); return c[0] * 1000.0 + c[1] / 1000000.0; }
function word(s, offset) { return ord(s, offset) * 256 + ord(s, offset + 1); }
function bytes(n) { return sprintf('%c%c', (n >> 8) & 255, n & 255); }
function question(data) {
    if (length(data) < 17 || word(data, 4) != 1) return null;
    let offset = 12;
    while (offset < length(data)) {
        let size = ord(data, offset++);
        if (!size) break;
        if (size > 63 || offset + size > length(data) || offset + size > 267) return null;
        offset += size;
    }
    if (offset + 4 > length(data)) return null;
    return { key: lc(substr(data, 12, offset - 12)) + substr(data, offset, 4), end: offset + 4 };
}
function failure(packet, q) {
    return substr(packet, 0, 2) + sprintf('%c%c', 128 | (ord(packet, 2) & 121), 130 | (ord(packet, 3) & 16)) + bytes(1) + bytes(0) + bytes(0) + bytes(0) + substr(packet, 12, q.end - 12);
}
function listener(kind) {
    let fd = socket.create(socket.AF_INET, kind | socket.SOCK_NONBLOCK);
    if (!fd || !fd.setopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1) ||
        !fd.bind({ address: '127.0.0.1', port: config.port }) || (kind == socket.SOCK_STREAM && !fd.listen(16))) die('Cannot bind DNS pool listener');
    return fd;
}
let udp = listener(socket.SOCK_DGRAM), tcp = listener(socket.SOCK_STREAM);
function sourceSocket(source, kind) {
    let family = index(source.address, ':') >= 0 ? socket.AF_INET6 : socket.AF_INET;
    let fd = socket.create(family, kind | socket.SOCK_NONBLOCK);
    if (fd && bootstrap && !fd.setopt(socket.SOL_SOCKET, socket.SO_MARK, config.mark)) { fd.close(); return null; }
    return fd;
}
for (let server in config.servers) {
    let source = { address: bootstrap ? server.address : '127.0.0.1', port: bootstrap ? server.port : server, score: 250, failures: 0 };
    source.fd = sourceSocket(source, socket.SOCK_DGRAM);
    if (source.fd) source.connected = !!source.fd.connect({ address: source.address, port: source.port });
    push(sources, source);
}
function closeStream(stream) { if (!stream.closed) { stream.closed = true; stream.fd.close(); } }
function closeClient(client) {
    if (client.closed) return;
    client.closed = true; client.fd.close(); delete clients[client.id];
    for (let id in keys(pending)) if (pending[id]?.client == client) finish(pending[id], null);
}
function finish(q, response) {
    if (q.done) return;
    q.done = true; delete pending[q.id];
    for (let stream in streams) if (stream.query == q) closeStream(stream);
    if (!response) return;
    response = substr(q.packet, 0, 2) + substr(response, 2);
    if (!q.client) { udp.send(response, 0, q.address); return; }
    if (q.client.closed) return;
    q.client.active--;
    let frame = bytes(length(response)) + response;
    if (length(q.client.output) + length(frame) > 262148) { closeClient(q.client); return; }
    q.client.output += frame;
}
function attempt(q, index) {
    if (q.done || q.sent[index]) return;
    let source = sources[index], packet = bytes(q.id) + substr(q.packet, 2);
    q.sent[index] = now();
    if (!q.client) {
        if (!source.fd) source.fd = sourceSocket(source, socket.SOCK_DGRAM);
        if (source.fd && !source.connected) source.connected = !!source.fd.connect({ address: source.address, port: source.port });
        if (!source.connected || source.fd.send(packet) != length(packet)) q.failed[index] = true;
        return;
    }
    let fd = sourceSocket(source, socket.SOCK_STREAM);
    if (!fd) { q.failed[index] = true; return; }
    let connected = fd.connect({ address: source.address, port: source.port });
    if (!connected && fd.error(true) != 115) { fd.close(); q.failed[index] = true; return; }
    push(streams, { fd, query: q, source: index, connected: !!connected, input: '', output: bytes(length(packet)) + packet });
}
function next(q) {
    let best = -1, score = 1e30;
    for (let index, source in sources) {
        if (q.sent[index]) continue;
        let value = source.score + source.failures * 1000;
        if (value < score) { best = index; score = value; }
    }
    if (best >= 0) attempt(q, best);
    q.next = now() + 350;
}
function submit(packet, address, client) {
    let parsed = question(packet);
    if (!parsed || length(packet) > 4096 || (ord(packet, 2) & 248)) return;
    if (length(pending) >= LIMIT) {
        if (client) closeClient(client); else udp.send(failure(packet, parsed), 0, address);
        return;
    }
    sequence = (sequence + 1) & 65535;
    while (pending[sequence]) sequence = (sequence + 1) & 65535;
    let q = { id: sequence, packet, parsed, address, client, sent: {}, failed: {}, done: false, deadline: now() + TIMEOUT };
    pending[q.id] = q;
    if (client) client.active++;
    if (config.mode == 'parallel') for (let index, source in sources) attempt(q, index);
    else {
        // Occasionally retry other servers so a recovered resolver can rejoin.
        if ((++counter % 16) == 0) attempt(q, int(counter / 16) % length(sources));
        else next(q);
        q.next = now() + 350;
    }
}
function answer(index, packet) {
    if (length(packet) < 12 || !(ord(packet, 2) & 128)) return;
    let q = pending[word(packet, 0)], parsed = question(packet);
    if (!q || !q.sent[index] || q.failed[index] || !parsed || parsed.key != q.parsed.key || (ord(packet, 2) & 120) != (ord(q.packet, 2) & 120)) return;
    let code = ord(packet, 3) & 15;
    if (code != 0 && code != 3) {
        q.failed[index] = true; sources[index].failures++;
        if (config.mode == 'balanced') next(q);
        return;
    }
    let elapsed = now() - q.sent[index];
    sources[index].score = sources[index].score * 0.7 + elapsed * 0.3;
    sources[index].failures = 0;
    finish(q, packet);
}
while (true) {
    streams = filter(streams, s => !s.closed && !s.query.done);
    let watched = [[udp, socket.POLLIN, 'udp'], [tcp, socket.POLLIN, 'accept']];
    for (let index, source in sources) if (source.fd) push(watched, [source.fd, socket.POLLIN, 'source', index]);
    for (let client in values(clients)) push(watched, [client.fd, socket.POLLIN | (length(client.output) ? socket.POLLOUT : 0), 'client', client]);
    for (let stream in streams) push(watched, [stream.fd, socket.POLLIN | ((!stream.connected || length(stream.output)) ? socket.POLLOUT : 0), 'stream', stream]);
    let events = socket.poll(100, ...watched);
    if (events == null) continue;
    for (let event in events) {
        if (!event[1]) continue;
        let fd = event[0], kind = event[2], state = event[3];
        if (fd.fileno() < 0) continue;
        if (kind == 'udp') {
            let address = {}, packet = fd.recv(4097, 0, address);
            if (packet != null) submit(packet, address, null);
        }
        else if (kind == 'source') {
            let packet = fd.recv(65535);
            if (packet != null) answer(state, packet);
        }
        else if (kind == 'accept') {
            let peer = fd.accept({}, socket.SOCK_NONBLOCK);
            if (!peer) continue;
            if (length(clients) >= 16) { peer.close(); continue; }
            let client = { id: ++clientSequence, fd: peer, input: '', output: '', active: 0, deadline: now() + 10000, closed: false };
            clients[client.id] = client;
        }
        else if (kind == 'client') {
            if (state.closed) continue;
            if (event[1] & socket.POLLIN) {
                let data = fd.recv(8194);
                if (data != null && !length(data)) { closeClient(state); continue; }
                if (data != null) { state.input += data; state.deadline = now() + 10000; }
                if (length(state.input) > 16388) { closeClient(state); continue; }
                while (!state.closed && length(state.input) >= 2) {
                    let size = word(state.input, 0);
                    if (size > 4096 || size < 17 || state.active >= 4) { closeClient(state); break; }
                    if (length(state.input) < size + 2) break;
                    let packet = substr(state.input, 2, size); state.input = substr(state.input, size + 2);
                    submit(packet, null, state);
                }
            }
            if (!state.closed && (event[1] & socket.POLLOUT) && length(state.output)) {
                let sent = fd.send(state.output, socket.MSG_NOSIGNAL);
                if (sent != null) state.output = substr(state.output, sent);
                else if (fd.error(true) != 11) closeClient(state);
            }
            if (event[1] & (socket.POLLERR | socket.POLLHUP | socket.POLLNVAL)) closeClient(state);
        }
        else if (kind == 'stream') {
            if (state.closed || state.query.done) continue;
            let failed = false;
            if (!state.connected && (event[1] & socket.POLLOUT)) {
                if (fd.getopt(socket.SOL_SOCKET, socket.SO_ERROR)) failed = true;
                else state.connected = true;
            }
            if (!failed && state.connected && (event[1] & socket.POLLOUT) && length(state.output)) {
                let sent = fd.send(state.output, socket.MSG_NOSIGNAL);
                if (sent != null) state.output = substr(state.output, sent);
                else if (fd.error(true) != 11) failed = true;
            }
            if (!failed && (event[1] & socket.POLLIN)) {
                let data = fd.recv(65537);
                if (data != null && !length(data)) failed = true;
                else if (data != null) state.input += data;
                if (length(state.input) > 65537) failed = true;
                if (!failed && length(state.input) >= 2 && length(state.input) >= word(state.input, 0) + 2) {
                    answer(state.source, substr(state.input, 2, word(state.input, 0))); closeStream(state);
                }
            }
            if (!state.query.done && (failed || (event[1] & (socket.POLLERR | socket.POLLHUP | socket.POLLNVAL)))) {
                state.query.failed[state.source] = true; sources[state.source].failures++; closeStream(state);
                if (config.mode == 'balanced') next(state.query);
            }
        }
    }
    let stamp = now();
    for (let id in keys(pending)) {
        let q = pending[id];
        if (!q) continue;
        if (stamp >= q.deadline || length(q.failed) == length(sources)) finish(q, failure(q.packet, q.parsed));
        else if (config.mode == 'balanced' && stamp >= q.next) next(q);
    }
    for (let client in values(clients)) if (stamp >= client.deadline) closeClient(client);
}
