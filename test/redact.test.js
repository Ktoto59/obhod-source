const test = require('node:test');
const assert = require('node:assert/strict');
const { redactSensitive } = require('../windows/src/main/redact');

test('redacts connection links and structured credentials from diagnostics', () => {
  const input = [
    'vless://secret@example.com:443?security=reality',
    'hysteria2://secret@example.com:443?obfs-password=cover',
    'tuic://uuid:secret@example.com:443',
    'anytls://secret@example.com:443',
    'process_path: C:\\Users\\PrivateName\\Games\\game.exe',
    'private_key: secret-key',
    'password=secret-password',
    '{"preshared_key":"awg-shared-secret"}',
    '{"uuid":"11111111-1111-1111-1111-111111111111","password":"json-secret"}'
  ].join('\n');
  const output = redactSensitive(input);
  for (const secret of ['vless://secret', 'hysteria2://secret', 'tuic://uuid', 'anytls://secret', 'PrivateName', 'secret-key', 'secret-password', 'awg-shared-secret', '11111111-1111-1111-1111-111111111111', 'json-secret']) {
    assert.equal(output.includes(secret), false);
  }
  assert.match(output, /скрыто/);
  assert.match(output, /game\.exe/);
});
