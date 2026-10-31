const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SystemProxy } = require('../windows/src/main/system-proxy');

test('restoring the system proxy is safe when called concurrently', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-proxy-'));
  try {
    fs.writeFileSync(path.join(directory, 'proxy-backup.json'), JSON.stringify({
      ProxyEnable: '0x0', ProxyServer: null, ProxyOverride: null
    }));
    const proxy = new SystemProxy(directory, 'win32');
    const restored = [];
    proxy.restoreValue = async (name) => {
      await new Promise((resolve) => setImmediate(resolve));
      restored.push(name);
    };

    await Promise.all([proxy.restore(), proxy.restore()]);

    assert.deepEqual(restored, ['ProxyEnable', 'ProxyServer', 'ProxyOverride']);
    assert.equal(fs.existsSync(proxy.statePath), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
