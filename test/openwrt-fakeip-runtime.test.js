const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { parseProxyUri } = require('../shared/profile');
const { defaultRouterProfile, generateRouterConfig } = require('../openwrt/lib/config');
const binary = path.join(__dirname, '../windows/runtime/sing-box.exe');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function bind(socket) { socket.bind(0, '127.0.0.1'); await once(socket, 'listening'); return socket.address().port; }
async function reserve() { const s = net.createServer(), port = await listen(s); await new Promise(resolve => s.close(resolve)); return port; }
function reader(socket) {
  let buffer = Buffer.alloc(0), pending;
  socket.on('data', data => { buffer = Buffer.concat([buffer, data]); if (pending) pending(); });
  socket.on('error', () => {});
  return n => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending = null; reject(new Error('SOCKS fixture timed out')); }, 4000);
    pending = () => { if (buffer.length >= n) { clearTimeout(timer); const part = buffer.subarray(0, n); buffer = buffer.subarray(n); pending = null; resolve(part); } };
    pending();
  });
}
function address(ip, port) { const out = Buffer.from([1, ...ip.split('.').map(Number), 0, 0]); out.writeUInt16BE(port, 5); return out; }
async function socks(port, command, ip, targetPort) {
  const socket = net.connect(port, '127.0.0.1'), read = reader(socket);
  await once(socket, 'connect'); socket.write(Buffer.from([5, 1, 0])); assert.deepEqual([...await read(2)], [5, 0]);
  socket.write(Buffer.concat([Buffer.from([5, command, 0]), address(ip, targetPort)]));
  const reply = await read(10); assert.equal(reply[1], 0);
  return { socket, read, port: reply.readUInt16BE(8) };
}
function dnsPacket(name, type) {
  const header = Buffer.from([0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  const question = Buffer.concat([...name.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0, 0, type, 0, 1])]);
  return Buffer.concat([header, question]);
}
async function query(port, name, type = 1) {
  const socket = dgram.createSocket('udp4');
  try {
    socket.send(dnsPacket(name, type), port, '127.0.0.1');
    const [reply] = await Promise.race([once(socket, 'message'), pause(4000).then(() => { throw new Error('DNS timed out'); })]);
    assert.equal(reply.readUInt16BE(2) & 15, 0);
    return { count: reply.readUInt16BE(6), ip: [...reply.subarray(-4)].join('.') };
  } finally { socket.close(); }
}

