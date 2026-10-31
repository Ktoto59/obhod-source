const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseProxyUri } = require('../shared/profile');
const { defaultRouterProfile, generateRouterConfig } = require('../openwrt/lib/config');
const binary = path.join(__dirname, '../windows/runtime/sing-box.exe');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => server.close(resolve));

test('router keeps a delayed domain on its proxy and leaves unrelated traffic direct', {
  skip: !fs.existsSync(binary), timeout: 20000
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-router-domain-'));
  const target = http.createServer((_request, response) => { response.writeHead(200); response.end('OK'); });
  const proxy = http.createServer();
  const sockets = new Set();
  let proxyConnections = 0;
  const targetPort = await listen(target);
  proxy.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  proxy.on('connect', (_request, client, head) => {
    proxyConnections++;
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.once('close', () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);
  async function request(port, host, delay) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let response = '', timer;
      socket.setTimeout(5000);
      socket.once('connect', () => { timer = setTimeout(() => socket.write(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`), delay); });
      socket.on('data', data => { response += data; });
      socket.once('end', () => resolve(response));
      socket.once('timeout', () => socket.destroy(new Error('Domain request timed out')));
      socket.once('error', reject);
      socket.once('close', () => clearTimeout(timer));
    });
  }
  async function exercise(timeout, expectedProxyCount) {
    const reservation = net.createServer(), port = await listen(reservation); await close(reservation);
    const profile = defaultRouterProfile();
    profile.tunnels = [parseProxyUri(`http://127.0.0.1:${proxyPort}#Test`)];
    profile.routing.activeTunnelId = profile.tunnels[0].id;
    profile.routing.localLists = [{ id: 'local', name: 'Selected', enabled: true, domains: ['selected.example'], cidrs: [] }];
    const config = generateRouterConfig(profile);
    config.log = { level: 'fatal' };
    config.experimental = {};
    config.inbounds = [{ type: 'direct', tag: 'ip-client', listen: '127.0.0.1', listen_port: port, override_address: '127.0.0.1', override_port: targetPort }];
    // Loopback substitutes for a public target in this local network fixture.
    // Private-address policy is covered by the generator tests independently.
    config.route.rules = config.route.rules.filter(rule => !rule.ip_is_private);
    if (timeout) config.route.rules.find(rule => rule.action === 'sniff').timeout = timeout;
    const filename = path.join(directory, 'router.json'); fs.writeFileSync(filename, JSON.stringify(config));
    const child = spawn(binary, ['run', '-c', filename], { windowsHide: true, stdio: 'ignore' });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 80 && !ready; attempt++) {
        ready = await new Promise(resolve => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
        if (!ready) await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.ok(ready, 'Core starts with the generated router routing rules');
      assert.match(await request(port, 'selected.example', 700), / 200 /);
      assert.equal(proxyConnections, expectedProxyCount);
      if (!timeout) {
        assert.match(await request(port, 'selected.example', 0), / 200 /);
        assert.equal(proxyConnections, expectedProxyCount + 1);
        assert.match(await request(port, '127.0.0.1', 0), / 200 /);
        assert.equal(proxyConnections, expectedProxyCount + 1, 'Unselected target stays direct');
      }
    } finally {
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    }
  }
  try {
    await exercise('300ms', 0); // Reproduce the old direct-route failure.
    await exercise(null, 1); // Use the unmodified router generator timeout.
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(proxy); await close(target);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
