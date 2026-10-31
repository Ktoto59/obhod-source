const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuleSetService } = require('../windows/src/main/rule-set-service');

test('downloads and converts a plain online domain list', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-rules-'));
  const originalFetch = global.fetch;
  global.fetch = async () => new Response('example.com\n// comment\nsub.example.org\ninvalid value\n');
  try {
    const service = new RuleSetService(directory, () => {});
    const input = { routing: { updateInterval: '12h', remoteLists: [
      { id: 'plain', name: 'Plain', enabled: true, url: 'https://example.com/list.txt', kind: 'domains' }
    ] } };
    const prepared = await service.prepare(input);
    const source = JSON.parse(fs.readFileSync(prepared.preparedRuleSets[0].path, 'utf8'));
    assert.deepEqual(source.rules[0].domain_suffix, ['example.com', 'sub.example.org']);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('downloads presets before sing-box starts and reuses the local copy', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-presets-'));
  const originalFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests += 1;
    return new Response(new Uint8Array([0x53, 0x52, 0x53]));
  };
  try {
    const service = new RuleSetService(directory, () => {});
    const input = { routing: { updateInterval: '12h', presetIds: ['discord'], remoteLists: [] } };
    const first = await service.prepare(input);
    const second = await service.prepare(input);
    assert.equal(first.preparedRuleSets[0].scope, 'preset');
    assert.equal(fs.existsSync(first.preparedRuleSets[0].path), true);
    assert.equal(second.preparedRuleSets[0].path, first.preparedRuleSets[0].path);
    assert.equal(requests, 1);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
