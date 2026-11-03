const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { generateConfig } = require('../shared/config-generator');
const { parseProxyUri, parseWireGuardConfig } = require('../shared/profile');
const binary = process.env.OBHOD_TEST_CORE || path.join(__dirname, '../windows/runtime/sing-box.exe');
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const close = server => new Promise(resolve => server.close(resolve));
async function freePort() { const server = net.createServer(); const port = await listen(server); await close(server); return port; }
async function waitFor(check) {
  const deadline = Date.now() + 6000;
  do { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 40)); } while (Date.now() < deadline);
  throw new Error('Core did not reach the expected failover state');
}
function selected(port) {
  return new Promise(resolve => {
    http.get(`http://127.0.0.1:${port}/proxies/proxy`, response => {
      let body = ''; response.on('data', data => { body += data; });
      response.on('end', () => { try { resolve(JSON.parse(body).now); } catch { resolve(''); } });
    }).on('error', () => resolve(''));
  });
}
function dnsQuery(port, id) {
  const packet = Buffer.concat([Buffer.from([id >> 8, id & 255, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]), Buffer.from('\x08selected\x07example\0\0\x01\0\x01', 'binary')]);
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1'); let response = Buffer.alloc(0);
    socket.setTimeout(3000, () => socket.destroy(new Error('DNS timed out')));
    socket.on('error', reject);
    socket.once('close', () => resolve(null));
    socket.once('connect', () => { const size = Buffer.alloc(2); size.writeUInt16BE(packet.length); socket.write(Buffer.concat([size, packet])); });
    socket.on('data', data => {
      response = Buffer.concat([response, data]);
      if (response.length < 2 || response.length < response.readUInt16BE(0) + 2) return;
      socket.destroy(); const answer = response.subarray(2);
      assert.equal(answer.readUInt16BE(0), id);
      resolve(answer[3] & 15 ? null : [...answer.subarray(-4)].join('.'));
    });
  });
}

test('generated failover DNS survives a failed primary and switching TCP-only HTTP tunnels', { skip: !fs.existsSync(binary), timeout: 20000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-failover-dns-'));
  const sockets = new Set(), track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const dns = net.createServer(socket => {
    track(socket); let input = Buffer.alloc(0);
    socket.on('data', data => {
      input = Buffer.concat([input, data]);
      if (input.length < 2 || input.length < input.readUInt16BE(0) + 2) return;
      const packet = Buffer.from(input.subarray(2)); packet.writeUInt16BE(0x8180, 2); packet.writeUInt16BE(1, 6);
      const answer = Buffer.concat([packet, Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 203, 0, 113, 42])]);
      const size = Buffer.alloc(2); size.writeUInt16BE(answer.length); socket.end(Buffer.concat([size, answer]));
    });
  });
  const dnsPort = await listen(dns);
  const health = http.createServer((_request, response) => { response.writeHead(204); response.end(); });
  const healthPort = await listen(health);
  const counts = [0, 0], proxySockets = [new Set(), new Set()];
  let backupReady = false;
  const proxies = [0, 1].map(index => {
    const proxy = http.createServer();
    proxy.on('connection', socket => { track(socket); proxySockets[index].add(socket); socket.once('close', () => proxySockets[index].delete(socket)); });
    proxy.on('connect', (request, client, head) => {
      if (index === 1 && !backupReady) { client.destroy(); return; }
      // Stand in for public DNS inside the local fixture. A direct fallback has
      // no such mapping, and private WireGuard DNS is never contacted.
      const dnsRequest = request.url === '8.8.8.8:53';
      assert.ok(dnsRequest || request.url === `127.0.0.1:${healthPort}`, request.url);
      if (dnsRequest) counts[index]++;
      const upstream = net.connect(dnsRequest ? dnsPort : healthPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      track(upstream); upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.once('close', () => upstream.destroy());
    });
    return proxy;
  });
  const ports = await Promise.all(proxies.map(listen));
  let core;
  try {
    const a = parseWireGuardConfig('[Interface]\nPrivateKey = AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=\nAddress = 10.8.0.2/32\nDNS = 10.8.0.1\n[Peer]\nPublicKey = AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=\nEndpoint = 192.0.2.1:51820\nAllowedIPs = 0.0.0.0/0');
    const members = ports.map((port, i) => parseProxyUri(`http://127.0.0.1:${port}#${i}`));
    const controller = await freePort(), port = await freePort();
    const config = generateConfig({ tunnels:[a, ...members], routing:{ activeTunnelId:a.id, failoverEnabled:true,
      failoverTunnelIds:members.map(m => m.id), dnsResolverEnabled:false, controllerPort:controller,
      testUrl:`http://127.0.0.1:${healthPort}/health`, presetIds:[], localLists:[] } });
    assert.deepEqual(config.dns.servers.find(s => s.tag === 'proxy-dns'), {tag:'proxy-dns', type:'tcp', server:'8.8.8.8', detour:'proxy'});
    assert.equal(config.endpoints.length, 0, 'Unreachable WireGuard primary is outside the group');
    config.outbounds.find(o => o.tag === 'proxy').interval = '1s';
    config.inbounds = [{type:'direct', tag:'dns-test', listen:'127.0.0.1', listen_port:port}];
    config.route.rules.unshift({inbound:['dns-test'], action:'hijack-dns'});
    config.dns.rules.unshift({inbound:['dns-test'], action:'route', server:'proxy-dns', disable_cache:true});
    const file = path.join(directory, 'config.json'); fs.writeFileSync(file, JSON.stringify(config));
    core = spawn(binary, ['run', '-c', file], {windowsHide:true, stdio:'ignore'});
    await waitFor(async () => await selected(controller) === `tunnel-${members[0].id}`);
    assert.equal(await dnsQuery(port, 0x4242), '203.0.113.42'); assert.ok(counts[0] > 0);
    backupReady = true;
    const closedFirst = close(proxies[0]);
    for (const socket of proxySockets[0]) socket.destroy();
    await closedFirst;
    await waitFor(async () => await selected(controller) === `tunnel-${members[1].id}`);
    assert.equal(await dnsQuery(port, 0x4243), '203.0.113.42'); assert.ok(counts[1] > 0);
    const closedBackup = close(proxies[1]);
    for (const socket of proxySockets[1]) socket.destroy();
    await closedBackup;
    let answer = null; try { answer = await dnsQuery(port, 0x4244); } catch {}
    assert.equal(answer, null, 'All failed tunnels must not send DNS directly');
  } finally {
    if (core && core.exitCode === null && core.signalCode === null) { const exited = once(core, 'exit'); core.kill(); await exited; }
    for (const socket of sockets) socket.destroy();
    for (const proxy of proxies) if (proxy.listening) await close(proxy);
    await close(dns); await close(health); fs.rmSync(directory, {recursive:true, force:true});
  }
});