test('FakeIP keeps TCP/UDP on the selected tunnel without SNI and preserves names across core restarts', {
  skip: !fs.existsSync(binary), timeout: 25000
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-fakeip-'));
  const sockets = new Set(), connections = [], udpDestinations = [];
  const target = http.createServer((_req, res) => res.end('OK'));
  const proxy = http.createServer();
  const dns = dgram.createSocket('udp4'), relay = dgram.createSocket('udp4');
  const assoc = net.createServer(async socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    try {
      const read = reader(socket); await read(3); socket.write(Buffer.from([5, 0]));
      const request = await read(10); assert.equal(request[1], 3);
      socket.write(Buffer.concat([Buffer.from([5, 0, 0]), address('127.0.0.1', relay.address().port)]));
    } catch (_) { socket.destroy(); }
  });
  relay.on('message', (data, remote) => {
    assert.equal(data[3], 3, 'Proxy receives the original domain, never a fake address');
    udpDestinations.push(data.subarray(5, 5 + data[4]).toString());
    relay.send(data, remote.port, remote.address);
  });
  dns.on('message', (data, remote) => {
    const header = Buffer.from(data.subarray(0, 12)); header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 6);
    const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]);
    dns.send(Buffer.concat([header, data.subarray(12), answer]), remote.port, remote.address);
  });
  let child, stderr = '', phase = 'start';
  const targetPort = await listen(target), proxyPort = await listen(proxy), udpPort = await listen(assoc);
  const dnsPort = await bind(dns); await bind(relay);
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('connect', (request, client) => {
    connections.push(request.url);
    const upstream = net.connect(targetPort, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); client.pipe(upstream).pipe(client); });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.once('close', () => upstream.destroy());
  });
  const port = await reserve(), dnsIn = await reserve();
  async function start(udp = false) {
    const profile = defaultRouterProfile();
    profile.tunnels = [parseProxyUri(`${udp ? 'socks5' : 'http'}://127.0.0.1:${udp ? udpPort : proxyPort}#Fixture`)];
    profile.routing.activeTunnelId = profile.tunnels[0].id;
    profile.routing.localLists = [{ id: 'test', name: 'Selected', enabled: true, domains: ['selected.example'], cidrs: [] }];
    const config = generateRouterConfig(profile, { dnsMode: 'fakeip' });
    config.inbounds = [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: port }, { type: 'direct', tag: 'dns-in', listen: '127.0.0.1', listen_port: dnsIn }];
    config.experimental = { cache_file: { ...config.experimental.cache_file, path: path.join(directory, 'cache.db') } };
    config.dns.servers = config.dns.servers.map(s => s.type === 'fakeip' ? s : { type: 'udp', tag: s.tag, server: '127.0.0.1', server_port: dnsPort });
    const filename = path.join(directory, 'config.json'); fs.writeFileSync(filename, JSON.stringify(config));
    stderr = ''; child = spawn(binary, ['run', '-c', filename], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', data => { stderr += data; });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(stderr);
      const ready = await new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
      if (ready) return;
      await pause(25);
    }
    throw new Error('Core failed to start: ' + stderr);
  }
  async function stop() { if (!child) return; const exited = once(child, 'exit'); child.kill(); await exited; child = null; }
  async function tcp(ip, host) {
    const { socket, read } = await socks(port, 1, ip, targetPort);
    try {
      socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      assert.match((await read(12)).toString(), /HTTP\/1.1 200/);
    } finally { socket.destroy(); }
  }
  try {
    await start();
    const fake = await query(dnsIn, 'selected.example'); assert.match(fake.ip, /^198\.(18|19)\./);
    assert.equal((await query(dnsIn, 'ordinary.example')).ip, '127.0.0.1');
    for (const type of [28, 64, 65]) assert.equal((await query(dnsIn, 'selected.example', type)).count, 0);
    phase = 'TCP FakeIP'; await tcp(fake.ip, 'unrelated.example');
    assert.equal(connections.at(-1), 'selected.example:' + targetPort, 'Restored DNS name wins over a different HTTP Host');
    phase = 'TCP ordinary'; await tcp('127.0.0.1', 'ordinary.example'); assert.equal(connections.length, 1, 'Ordinary traffic stays direct');
    await pause(1200); await stop(); await start();
    // No DNS query before this request: cached client addresses must keep working.
    phase = 'TCP after restart'; await tcp(fake.ip, 'unrelated.example'); assert.equal(connections.length, 2);
    assert.equal((await query(dnsIn, 'selected.example')).ip, fake.ip);
    await stop(); await start(true);
    phase = 'UDP'; const { socket, port: relayPort } = await socks(port, 3, '0.0.0.0', 0);
    const client = dgram.createSocket('udp4');
    try {
      client.send(Buffer.concat([Buffer.from([0, 0, 0]), address(fake.ip, 12345), Buffer.from('PING')]), relayPort, '127.0.0.1');
      const [response] = await Promise.race([once(client, 'message'), pause(4000).then(() => { throw new Error('UDP timed out: ' + stderr); })]);
      assert.equal(response.subarray(-4).toString(), 'PING');
      assert.deepEqual(udpDestinations, ['selected.example']);
    } finally { client.close(); socket.destroy(); }
  } catch (error) { throw new Error(phase + ': ' + error.message + '\n' + stderr, { cause: error }); } finally {
    await stop(); for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => target.close(r)), new Promise(r => assoc.close(r))]);
    dns.close(); relay.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
