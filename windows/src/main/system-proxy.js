const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

async function regQuery(name) {
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', INTERNET_SETTINGS, '/v', name], { windowsHide: true });
    const match = stdout.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)$`, 'mi'));
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function regAdd(name, type, value) {
  await execFileAsync('reg.exe', ['add', INTERNET_SETTINGS, '/v', name, '/t', type, '/d', String(value), '/f'], { windowsHide: true });
}

async function regDelete(name) {
  try {
    await execFileAsync('reg.exe', ['delete', INTERNET_SETTINGS, '/v', name, '/f'], { windowsHide: true });
  } catch {}
}

class SystemProxy {
  constructor(userDataPath, platform = process.platform) {
    this.statePath = path.join(userDataPath, 'proxy-backup.json');
    this.platform = platform;
    this.restorePromise = null;
  }

  async enable(port) {
    if (this.platform !== 'win32') return;
    if (!fs.existsSync(this.statePath)) {
      const backup = {
        ProxyEnable: await regQuery('ProxyEnable'),
        ProxyServer: await regQuery('ProxyServer'),
        ProxyOverride: await regQuery('ProxyOverride')
      };
      fs.writeFileSync(this.statePath, JSON.stringify(backup), { mode: 0o600 });
    }
    await regAdd('ProxyServer', 'REG_SZ', `127.0.0.1:${port}`);
    await regAdd('ProxyOverride', 'REG_SZ', '<local>;localhost;127.*');
    await regAdd('ProxyEnable', 'REG_DWORD', 1);
  }

  async restore() {
    if (this.platform !== 'win32') return;
    if (this.restorePromise) return this.restorePromise;
    this.restorePromise = this.restoreOnce();
    try {
      await this.restorePromise;
    } finally {
      this.restorePromise = null;
    }
  }

  async restoreOnce() {
    if (!fs.existsSync(this.statePath)) return;
    const backup = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    await this.restoreValue('ProxyEnable', 'REG_DWORD', backup.ProxyEnable);
    await this.restoreValue('ProxyServer', 'REG_SZ', backup.ProxyServer);
    await this.restoreValue('ProxyOverride', 'REG_SZ', backup.ProxyOverride);
    try {
      fs.unlinkSync(this.statePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  async restoreValue(name, type, value) {
    if (value === null || value === undefined) await regDelete(name);
    else await regAdd(name, type, value);
  }

  hasBackup() { return fs.existsSync(this.statePath); }
}

module.exports = { SystemProxy };
