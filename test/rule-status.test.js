const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { RuleSetService } = require('../windows/src/main/rule-set-service');

const binary = path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe');

test('counts known domain and network entries in source rule sets', () => {
  const service = Object.create(RuleSetService.prototype);
  assert.equal(service.countSourceRules({
    version: 3,
    rules: [
      { domain_suffix: ['example.com', 'example.org'] },
      { ip_cidr: ['192.0.2.0/24'] },
      { rules: [{ domain_keyword: ['demo'] }] }
    ]
  }), 4);
});

test('counts entries in a binary SRS through the bundled sing-box', { skip: !fs.existsSync(binary) }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-rule-count-'));
  try {
    const source = path.join(directory, 'source.json');
    const compiled = path.join(directory, 'rules.srs');
    fs.writeFileSync(source, JSON.stringify({ version: 3, rules: [{ domain_suffix: ['example.com', 'example.org'] }] }));
    const result = spawnSync(binary, ['rule-set', 'compile', source, '-o', compiled], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const service = Object.create(RuleSetService.prototype);
    const profile = await service.inspectPrepared({
      preparedRuleSets: [{ id: 'binary-test', path: compiled, format: 'binary' }],
      ruleStatus: { sourcesTotal: 1, sourcesReady: 1, knownEntries: 0, entriesComplete: true, warnings: [] }
    }, binary);
    assert.equal(profile.ruleStatus.knownEntries, 2);
    assert.equal(profile.ruleStatus.entriesComplete, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
