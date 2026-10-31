const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DEFAULT_CONFIG } = require('../shared/profile');
const { stringifyConfig } = require('../shared/config-generator');
const { MAX_SUBSCRIPTION_BYTES, parseSubscription, loadSubscription, mergeSubscription } = require('../shared/subscription');

const uuid = '11111111-1111-4111-8111-111111111111';
const uri = `vless://${uuid}@192.0.2.10:443?security=reality&encryption=none&fp=chrome&headerType=none&type=tcp&flow=xtls-rprx-vision&sni=example.com&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=0123456789abcdef#${encodeURIComponent('Сервер 🇳🇱')}`;
const second = 'trojan://test-password@192.0.2.20:443?security=tls&sni=example.com&type=ws&host=example.com&path=%2Fproxy#Backup';

test('imports plaintext and Base64 V2Ray subscriptions with names and Reality settings', () => {
  const text = `\uFEFF# comment\r\n${uri}\r\n\r\n${second}\n`;
  for (const source of [text, Buffer.from(text).toString('base64'), Buffer.from(text).toString('base64url')]) {
    const tunnels = parseSubscription(source);
    assert.equal(tunnels.length, 2);
    assert.equal(tunnels[0].name, 'Сервер 🇳🇱');
    assert.equal(tunnels[0].uuid, uuid);
    assert.equal(tunnels[0].flow, 'xtls-rprx-vision');
    assert.equal(tunnels[0].realityEnabled, true);
    assert.equal(tunnels[0].realityShortId, '0123456789abcdef');
    assert.equal(tunnels[0].transportType, 'none');
    assert.equal(tunnels[1].transportType, 'ws');
    assert.equal(tunnels[1].transportPath, '/proxy');
  }
});

test('deduplicates within a subscription and against saved settings, ignoring names and IDs', () => {
  const incoming = parseSubscription(`${uri}\n${uri.replace(/#.*$/, '#Renamed')}\n${second}`);
  const first = mergeSubscription([], incoming);
  assert.equal(first.tunnels.length, 2);
  assert.equal(first.duplicates, 1);
  const repeat = mergeSubscription(first.tunnels, incoming);
  assert.deepEqual(repeat, { tunnels: [], duplicates: 3 });
  assert.equal(mergeSubscription(first.tunnels, [{ ...incoming[0], serverPort: 8443 }]).tunnels.length, 1);
});

test('rejects an incompatible entry without returning a partial list or exposing credentials', () => {
  for (const invalid of ['vmess://private-key', 'vless://private-key', uri.replace('type=tcp', 'type=xhttp'), '<html>Login required</html>']) {
    assert.throws(() => parseSubscription(`${uri}\n${invalid}`), (error) => {
      assert.match(error.message, /строке 2/);
      assert.equal(error.message.includes('private-key'), false);
      assert.equal(error.message.includes(uuid), false);
      return true;
    });
  }
  assert.throws(() => parseSubscription(''), /нет подключений/);
  assert.throws(() => parseSubscription('A'), /Base64/);
  assert.throws(() => parseSubscription('x'.repeat(MAX_SUBSCRIPTION_BYTES + 1)), /2 МБ/);
  assert.throws(() => parseSubscription(Array(501).fill(uri).join('\n')), /500/);
});

test('loads a URL using a V2Ray client header and follows redirects', async () => {
  let called = false;
  const tunnels = await loadSubscription('https://subscription.example/secret', { fetchImpl: async (url, options) => {
    called = true;
    assert.equal(url, 'https://subscription.example/secret');
    assert.equal(options.redirect, 'follow');
    assert.match(options.headers['User-Agent'], /v2rayN/);
    assert.ok(options.signal);
    return new Response(Buffer.from(`${uri}\n${second}`).toString('base64'));
  } });
  assert.equal(called, true);
  assert.equal(tunnels.length, 2);
  assert.equal((await loadSubscription(uri, { fetchImpl: () => assert.fail('Unexpected fetch') })).length, 1);
});

test('handles download errors and oversized bodies without leaking the subscription URL', async () => {
  for (const [fetchImpl, message] of [
    [async () => new Response('', { status: 403 }), /HTTP 403/],
    [async () => { throw new Error('fetch failed https://subscription.example/secret'); }, /Не удалось загрузить/],
    [async () => new Response('x', { headers: { 'content-length': String(MAX_SUBSCRIPTION_BYTES + 1) } }), /2 МБ/],
    [async () => new Response('x'.repeat(MAX_SUBSCRIPTION_BYTES + 1)), /2 МБ/],
    [async () => new Response(''), /нет подключений/]
  ]) {
    await assert.rejects(loadSubscription('https://subscription.example/secret', { fetchImpl }), (error) => {
      assert.match(error.message, message);
      assert.equal(error.message.includes('/secret'), false);
      return true;
    });
  }
  await assert.rejects(loadSubscription('https://user:password@subscription.example/secret'), /логин и пароль/);
});

test('cancels a streaming response when the size limit is reached', async () => {
  let canceled = false;
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(65536)); },
    cancel() { canceled = true; }
  });
  await assert.rejects(loadSubscription('https://subscription.example/secret', {
    fetchImpl: async () => new Response(body)
  }), /2 МБ/);
  assert.equal(canceled, true);
});

test('bundled sing-box accepts a V2Ray subscription as a failover group', {
  skip: !fs.existsSync(path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe'))
}, () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.tunnels = parseSubscription(`${uri}\n${second}`);
  config.routing.activeTunnelId = config.tunnels[0].id;
  config.routing.presetIds = [];
  config.routing.failoverEnabled = true;
  config.routing.failoverTunnelIds = config.tunnels.map((tunnel) => tunnel.id);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-subscription-test-'));
  try {
    const filePath = path.join(directory, 'config.json');
    fs.writeFileSync(filePath, stringifyConfig(config));
    const result = spawnSync(path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe'), ['check', '-c', filePath], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(stringifyConfig(config, true).includes(uuid), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
