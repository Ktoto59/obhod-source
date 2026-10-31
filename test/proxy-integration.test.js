const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { SingBoxService } = require('../windows/src/main/sing-box-service');
const { generateConfig, tunnelTag } = require('../shared/config-generator');
const { DEFAULT_CONFIG } = require('../shared/profile');

const projectRoot = path.join(__dirname, '..');
const binary = path.join(projectRoot, 'windows/runtime', 'sing-box.exe');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function makeService() {
  const service = Object.create(SingBoxService.prototype);
  service.resourcesPath = projectRoot;
  service.appPath = projectRoot;
  service.lastError = null;
  return service;
}

async function requestThroughSingBox(connection, targetUrl) {
  const service = makeService();
  const listenPort = await service.findFreePort();
  const profile = structuredClone(DEFAULT_CONFIG);
  profile.tunnels = [connection];
  profile.routing.activeTunnelId = connection.id;
  profile.routing.trafficMode = 'local-proxy';
  profile.routing.listenPort = listenPort;
  profile.routing.presetIds = [];
  profile.routing.localLists = [];
  profile.routing.remoteLists = [];
  profile.routing.dnsResolverEnabled = false;
  const configuration = generateConfig(profile);
  configuration.route.rules = [];
  configuration.route.final = tunnelTag(connection);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-proxy-integration-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(configuration));
  const child = spawn(binary, ['run', '-c', configPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await service.waitUntilReady(child, listenPort);
    return await new Promise((resolve, reject) => {
      const request = http.get({
        host: '127.0.0.1', port: listenPort, path: targetUrl,
        headers: { Host: new URL(targetUrl).host }, timeout: 8000
      }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.once('timeout', () => request.destroy(new Error('Request timed out')));
      request.once('error', reject);
    });
  } finally {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function createHttpProxy(username, password) {
  const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const server = http.createServer((request, response) => {
    server.seen.push({ method: request.method, url: request.url, authorization: request.headers['proxy-authorization'] || '' });
    if (request.headers['proxy-authorization'] !== expected) {
      response.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="Obhod test"' });
      response.end();
      return;
    }
    const target = new URL(request.url);
    const upstream = http.request({
      host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`,
      method: request.method, headers: { ...request.headers, 'proxy-authorization': undefined }
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once('error', (error) => response.destroy(error));
    request.pipe(upstream);
  });
  server.on('connect', (request, client, head) => {
    server.seen.push({ method: 'CONNECT', url: request.url, authorization: request.headers['proxy-authorization'] || '' });
    if (request.headers['proxy-authorization'] !== expected) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Obhod test"\r\n\r\n');
      return;
    }
    const [host, portText] = request.url.split(':');
    const upstream = net.createConnection({ host, port: Number(portText) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.once('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
  });
  server.seen = [];
  return server;
}

function createSocks5Proxy(username, password) {
  return net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    let stage = 'greeting';
    const consume = () => {
      if (stage === 'greeting') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
        buffer = buffer.subarray(2 + buffer[1]);
        client.write(Buffer.from([5, 2]));
        stage = 'auth';
      }
      if (stage === 'auth') {
        if (buffer.length < 2) return;
        const userLength = buffer[1];
        if (buffer.length < 3 + userLength) return;
        const passwordLength = buffer[2 + userLength];
        if (buffer.length < 3 + userLength + passwordLength) return;
        const user = buffer.subarray(2, 2 + userLength).toString();
        const pass = buffer.subarray(3 + userLength, 3 + userLength + passwordLength).toString();
        buffer = buffer.subarray(3 + userLength + passwordLength);
        if (user !== username || pass !== password) {
          client.end(Buffer.from([1, 1]));
          return;
        }
        client.write(Buffer.from([1, 0]));
        stage = 'connect';
      }
      if (stage === 'connect') {
        if (buffer.length < 7) return;
        const addressType = buffer[3];
        let host;
        let offset;
        if (addressType === 1) {
          if (buffer.length < 10) return;
          host = [...buffer.subarray(4, 8)].join('.');
          offset = 8;
        } else if (addressType === 3) {
          const length = buffer[4];
          if (buffer.length < 7 + length) return;
          host = buffer.subarray(5, 5 + length).toString();
          offset = 5 + length;
        } else {
          client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = buffer.readUInt16BE(offset);
        const trailing = buffer.subarray(offset + 2);
        stage = 'stream';
        const upstream = net.createConnection({ host, port }, () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (trailing.length) upstream.write(trailing);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.once('error', () => client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])));
      }
    };
    client.on('data', (chunk) => {
      if (stage === 'stream') return;
      buffer = Buffer.concat([buffer, chunk]);
      consume();
    });
  });
}

test('performs real requests through authenticated HTTP and SOCKS5 proxies', {
  skip: !fs.existsSync(binary),
  timeout: 30000
}, async () => {
  const target = http.createServer((request, response) => {
    response.writeHead(204);
    response.end();
  });
  const httpProxy = createHttpProxy('alice', 'http-secret');
  const socksProxy = createSocks5Proxy('bob', 'socks-secret');
  const targetPort = await listen(target);
  const httpPort = await listen(httpProxy);
  const socksPort = await listen(socksProxy);
  try {
    const targetUrl = `http://127.0.0.1:${targetPort}/health`;
    const httpStatus = await requestThroughSingBox({
      id: 'http-auth', type: 'http', name: 'HTTP auth', server: '127.0.0.1',
      serverPort: httpPort, username: 'alice', password: 'http-secret'
    }, targetUrl);
    const socksStatus = await requestThroughSingBox({
      id: 'socks-auth', type: 'socks5', name: 'SOCKS auth', server: '127.0.0.1',
      serverPort: socksPort, username: 'bob', password: 'socks-secret'
    }, targetUrl);
    assert.equal(httpStatus, 204);
    assert.equal(socksStatus, 204);
    assert.equal(httpProxy.seen[0].authorization, `Basic ${Buffer.from('alice:http-secret').toString('base64')}`);
    await assert.rejects(makeService().probeTunnel({
      id: 'http-wrong-auth', type: 'http', name: 'Wrong auth', server: '127.0.0.1',
      serverPort: httpPort, username: 'alice', password: 'wrong-password'
    }), /имя пользователя и пароль/i);
  } finally {
    await Promise.all([close(target), close(httpProxy), close(socksProxy)]);
  }
});
