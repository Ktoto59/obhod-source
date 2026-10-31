const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const binary = path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForPort(port, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const probe = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) reject(new Error(`Port ${port} did not open.`));
        else setTimeout(probe, 50);
      });
    };
    probe();
  });
}

function requestThroughProxy(proxyPort, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort });
    let response = '';
    socket.setTimeout(5000);
    socket.once('connect', () => socket.write(
      `GET http://127.0.0.1:${targetPort}/health HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`
    ));
    socket.on('data', (data) => { response += String(data); });
    socket.once('end', () => resolve(response));
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Proxy request timed out.')); });
    socket.once('error', reject);
  });
}

function selectedOutbound(controllerPort) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: controllerPort, path: '/proxies/proxy' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(body).now); } catch (error) { reject(error); }
      });
    });
    request.once('error', reject);
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('urltest switches to a healthy proxy and fails closed when both proxies stop', {
  skip: !fs.existsSync(binary), timeout: 25000
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-failover-runtime-'));
  const primaryPort = await freePort();
  const backupPort = await freePort();
  const groupPort = await freePort();
  const controllerPort = await freePort();
  const healthServer = http.createServer((_request, response) => { response.writeHead(204); response.end(); });
  await new Promise((resolve) => healthServer.listen(0, '127.0.0.1', resolve));
  const healthPort = healthServer.address().port;
  let primary;
  let backup;
  let group;
  try {
    const primaryConfig = {
      log: { level: 'error' },
      inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: primaryPort }],
      outbounds: [{ type: 'direct', tag: 'direct' }],
      route: { final: 'direct' }
    };
    const groupConfig = {
      log: { level: 'error' },
      experimental: { clash_api: { external_controller: `127.0.0.1:${controllerPort}` } },
      inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: groupPort }],
      outbounds: [
        { type: 'socks', tag: 'primary', server: '127.0.0.1', server_port: primaryPort },
        { type: 'socks', tag: 'backup', server: '127.0.0.1', server_port: backupPort },
        {
          type: 'urltest', tag: 'proxy', outbounds: ['primary', 'backup'],
          url: `http://127.0.0.1:${healthPort}/health`, interval: '1s', tolerance: 1000,
          idle_timeout: '1h', interrupt_exist_connections: false
        }
      ],
      route: { final: 'proxy' }
    };
    const primaryPath = path.join(directory, 'primary.json');
    const groupPath = path.join(directory, 'group.json');
    fs.writeFileSync(primaryPath, JSON.stringify(primaryConfig));
    fs.writeFileSync(groupPath, JSON.stringify(groupConfig));
    primary = spawn(binary, ['run', '-c', primaryPath], { windowsHide: true, stdio: 'ignore' });
    await waitForPort(primaryPort);
    const backupPath = path.join(directory, 'backup.json');
    fs.writeFileSync(backupPath, JSON.stringify({ ...primaryConfig,
      inbounds: [{ type: 'mixed', listen: '127.0.0.1', listen_port: backupPort }] }));
    backup = spawn(binary, ['run', '-c', backupPath], { windowsHide: true, stdio: 'ignore' });
    await waitForPort(backupPort);
    group = spawn(binary, ['run', '-c', groupPath], { windowsHide: true, stdio: 'ignore' });
    await waitForPort(groupPort);
    await waitForPort(controllerPort);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.match(await requestThroughProxy(groupPort, healthPort), / 204 /);
    assert.equal(await selectedOutbound(controllerPort), 'primary');

    await stopProcess(primary);
    primary = null;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.match(await requestThroughProxy(groupPort, healthPort), / 204 /);
    assert.equal(await selectedOutbound(controllerPort), 'backup');
    await stopProcess(backup);
    backup = null;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    let response = '';
    try { response = await requestThroughProxy(groupPort, healthPort); } catch {}
    assert.doesNotMatch(response, / 204 /, 'No direct fallback when all group members are unavailable');
  } finally {
    await stopProcess(group);
    await stopProcess(primary);
    await stopProcess(backup);
    await new Promise((resolve) => healthServer.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
