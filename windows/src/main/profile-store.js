const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG, parseWireGuardConfig, validateConfig } = require('../../../shared/profile');

class ProfileStore {
  constructor(userDataPath, safeStorage) {
    this.filePath = path.join(userDataPath, 'profile.json');
    this.safeStorage = safeStorage;
  }

  decrypt(value) {
    if (!value || !this.safeStorage.isEncryptionAvailable()) return '';
    return this.safeStorage.decryptString(Buffer.from(value, 'base64'));
  }

  load() {
    try {
      const stored = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (stored.version >= 2 && stored.tunnelsProtected) {
        const tunnels = JSON.parse(this.decrypt(stored.tunnelsProtected));
        return validateConfig({ version: stored.version, tunnels, routing: stored.routing });
      }
      return this.migrateLegacy(stored);
    } catch {
      return validateConfig(structuredClone(DEFAULT_CONFIG));
    }
  }

  migrateLegacy(stored) {
    const config = structuredClone(DEFAULT_CONFIG);
    if (stored.protocol === 'wireguard' && stored.tunnelConfigProtected) {
      const tunnel = parseWireGuardConfig(this.decrypt(stored.tunnelConfigProtected), stored.name || 'Импортированный WireGuard');
      config.tunnels = [tunnel];
      config.routing.activeTunnelId = tunnel.id;
    }
    if (Array.isArray(stored.ruleSets)) config.routing.presetIds = stored.ruleSets;
    if (Array.isArray(stored.domains) || Array.isArray(stored.cidrs)) {
      config.routing.localLists = [{
        id: 'legacy-local', name: 'Мои списки', enabled: true,
        domains: stored.domains || [], cidrs: stored.cidrs || []
      }];
    }
    config.routing.listenPort = stored.listenPort || 2080;
    config.routing.trafficMode = stored.enableSystemProxy === false ? 'local-proxy' : 'system-proxy';
    config.routing.enableSystemProxy = config.routing.trafficMode === 'system-proxy';
    return validateConfig(config);
  }

  save(input) {
    const config = validateConfig(input);
    if (!this.safeStorage.isEncryptionAvailable()) throw new Error('Защищённое хранилище Windows недоступно.');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const stored = {
      version: 6,
      routing: config.routing,
      tunnelsProtected: this.safeStorage.encryptString(JSON.stringify(config.tunnels)).toString('base64')
    };
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(stored, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    return config;
  }
}

module.exports = { ProfileStore };
