const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { parseProxyUri } = require('../shared/profile');
const { defaultRouterProfile, generateRouterConfig } = require('../openwrt/lib/config');
const binary = path.join(__dirname, '../windows/runtime/sing-box.exe');
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };

test('selected IP supports server-first TCP without the old sniff delay', { skip: !fs.existsSync(binary), timeout: 20000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-server-first-'));
  const target = net.createServer(socket => socket.end('HELLO'));
  const proxy = http.createServer(), sockets = new Set();
  const targetPort = await listen(target);
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('connect', (request, client) => {
    assert.equal(request.url, `192.0.2.55:${targetPort}`);
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  async function exercise(legacy) {
    const reservation = net.createServer(), port = await listen(reservation);
    await new Promise(resolve => reservation.close(resolve));
    const profile = defaultRouterProfile(); profile.tunnels = [parseProxyUri(`http://127.0.0.1:${proxyPort}`)];
    profile.routing.activeTunnelId = profile.tunnels[0].id;
    profile.routing.localLists = [{ id: 'ip', name: 'IP', enabled: true, domains: [], cidrs: ['192.0.2.0/24'] }];
    const config = generateRouterConfig(profile); config.experimental = {}; config.log = { level: 'fatal' };
    config.inbounds = [{ type: 'direct', tag: 'fixture', listen: '127.0.0.1', listen_port: port, override_address: '192.0.2.55', override_port: targetPort }];
    if (legacy) {
      const sniff = config.route.rules.findIndex(r => r.action === 'sniff');
      const ipRules = config.route.rules.slice(0, sniff).filter(r => r.ip_cidr || r.ip_is_private);
      config.route.rules = config.route.rules.filter((r, index) => index >= sniff || (!r.ip_cidr && !r.ip_is_private));
      // Reconstruct the old order explicitly: the current generator no longer
      // leaves redundant copies after sniff for this fixture to rely on.
      config.route.rules.push(...ipRules);
    }
    const file = path.join(directory, 'config.json'); fs.writeFileSync(file, JSON.stringify(config));
    let errors = '';
    const child = spawn(binary, ['run', '-c', file], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', data => { errors += data; });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 200 && !ready; attempt++) {
        assert.equal(child.exitCode, null, errors);
        ready = await new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
        if (!ready) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(ready, 'Core did not start: ' + errors);
      const started = Date.now(), socket = net.connect(port, '127.0.0.1'); socket.setTimeout(4000, () => socket.destroy(new Error('No server greeting')));
      try { const [data] = await once(socket, 'data'); assert.equal(data.toString(), 'HELLO'); return Date.now() - started; }
      finally { socket.destroy(); }
    } finally { const exited = once(child, 'exit'); child.kill(); await exited; }
  }
  try {
    const before = await exercise(true), after = await exercise(false);
    t.diagnostic(`Server greeting: old sniff path ${before} ms, explicit IP route ${after} ms`);
    assert.ok(before >= 800, `Old sniff path waits for data: ${before} ms`);
    assert.ok(after < 700, `CIDR route does not wait for sniffing: ${after} ms`);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve)); await new Promise(resolve => target.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
