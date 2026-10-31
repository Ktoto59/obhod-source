const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDomains } = require('../windows/src/renderer/domain-input');

test('website input strips paths, normalizes IDNs and deduplicates domains', () => {
  assert.deepEqual(normalizeDomains('https://Example.com/page?q=1\nexample.com/\nhttps://пример.рф/'),
    ['example.com', 'xn--e1afmkfd.xn--p1ai']);
});
test('invalid entries and credentials cannot silently turn into broad routing rules', () => {
  for (const value of ['https://user:secret@example.com', 'ftp://example.com', '127.0.0.1', '*.com', 'bad..com', '-bad.com', 'localhost']) {
    assert.throws(() => normalizeDomains(value));
  }
  assert.deepEqual(normalizeDomains(''), []);
});
