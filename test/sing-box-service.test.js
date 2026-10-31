const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { SingBoxService } = require('../windows/src/main/sing-box-service');

test('restarts a running engine when routing rules are applied', async () => {
  const calls = [];
  const service = Object.create(SingBoxService.prototype);
  service.isRunning = () => true;
  service.emit = (type, message) => calls.push(['emit', type, message]);
  service.stop = async () => { calls.push(['stop']); };
  service.start = async (profile) => { calls.push(['start', profile]); return { running: true, error: null }; };
  const profile = { routing: { presetIds: ['discord'] } };

  const status = await service.restart(profile);

  assert.deepEqual(status, { running: true, error: null });
  assert.deepEqual(calls.map((item) => item[0]), ['emit', 'stop', 'start']);
  assert.equal(calls[0][2], 'Применяем новые правила маршрутизации…');
  assert.equal(calls[2][1], profile);
});

test('starts directly when applying rules to a stopped engine', async () => {
  const service = Object.create(SingBoxService.prototype);
  service.isRunning = () => false;
  service.start = async () => ({ running: true, error: null });
  service.stop = async () => assert.fail('stop must not be called');

  assert.deepEqual(await service.restart({}), { running: true, error: null });
});

test('validates a profile and performs a protocol handshake before saving', async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const service = Object.create(SingBoxService.prototype);
    service.probeTunnel = async () => ({ latency: 42 });
    const result = await service.testTunnel({
      type: 'vless', name: 'Local test', server: '127.0.0.1', serverPort: port,
      uuid: '11111111-1111-4111-8111-111111111111'
    });
    assert.equal(result.ok, true);
    assert.match(result.message, /соединение установлено/i);
    assert.equal(result.latency, 42);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('checks the active tunnel with a real request through its route', async () => {
  const service = Object.create(SingBoxService.prototype);
  service.isRunning = () => true;
  service.controllerPort = 39090;
  service.activeTunnel = async () => ({ id: 'backup', name: 'Backup', type: 'vless', server: 'backup.example.com' });
  service.requestJson = async (port, requestPath) => {
    assert.equal(port, 39090);
    assert.match(requestPath, /tunnel-backup\/delay/);
    assert.match(requestPath, /generate_204/);
    return { delay: 42 };
  };

  assert.deepEqual(await service.connectionInfo({ routing: { testUrl: 'https://www.gstatic.com/generate_204' } }), {
    tunnelId: 'backup', name: 'Backup', type: 'vless', host: 'backup.example.com', latency: 42, available: true
  });
});

test('reports an unavailable route without relying on ICMP', async () => {
  const service = Object.create(SingBoxService.prototype);
  service.isRunning = () => true;
  service.controllerPort = 39090;
  service.activeTunnel = async () => ({ id: 'awg', name: 'AWG', type: 'awg', endpointHost: 'vpn.example.com' });
  service.requestJson = async () => { throw new Error('timeout'); };

  assert.deepEqual(await service.connectionInfo({ routing: {} }), {
    tunnelId: 'awg', name: 'AWG', type: 'awg', host: 'vpn.example.com', latency: null, available: false
  });
});

test('translates proxy authentication and connectivity failures into useful messages', () => {
  const service = Object.create(SingBoxService.prototype);
  assert.match(service.explainProbeFailure(new Error('proxy authentication failed')), /имя пользователя и пароль/i);
  assert.match(service.explainProbeFailure(new Error('connectex: actively refused')), /адрес, порт/i);
  assert.match(service.explainProbeFailure(new Error('context deadline exceeded')), /не ответил вовремя/i);
  assert.doesNotMatch(service.explainProbeFailure(new Error('https://alice:secret@example.com')), /alice|secret/i);
});
