// SPDX-License-Identifier: Apache-2.0
// Bounded, loopback-only DNS pools. Encryption and egress stay in sing-box.
import * as socket from 'socket';
import { readfile } from 'fs';

let config = json(readfile(ARGV[0]) || '{}');
let filtering = config.mode == 'filtered-fakeip';
if (!match(config.mode || '', /^(fallback|parallel|balanced|filtered-fakeip)$/) ||
    type(config.port) != 'int' || index(filtering ? [1156] : [1153, 1154, 1155], config.port) < 0 || type(config.servers) != 'array' ||
    length(config.servers) < 2 || length(config.servers) > 4) die('Invalid DNS pool configuration');
let firstPort = config.port == 1153 ? 12053 : config.port == 1154 ? 12057 : 12061;
let bootstrap = config.port == 1155;
if (filtering) {
    if (length(config.servers) != 2 || type(config.servers[0]) != 'int' || type(config.servers[1]) != 'int' || config.servers[0] != 12065 || config.servers[1] != 12066) die('Invalid filtered FakeIP listeners');
}
else if (!bootstrap && length(filter(config.servers, p => type(p) != 'int' || p < firstPort || p > firstPort + 3))) die('DNS pool cannot cross routing groups');
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

const LIMIT = 64, TIMEOUT = 4000, NEGATIVE_WAIT = 200;
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
function nameEnd(data, offset) {
    let end = null, size = 0;
    for (let hops = 0; hops < 128 && offset < length(data); hops++) {
        let n = ord(data, offset++);
        if (!n) return end || offset;
        if ((n & 192) == 192) {
            if (offset >= length(data)) return null;
            end ||= offset + 1;
            let target = ((n & 63) << 8) | ord(data, offset);
            if (target >= offset - 1) return null;
            offset = target; continue;
        }
        if (n > 63 || offset + n > length(data) || (size += n + 1) > 254) return null;
        offset += n;
    }
    return null;
}
function validPacket(data, parsed) {
    let offset = parsed.end, count = word(data, 6) + word(data, 8) + word(data, 10);
    for (let i = 0; i < count; i++) {
        offset = nameEnd(data, offset);
        if (!offset || offset + 10 > length(data)) return false;
        let kind = word(data, offset), size = word(data, offset + 8);
        if ((kind == 1 && size != 4) || (kind == 28 && size != 16)) return false;
        let start = offset + 10, end = start + size;
        if (end > length(data)) return false;
        if (index([2, 5, 12, 39], kind) >= 0 && nameEnd(data, start) != end) return false;
        if (kind == 15 && (size < 3 || nameEnd(data, start + 2) != end)) return false;
        if (kind == 33 && (size < 7 || nameEnd(data, start + 6) != end)) return false;
        if (kind == 6) {
            let first = nameEnd(data, start), second = first ? nameEnd(data, first) : null;
            if (!second || second + 20 != end) return false;
        }
        offset = end;
    }
    return offset == length(data);
}
function nameKey(data, offset) {
    let key = '';
    for (let hops = 0; hops < 128; hops++) {
        let size = ord(data, offset++);
        if (!size) return lc(key);
        if ((size & 192) == 192) { offset = ((size & 63) << 8) | ord(data, offset); continue; }
        key += sprintf('%c', size) + substr(data, offset, size); offset += size;
    }
    return null;
}
function permitsFakeIp(q, packet, parsed) {
    let requested = word(q.packet, q.parsed.end - 4);
    // Truncated replies trigger the client's normal TCP retry. DNS errors and
    // non-address queries retain the provider's original response.
    if ((ord(packet, 2) & 2) || (ord(packet, 3) & 15) || word(q.packet, q.parsed.end - 2) != 1 || index([1, 28], requested) < 0) return false;
    let offset = parsed.end, answers = [], aliases = {}, total = word(packet, 6) + word(packet, 8) + word(packet, 10);
    for (let i = 0; i < total; i++) {
        let owner = nameKey(packet, offset);
        offset = nameEnd(packet, offset);
        let kind = word(packet, offset), cls = word(packet, offset + 2), size = word(packet, offset + 8), start = offset + 10;
        if (kind == 41 && ord(packet, offset + 4)) return false; // Extended RCODE.
        if (i < word(packet, 6) && cls == 1) {
            if (kind == 5) aliases[owner] = nameKey(packet, start);
            else if (kind == requested) push(answers, { owner, start });
        }
        offset = start + size;
    }
    let reachable = {}, owner = nameKey(q.packet, 12);
    for (let hops = 0; hops <= word(packet, 6) && owner != null && !reachable[owner]; hops++) {
        reachable[owner] = true; owner = aliases[owner];
    }
    let found = false;
    for (let answer in answers) {
        if (!reachable[answer.owner]) continue;
        found = true;
        let at = answer.start, nonzero = 0;
        if (requested == 1) {
            if (ord(packet, at) == 127) return false;
            for (let j = 0; j < 4; j++) nonzero |= ord(packet, at + j);
            if (!nonzero) return false;
        }
        else {
            for (let j = 0; j < 15; j++) nonzero |= ord(packet, at + j);
            if (!nonzero && ord(packet, at + 15) <= 1) return false;
        }
    }
    return found;
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
    push(sources, source);
}
function closeStream(stream) { if (!stream.closed) { stream.closed = true; stream.fd.close(); } }
// ucode binds functions in declaration order. closeClient and finish call each
// other; capture a declared local instead of an unresolved global function.
let finish;
function closeClient(client) {
    if (client.closed) return;
    client.closed = true; client.fd.close(); delete clients[client.id];
    for (let id in keys(pending)) if (pending[id]?.client == client) finish(pending[id], null);
}
finish = function(q, response) {
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
};
function attempt(q, index) {
    if (q.done || q.sent[index]) return;
    let source = sources[index], packet = bytes(q.id) + substr(q.packet, 2);
    q.sent[index] = now();
    if (config.mode == 'fallback') {
        q.current = index;
        q.attemptDeadline = q.sent[index] + TIMEOUT / length(sources);
    }
    if (!q.client) {
        // Dedicated connected sockets isolate clients even after the 16-bit ID
        // wraps. Closing a race also discards late replies from its losers.
        let fd = sourceSocket(source, socket.SOCK_DGRAM);
        if (!fd || !fd.connect({ address: source.address, port: source.port }) || fd.send(packet) != length(packet)) {
            if (fd) fd.close(); q.failed[index] = true; return;
        }
        push(streams, { fd, query: q, source: index, datagram: true, closed: false });
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
        if (config.mode == 'fallback') { best = index; break; }
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
    if (filtering) attempt(q, 0);
    else if (config.mode == 'fallback') next(q);
    else if (config.mode == 'parallel') for (let index, source in sources) attempt(q, index);
    else {
        // Occasionally retry other servers so a recovered resolver can rejoin.
        if ((++counter % 16) == 0) attempt(q, int(counter / 16) % length(sources));
        else next(q);
        q.next = now() + 350;
    }
}
function answer(index, packet, expected) {
    let q = length(packet) >= 12 ? pending[word(packet, 0)] : null;
    let parsed = length(packet) >= 12 ? question(packet) : null;
    if (!q || !(ord(packet, 2) & 128) || (expected && q != expected) || !q.sent[index] || q.failed[index] || !parsed || parsed.key != q.parsed.key || (ord(packet, 2) & 120) != (ord(q.packet, 2) & 120) || !validPacket(packet, parsed)) {
        if ((config.mode == 'fallback' || filtering) && expected && !expected.done) expected.failed[index] = true;
        return;
    }
    if (filtering) {
        if (index == 1 || !permitsFakeIp(q, packet, parsed)) { finish(q, packet); return; }
        q.realSucceeded = true; q.failed[0] = true;
        attempt(q, 1);
        return;
    }
    // A DNS result is authoritative for this exchange, including a filtering
    // result or SERVFAIL. Only transport/malformed failures try the next server.
    if (config.mode == 'fallback') { finish(q, packet); return; }
    let code = ord(packet, 3) & 15;
    let negative = code == 3 || (code == 0 && word(packet, 6) == 0);
    if (code != 0 || negative) {
        if (!q.fallback || negative || (!q.negativeUntil && code==5)) q.fallback=packet;
        // NXDOMAIN/NODATA are valid DNS results. Briefly prefer a contradicting
        // answer, but do not wait four seconds for an unresponsive resolver.
        if (negative && !q.negativeUntil) q.negativeUntil = now() + NEGATIVE_WAIT;
        q.failed[index] = true;
        if (code==2) sources[index].failures++; else sources[index].failures=0;
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
    for (let client in values(clients)) push(watched, [client.fd, socket.POLLIN | (length(client.output) ? socket.POLLOUT : 0), 'client', client]);
    for (let stream in streams) push(watched, [stream.fd, socket.POLLIN | (!stream.datagram && (!stream.connected || length(stream.output)) ? socket.POLLOUT : 0), stream.datagram ? 'datagram' : 'stream', stream]);
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
        else if (kind == 'datagram') {
            if (state.closed || state.query.done) continue;
            let packet = fd.recv(65535);
            if (packet != null) answer(state.source, packet, state.query);
            if (state.query.failed[state.source]) closeStream(state);
            if (!state.query.done && (event[1] & (socket.POLLERR | socket.POLLHUP | socket.POLLNVAL))) {
                state.query.failed[state.source] = true; sources[state.source].failures++; closeStream(state);
                if (config.mode == 'balanced') next(state.query);
            }
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
                    answer(state.source, substr(state.input, 2, word(state.input, 0)), state.query); closeStream(state);
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
        if (stamp >= q.deadline || (q.negativeUntil && stamp >= q.negativeUntil) || length(q.failed) == length(sources) || (filtering && q.failed[0] && !q.realSucceeded)) finish(q, q.fallback || failure(q.packet, q.parsed));
        else if (config.mode == 'fallback' && (q.failed[q.current] || stamp >= q.attemptDeadline)) {
            q.failed[q.current] = true;
            for (let stream in streams) if (stream.query == q && stream.source == q.current) closeStream(stream);
            next(q);
        }
        else if (config.mode == 'balanced' && stamp >= q.next) next(q);
    }
    for (let client in values(clients)) if (stamp >= client.deadline) closeClient(client);
}
