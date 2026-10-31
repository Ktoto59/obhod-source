const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_CONFIG, validateConfig } = require('../shared/profile');
const { encodeBackup, decodeBackup, prepareImport, inspectBackup } = require('../windows/src/main/backup');
const { ProfileStore } = require('../windows/src/main/profile-store');
const { applyImport } = require('../windows/src/main/import-transaction');

function profile() {
  const input = structuredClone(DEFAULT_CONFIG);
  input.tunnels = [{ id: 'proxy', type: 'socks5', name: 'Proxy', server: 'proxy.example.com', serverPort: 1080,
    username: 'alice', password: 'private-password' }];
  input.routing.activeTunnelId = 'proxy';
  input.routing.remoteLists = [{ id: 'remote', name: 'Private list', url: 'https://example.com/private-token.txt' }];
  input.routing.applicationRules = [{ id: 'app', name: 'Browser', path: 'C:\\Apps\\Browser.exe', enabled: true }];
  return validateConfig(input);
}

test('encrypted backup restores all profile fields on another installation', async () => {
  const original = profile();
  const text = await encodeBackup(original, 'full', 'a long password');
  assert.doesNotMatch(text, /private-password|alice|private-token|Browser.exe|proxy.example/);
  assert.deepEqual((await decodeBackup(text, 'a long password')).profile, original);
  await assert.rejects(decodeBackup(text, 'wrong password'), /Неверный пароль/);
  const damaged = JSON.parse(text); damaged.data = `${damaged.data[0] === 'A' ? 'B' : 'A'}${damaged.data.slice(1)}`;
  await assert.rejects(decodeBackup(JSON.stringify(damaged), 'a long password'), /повреждён/);
});

test('rules-only backup excludes connections, URLs and machine-specific paths', async () => {
  const text = await encodeBackup(profile(), 'rules');
  assert.doesNotMatch(text, /private-password|alice|private-token|Browser.exe|proxy.example|remoteLists|dnsPath/);
  const decoded = await decodeBackup(text);
  const result = prepareImport(profile(), decoded, 'replace');
  assert.deepEqual(result.tunnels, profile().tunnels);
  assert.deepEqual(result.routing.remoteLists, profile().routing.remoteLists);
});

test('merge remaps conflicting IDs and disables imported application paths', async () => {
  const current = profile(); const other = profile();
  other.routing.applicationRules[0].path = 'D:\\Other\\Browser.exe';
  const result = prepareImport(current, { kind: 'full', profile: other }, 'merge');
  assert.equal(result.tunnels.length, 2);
  assert.notEqual(result.tunnels[0].id, result.tunnels[1].id);
  assert.equal(result.routing.activeTunnelId, current.routing.activeTunnelId);
  assert.equal(result.routing.applicationRules[1].enabled, false);
  assert.equal(result.routing.applicationRules[1].needsReview, true);
});

test('replace retains local startup behavior and marks all application paths for review', () => {
  const current = profile(); current.routing.launchAtLogin = false;
  const other = profile(); other.routing.launchAtLogin = true;
  const result = prepareImport(current, { kind: 'full', profile: other }, 'replace');
  assert.equal(result.routing.launchAtLogin, false);
  assert.equal(result.routing.applicationRules[0].enabled, false);
  assert.equal(result.routing.applicationRules[0].needsReview, true);
});

test('rejects invalid formats, versions and passwords without including input in errors', async () => {
  assert.throws(() => inspectBackup('{secret'), /Не удалось прочитать/);
  assert.throws(() => inspectBackup(JSON.stringify({ format: 'obhod-backup', version: 999, kind: 'full' })), /Неизвестный формат/);
  await assert.rejects(encodeBackup(profile(), 'full', 'short'), /10 символов/);
});

function transactionHarness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-import-test-'));
  const safeStorage = { isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
  const store = new ProfileStore(directory, safeStorage);
  store.save(profile());
  const original = fs.readFileSync(store.filePath);
  const candidate = profile(); candidate.tunnels[0].name = 'Imported';
  const service = { running: true, isRunning() { return this.running; }, status() { return { running: this.running }; }, async checkProfile() {} };
  const recovery = { async stop() { service.running = false; }, async start() { service.running = true; } };
  return { directory, store, service, recovery, candidate, original };
}

test('invalid candidate leaves the running connection and profile untouched', async () => {
  const h = transactionHarness();
  try {
    h.service.checkProfile = async () => { throw new Error('invalid'); };
    await assert.rejects(applyImport(h));
    assert.equal(h.service.running, true);
    assert.deepEqual(fs.readFileSync(h.store.filePath), h.original);
    assert.equal(fs.existsSync(`${h.store.filePath}.before-import`), false);
  } finally { fs.rmSync(h.directory, { recursive: true, force: true }); }
});

test('startup failure rolls back the encrypted file and restarts the previous profile', async () => {
  const h = transactionHarness();
  try {
    h.recovery.start = async (p) => { if (p.tunnels[0].name === 'Imported') throw new Error('failed'); h.service.running = true; };
    await assert.rejects(applyImport(h), /Прежние настройки.*восстановлены/);
    assert.deepEqual(fs.readFileSync(h.store.filePath), h.original);
    assert.deepEqual(fs.readFileSync(`${h.store.filePath}.before-import`), h.original);
    assert.equal(h.service.running, true);
  } finally { fs.rmSync(h.directory, { recursive: true, force: true }); }
});

test('successful import saves a protected rollback copy and preserves running state', async () => {
  const h = transactionHarness();
  try {
    const result = await applyImport(h);
    assert.equal(result.profile.tunnels[0].name, 'Imported');
    assert.equal(result.status.running, true);
    assert.deepEqual(fs.readFileSync(`${h.store.filePath}.before-import`), h.original);
  } finally { fs.rmSync(h.directory, { recursive: true, force: true }); }
});
