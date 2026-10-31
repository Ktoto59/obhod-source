const fs = require('node:fs');
const path = require('node:path');
const { defaultRouterProfile, generateRouterConfig } = require('../openwrt/lib/config');
const { parseProxyUri } = require('../shared/profile');
const { generateConfig } = require('../shared/config-generator');
const profile = defaultRouterProfile();
profile.tunnels = [
  parseProxyUri('vless://11111111-1111-4111-8111-111111111111@192.0.2.10:443?security=tls&sni=example.com'),
  parseProxyUri('socks5://192.0.2.20:1080#Backup')
];
profile.routing.activeTunnelId = profile.tunnels[0].id;
profile.routing.failoverEnabled = true;
profile.routing.failoverTunnelIds = profile.tunnels.map((tunnel) => tunnel.id);
profile.routing.localLists = [{ id: 'fixture', name: 'Test sites', enabled: true, domains: ['example.org'], cidrs: ['203.0.113.0/24'] }];
const directory = path.join(__dirname, '../.tmp');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'openwrt-config.json'), JSON.stringify(generateRouterConfig(profile, { ipv6: true })));
fs.writeFileSync(path.join(directory, 'openwrt-fakeip-config.json'), JSON.stringify(generateRouterConfig(profile, { ipv6: true, dnsMode: 'fakeip' })));
const legacy = generateRouterConfig(profile, { ipv6: true });
const desktop = generateConfig(profile);
legacy.dns = desktop.dns;
legacy.dns.strategy = 'prefer_ipv4';
legacy.dns.reverse_mapping = true;
legacy.route.rules = [{ inbound: ['dns-in'], action: 'hijack-dns' }, ...desktop.route.rules];
delete legacy.experimental.cache_file;
fs.writeFileSync(path.join(directory, 'openwrt-legacy-settings.json'), JSON.stringify({ profile, options: { ipv6: true, dnsMode: 'realip' }, config: legacy }));
console.log('Wrote isolated OpenWrt configuration fixture.');
