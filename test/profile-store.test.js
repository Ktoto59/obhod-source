const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore } = require('../windows/src/main/profile-store');

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => value.toString('utf8')
};

const legacyConf = `[Interface]
PrivateKey = AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=
Address = 10.8.0.2/32

[Peer]
PublicKey = AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=
AllowedIPs = 0.0.0.0/0
Endpoint = 192.0.2.10:51820`;

test('migrates legacy WireGuard conf and stores tunnels in protected form', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-store-'));
  try {
    fs.writeFileSync(path.join(directory, 'profile.json'), JSON.stringify({
      protocol: 'wireguard', name: 'Legacy WG',
      tunnelConfigProtected: Buffer.from(legacyConf).toString('base64'),
      ruleSets: ['discord'], domains: ['example.org'], cidrs: [], listenPort: 2080
    }));
    const store = new ProfileStore(directory, safeStorage);
    const migrated = store.load();
    assert.equal(migrated.version, 6);
    assert.equal(migrated.tunnels[0].name, 'Legacy WG');
    assert.equal(migrated.routing.trafficMode, 'system-proxy');
    assert.equal(migrated.routing.activeTunnelId, migrated.tunnels[0].id);
    store.save(migrated);
    const disk = fs.readFileSync(path.join(directory, 'profile.json'), 'utf8');
    assert.equal(disk.includes('AQEBAQEBAQEBAQEBAQEBAQE'), false);
    assert.match(disk, /tunnelsProtected/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps version 2 profiles on the legacy system proxy mode', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-store-v2-'));
  try {
    fs.writeFileSync(path.join(directory, 'profile.json'), JSON.stringify({
      version: 2,
      tunnelsProtected: Buffer.from('[]').toString('base64'),
      routing: { presetIds: [], localLists: [], remoteLists: [], listenPort: 2080, enableSystemProxy: true }
    }));
    const loaded = new ProfileStore(directory, safeStorage).load();
    assert.equal(loaded.version, 6);
    assert.equal(loaded.routing.trafficMode, 'system-proxy');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('migrates protected version 2 profiles to the extensible protocol schema', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-store-protocol-v3-'));
  try {
    const tunnels = [{
      id: 'hy2', type: 'hysteria2', name: 'Hysteria2', server: 'example.com', serverPort: 443,
      password: 'secret', serverName: 'example.com', obfsType: 'salamander', obfsPassword: 'cover'
    }];
    fs.writeFileSync(path.join(directory, 'profile.json'), JSON.stringify({
      version: 2,
      tunnelsProtected: Buffer.from(JSON.stringify(tunnels)).toString('base64'),
      routing: {
        activeTunnelId: 'hy2', presetIds: [], localLists: [], remoteLists: [], listenPort: 2080,
        applicationRules: [{ id: 'game', name: 'Game', path: 'D:\\Games\\game.exe', action: 'proxy', enabled: true }]
      }
    }));
    const store = new ProfileStore(directory, safeStorage);
    const loaded = store.load();
    assert.equal(loaded.version, 6);
    assert.equal(loaded.tunnels[0].type, 'hysteria2');
    assert.equal(loaded.tunnels[0].obfsPassword, 'cover');
    assert.equal(loaded.routing.applicationRules[0].path, 'D:\\Games\\game.exe');
    store.save(loaded);
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'profile.json'), 'utf8')).version, 6);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('persists completion of the first-run guide', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-onboarding-'));
  try {
    const store = new ProfileStore(directory, safeStorage);
    const profile = store.load();
    assert.equal(profile.routing.onboardingCompleted, false);
    profile.routing.onboardingCompleted = true;
    store.save(profile);
    assert.equal(store.load().routing.onboardingCompleted, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('protects SOCKS5 and HTTP proxy credentials as part of the encrypted profile', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-proxy-store-'));
  try {
    const store = new ProfileStore(directory, safeStorage);
    const profile = store.load();
    profile.tunnels = [{
      id: 'proxy', type: 'socks5', name: 'Рабочий прокси', server: 'proxy.example.com',
      serverPort: 1080, username: 'private-user', password: 'private-password'
    }];
    profile.routing.activeTunnelId = 'proxy';
    store.save(profile);
    const disk = fs.readFileSync(path.join(directory, 'profile.json'), 'utf8');
    assert.equal(disk.includes('private-user'), false);
    assert.equal(disk.includes('private-password'), false);
    const loaded = store.load();
    assert.equal(loaded.tunnels[0].username, 'private-user');
    assert.equal(loaded.tunnels[0].password, 'private-password');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
