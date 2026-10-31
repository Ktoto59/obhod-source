const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { inspectResponse, makeQuery, testDnsLatency } = require('../windows/src/main/dns-latency');

function answerFor(query, address = [93, 184, 216, 34]) {
  const headerAndQuestion = Buffer.from(query);
  headerAndQuestion.writeUInt16BE(0x8180, 2);
  headerAndQuestion.writeUInt16BE(1, 6);
  return Buffer.concat([
    headerAndQuestion,
    Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...address])
  ]);
}

test('builds a DNS query and validates its response', () => {
  const query = makeQuery('example.com');
  const response = answerFor(query.packet);
  assert.equal(inspectResponse(response, query.id), true);
  assert.equal(inspectResponse(response, query.id, true), '93.184.216.34');
});

test('measures a real UDP DNS response', async () => {
  const server = dgram.createSocket('udp4');
  server.on('message', (message, remote) => server.send(answerFor(message), remote.port, remote.address));
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  try {
    const result = await testDnsLatency({ protocol: 'udp', server: '127.0.0.1', bootstrap: '1.1.1.1' }, {
      port: server.address().port, timeout: 1000
    });
    assert.equal(result.address, '127.0.0.1');
    assert.equal(result.protocol, 'udp');
    assert.ok(result.latency >= 1);
  } finally {
    server.close();
  }
});

test('DNS loss times out and a subsequent check succeeds after recovery', async () => {
  const server = dgram.createSocket('udp4');
  let responding = false;
  server.on('message', (message, remote) => {
    if (responding) server.send(answerFor(message), remote.port, remote.address);
  });
  await new Promise((resolve) => server.bind(0, '127.0.0.1', resolve));
  const settings = { protocol: 'udp', server: '127.0.0.1', bootstrap: '1.1.1.1' };
  try {
    await assert.rejects(testDnsLatency(settings, { port: server.address().port, timeout: 100 }), /не ответил/);
    responding = true;
    assert.ok((await testDnsLatency(settings, { port: server.address().port, timeout: 1000 })).latency >= 1);
  } finally {
    server.close();
  }
});
