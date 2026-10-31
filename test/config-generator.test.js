const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { generateConfig, stringifyConfig } = require('../shared/config-generator');
const { normalizePresetIds, parseProxyUri, parseWireGuardConfig, validateApplicationRule, validateConfig } = require('../shared/profile');

const tunnel = {
  id: 'wg-main', name: 'Основной WG',
  privateKey: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
  addresses: ['10.8.0.2/32', 'fd00::2/128'], dns: ['1.1.1.1', '2606:4700:4700::1111'], mtu: 1408,
  peerPublicKey: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=', preSharedKey: '',
  endpointHost: '192.0.2.10', endpointPort: 51820,
  allowedIps: ['0.0.0.0/0', '::/0'], keepalive: 25, networkFamily: 'ipv4'
};

const awgTunnel = {
  ...tunnel, id: 'awg-main', type: 'awg', name: 'Основной AWG', preSharedKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  jc: 4, jmin: 40, jmax: 70, s1: 40, s2: 55, s3: 0, s4: 0,
  h1: '111111', h2: '222222-222225', h3: '333333', h4: '444444',
  i1: '<b 0x0a><c><b 0x2e>', i2: '', i3: '', i4: '', i5: ''
};

const appConfig = {
  version: 4,
  tunnels: [tunnel],
  routing: {
    activeTunnelId: tunnel.id,
    presetIds: ['discord', 'telegram'],
    localLists: [{ id: 'mine', name: 'Мои сайты', enabled: true, domains: ['Video.Example', 'chat.example'], cidrs: ['203.0.113.0/24'] }],
    remoteLists: [], listenPort: 2080, enableSystemProxy: true, updateInterval: '12h'
  }
};

test('normalizes structured routing configuration', () => {
  const value = validateConfig(appConfig);
  assert.deepEqual(value.routing.localLists[0].domains, ['chat.example', 'video.example']);
  assert.equal(value.routing.activeTunnelId, 'wg-main');
  assert.equal(value.routing.launchAtLogin, false);
  assert.equal(value.routing.startOnLaunch, false);
  assert.equal(value.routing.autoCheckUpdates, true);
  assert.equal(value.routing.dismissedUpdateVersion, '');
  assert.equal(value.routing.trafficMode, 'system-proxy');
  assert.equal(value.routing.strictRoute, true);
  assert.deepEqual(value.routing.applicationRules, []);
});

test('validates Windows application rules strictly', () => {
  const rule = validateApplicationRule({ path: 'D:/Games/Example/game.exe', action: 'proxy' });
  assert.equal(rule.path, 'D:\\Games\\Example\\game.exe');
  assert.equal(rule.name, 'game');
  assert.throws(() => validateApplicationRule({ path: 'D:\\Games\\readme.txt' }), /\.exe/i);
  assert.throws(() => validateApplicationRule({ path: 'game.exe', action: 'proxy' }), /исполняемый файл/i);
  assert.throws(() => validateApplicationRule({ path: 'D:\\Games\\game.exe', action: 'unknown' }), /действие/i);
});

test('routes selected applications before domain rules and mirrors their DNS route', () => {
  const input = structuredClone(appConfig);
  input.routing.trafficMode = 'tun';
  input.routing.applicationRules = [
    { id: 'game', name: 'Game', path: 'D:\\Games\\Example\\game.exe', action: 'proxy', enabled: true },
    { id: 'browser', name: 'Browser', path: 'C:\\Apps\\browser.exe', action: 'direct', enabled: true },
    { id: 'off', name: 'Off', path: 'C:\\Apps\\off.exe', action: 'proxy', enabled: false }
  ];
  const generated = generateConfig(input);
  const gameRule = generated.route.rules.find((rule) => rule.process_path?.[0].endsWith('game.exe'));
  const browserRule = generated.route.rules.find((rule) => rule.process_path?.[0].endsWith('browser.exe'));
  assert.equal(gameRule.outbound, 'tunnel-wg-main');
  assert.equal(browserRule.outbound, 'direct');
  assert.equal(generated.route.rules.some((rule) => rule.process_path?.[0].endsWith('off.exe')), false);
  assert.ok(generated.route.rules.indexOf(gameRule) < generated.route.rules.findIndex((rule) => rule.domain_suffix));
  assert.equal(generated.dns.rules.find((rule) => rule.process_path?.[0].endsWith('game.exe')).server, 'proxy-dns');
  assert.equal(generated.dns.rules.find((rule) => rule.process_path?.[0].endsWith('browser.exe')).server, 'direct-dns');
  const binary = path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe');
  if (fs.existsSync(binary)) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-app-rules-test-'));
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, stringifyConfig(input));
    const result = spawnSync(binary, ['check', '-c', configPath], { encoding: 'utf8' });
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test('keeps application rules inactive outside TUN mode', () => {
  const input = structuredClone(appConfig);
  input.routing.trafficMode = 'system-proxy';
  input.routing.applicationRules = [
    { id: 'game', name: 'Game', path: 'D:\\Games\\Example\\game.exe', action: 'proxy', enabled: true }
  ];
  const generated = generateConfig(input);
  assert.equal(generated.route.rules.some((rule) => rule.process_path), false);
  assert.equal(generated.dns.rules.some((rule) => rule.process_path), false);
});

test('preserves tray startup preferences', () => {
  const input = structuredClone(appConfig);
  input.routing.launchAtLogin = true;
  input.routing.startOnLaunch = true;
  const value = validateConfig(input);
  assert.equal(value.routing.launchAtLogin, true);
  assert.equal(value.routing.startOnLaunch, true);
});

test('applies Podkop preset restrictions for Russia inside', () => {
  assert.deepEqual(
    normalizePresetIds(['youtube', 'discord', 'russia_inside', 'google_ai', 'russia_outside', 'anime']),
    ['discord', 'russia_inside', 'google_ai']
  );
  assert.deepEqual(
    normalizePresetIds(['russia_outside', 'ukraine_inside', 'youtube']),
    ['russia_outside', 'youtube']
  );
});

test('generates WireGuard endpoint and selective routes', () => {
  const config = generateConfig(appConfig);
  assert.equal(config.log.level, 'error');
  assert.equal(config.endpoints[0].type, 'wireguard');
  assert.equal(config.endpoints[0].peers[0].port, 51820);
  assert.deepEqual(config.endpoints[0].address, ['10.8.0.2/32']);
  assert.deepEqual(config.endpoints[0].peers[0].allowed_ips, ['0.0.0.0/0']);
  assert.equal(config.endpoints[0].inet4_bind_address, '0.0.0.0');
  assert.equal(config.endpoints[0].domain_resolver.strategy, 'ipv4_only');
  assert.equal(config.route.default_domain_resolver.strategy, 'ipv4_only');
  assert.equal(config.route.final, 'direct');
  assert.deepEqual(config.route.rules[3].domain_suffix, ['chat.example', 'video.example']);
  assert.deepEqual(config.dns.rules[0].domain_suffix, ['chat.example', 'video.example']);
  assert.equal(config.dns.rules[0].server, 'proxy-dns');
  assert.deepEqual(config.dns.rules[1].rule_set, ['preset-discord', 'preset-telegram']);
});

test('imports AmneziaWG fields and generates an AWG endpoint accepted by the bundled core', {
  skip: !fs.existsSync(path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe'))
}, () => {
  const parsed = parseWireGuardConfig(`[Interface]\nPrivateKey = ${awgTunnel.privateKey}\nAddress = 10.8.0.2/32\nJc = 4\nJmin = 40\nJmax = 70\nS1 = 40\nS2 = 55\nH1 = 111111\nH2 = 222222-222225\nI1 = <b 0x0a><c><b 0x2e>\n\n[Peer]\nPublicKey = ${awgTunnel.peerPublicKey}\nPresharedKey = ${awgTunnel.preSharedKey}\nAllowedIPs = 0.0.0.0/0\nEndpoint = 192.0.2.10:51820`, 'amnezia.conf');
  assert.equal(parsed.type, 'awg');
  assert.equal(parsed.jc, 4);
  assert.equal(parsed.h2, '222222-222225');
  assert.equal(parsed.i1, '<b 0x0a><c><b 0x2e>');

  const input = structuredClone(appConfig);
  input.tunnels = [awgTunnel]; input.routing.activeTunnelId = awgTunnel.id; input.routing.presetIds = [];
  const generated = generateConfig(input);
  const endpoint = generated.endpoints[0];
  assert.equal(endpoint.type, 'awg');
  assert.equal(endpoint.useIntegratedTun, false);
  assert.equal(endpoint.h2, '222222-222225');
  assert.equal(endpoint.peers[0].preshared_key, awgTunnel.preSharedKey);

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-awg-test-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, stringifyConfig(input));
  const result = spawnSync(path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe'), ['check', '-c', configPath], { encoding: 'utf8' });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const preview = stringifyConfig(input, true);
  assert.equal(preview.includes(awgTunnel.preSharedKey), false);
});

test('preserves update notification preferences', () => {
  const input = structuredClone(appConfig);
  input.routing.autoCheckUpdates = false;
  input.routing.dismissedUpdateVersion = '0.11.0';
  const value = validateConfig(input);
  assert.equal(value.routing.autoCheckUpdates, false);
  assert.equal(value.routing.dismissedUpdateVersion, '0.11.0');
});

test('normalizes DNS resolver settings', () => {
  const input = structuredClone(appConfig);
  Object.assign(input.routing, {
    dnsResolverEnabled: true,
    dnsProtocol: 'https',
    dnsServer: 'dns.google',
    dnsBootstrap: '8.8.8.8',
    dnsPath: '/dns-query',
    dnsTtl: 300
  });
  const value = validateConfig(input);
  assert.equal(value.routing.dnsResolverEnabled, true);
  assert.equal(value.routing.dnsProtocol, 'https');
  assert.equal(value.routing.dnsServer, 'dns.google');
  assert.equal(value.routing.dnsBootstrap, '8.8.8.8');
  assert.equal(value.routing.dnsPath, '/dns-query');
  assert.equal(value.routing.dnsTtl, 300);
});

test('routes selected-domain DNS through the configured resolver', () => {
  const input = structuredClone(appConfig);
  Object.assign(input.routing, {
    dnsResolverEnabled: true,
    dnsProtocol: 'tls',
    dnsServer: 'p2.freedns.controld.com',
    dnsBootstrap: '77.88.8.8',
    dnsPath: '/dns-query',
    dnsTtl: 60
  });
  const config = generateConfig(input);
  const bootstrap = config.dns.servers.find((item) => item.tag === 'bootstrap-dns');
  const resolver = config.dns.servers.find((item) => item.tag === 'proxy-dns');
  assert.deepEqual(bootstrap, { tag: 'bootstrap-dns', type: 'udp', server: '77.88.8.8' });
  assert.equal(resolver.type, 'tls');
  assert.equal(resolver.server, 'p2.freedns.controld.com');
  assert.equal(resolver.detour, 'tunnel-wg-main');
  assert.equal(resolver.domain_resolver.server, 'bootstrap-dns');
  assert.equal(resolver.tls.server_name, 'p2.freedns.controld.com');
  assert.equal(config.dns.rules[0].rewrite_ttl, 60);
  assert.equal(config.dns.rules[1].rewrite_ttl, 60);
});

test('keeps a provider-specific DNS over HTTPS path', () => {
  const input = structuredClone(appConfig);
  Object.assign(input.routing, {
    dnsResolverEnabled: true,
    dnsProtocol: 'https',
    dnsServer: 'freedns.controld.com',
    dnsBootstrap: '76.76.2.2',
    dnsPath: '/p2'
  });
  const resolver = generateConfig(input).dns.servers.find((item) => item.tag === 'proxy-dns');
  assert.equal(resolver.type, 'https');
  assert.equal(resolver.server, 'freedns.controld.com');
  assert.equal(resolver.path, '/p2');
});

test('official sing-box accepts every DNS resolver protocol', {
  skip: !fs.existsSync(path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe'))
}, () => {
  const binary = path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-dns-test-'));
  try {
    for (const protocol of ['udp', 'tcp', 'tls', 'https']) {
      const input = structuredClone(appConfig);
      Object.assign(input.routing, {
        dnsResolverEnabled: true,
        dnsProtocol: protocol,
        dnsServer: protocol === 'udp' || protocol === 'tcp' ? '1.1.1.1' : 'one.one.one.one',
        dnsBootstrap: '1.1.1.1',
        dnsTtl: 120
      });
      const configPath = path.join(directory, `${protocol}.json`);
      fs.writeFileSync(configPath, stringifyConfig(input));
      const result = spawnSync(binary, ['check', '-c', configPath], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${protocol}: ${result.stderr || result.stdout}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('enables verbose sing-box logging only for diagnostics', () => {
  const input = structuredClone(appConfig);
  input.routing.enableDiagnostics = true;
  assert.equal(generateConfig(input).log.level, 'info');
});

test('generates a selective Windows TUN inbound', () => {
  const input = structuredClone(appConfig);
  input.routing.trafficMode = 'tun';
  input.routing.strictRoute = true;
  const config = generateConfig(input);
  const tun = config.inbounds.find((item) => item.type === 'tun');
  assert.deepEqual(tun.address, ['172.19.0.1/30']);
  assert.equal(tun.auto_route, true);
  assert.equal(tun.strict_route, true);
  assert.equal(config.route.auto_detect_interface, true);
  assert.equal(config.route.final, 'direct');
  assert.equal(config.inbounds.some((item) => item.type === 'mixed'), true);
  const binary = path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe');
  if (fs.existsSync(binary)) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-tun-check-'));
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, stringifyConfig(input));
    const result = spawnSync(binary, ['check', '-c', configPath], { encoding: 'utf8' });
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test('keeps proxy modes free from a TUN interface', () => {
  for (const trafficMode of ['system-proxy', 'local-proxy']) {
    const input = structuredClone(appConfig);
    input.routing.trafficMode = trafficMode;
    assert.equal(generateConfig(input).inbounds.some((item) => item.type === 'tun'), false);
  }
});

test('adds official Podkop presets as remote SRS', () => {
  const config = generateConfig(appConfig);
  assert.deepEqual(config.route.rule_set.map((item) => item.tag), ['preset-discord', 'preset-telegram']);
  assert.match(config.route.rule_set[0].url, /allow-domains\/releases\/latest\/download\/discord\.srs$/);
});

test('supports online SRS and JSON lists', () => {
  const input = structuredClone(appConfig);
  input.routing.remoteLists = [
    { id: 'one', name: 'SRS', enabled: true, url: 'https://example.com/one.srs', kind: 'domains' },
    { id: 'two', name: 'JSON', enabled: true, url: 'https://example.com/two.json', kind: 'cidrs' }
  ];
  const config = generateConfig(input);
  assert.equal(config.route.rule_set.at(-2).format, 'binary');
  assert.equal(config.route.rule_set.at(-1).format, 'source');
});

test('redacts WireGuard private keys', () => {
  const preview = stringifyConfig(appConfig, true);
  assert.equal(preview.includes(tunnel.privateKey), false);
  assert.equal(preview.includes('••••••••'), true);
});

test('imports a standard WireGuard conf into fields', () => {
  const parsed = parseWireGuardConfig(`[Interface]\nPrivateKey = ${tunnel.privateKey}\nAddress = 10.8.0.2/32\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = ${tunnel.peerPublicKey}\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = 192.0.2.10:51820\nPersistentKeepalive = 25`, 'demo.conf');
  assert.equal(parsed.name, 'demo');
  assert.equal(parsed.endpointPort, 51820);
  assert.deepEqual(parsed.allowedIps, ['0.0.0.0/0', '::/0']);
});

test('imports supported proxy links without losing protocol-specific fields', () => {
  const vless = parseProxyUri('vless://11111111-1111-4111-8111-111111111111@example.com:443?security=reality&sni=cdn.example.com&fp=chrome&pbk=public-key&sid=abcd&type=grpc&serviceName=edge#VLESS');
  assert.equal(vless.type, 'vless');
  assert.equal(vless.realityEnabled, true);
  assert.equal(vless.transportType, 'grpc');
  const credentials = Buffer.from('aes-256-gcm:secret').toString('base64url');
  assert.equal(parseProxyUri(`ss://${credentials}@example.com:8388#SS`).method, 'aes-256-gcm');
  assert.equal(parseProxyUri('trojan://password@example.com:443?sni=example.com#Trojan').type, 'trojan');
  const hysteria = parseProxyUri('hy2://secret@example.com:443/?sni=cdn.example.com&obfs=salamander&obfs-password=cover#HY2');
  assert.equal(hysteria.type, 'hysteria2');
  assert.equal(hysteria.obfsPassword, 'cover');
  const tuic = parseProxyUri('tuic://11111111-1111-4111-8111-111111111111:secret@example.com:443?sni=cdn.example.com&congestion_control=bbr&udp_relay_mode=quic#TUIC');
  assert.equal(tuic.password, 'secret');
  assert.equal(tuic.congestionControl, 'bbr');
  const anytls = parseProxyUri('anytls://secret@example.com:443?sni=cdn.example.com#AnyTLS');
  assert.equal(anytls.type, 'anytls');
  assert.equal(anytls.tlsEnabled, true);
  const socks = parseProxyUri('socks5://alice:p%40ss@proxy.example.com:1080#Рабочий%20SOCKS');
  assert.equal(socks.type, 'socks5');
  assert.equal(socks.username, 'alice');
  assert.equal(socks.password, 'p@ss');
  assert.equal(socks.name, 'Рабочий SOCKS');
  const http = parseProxyUri('https://bob:secret@proxy.example.com#HTTPS');
  assert.equal(http.type, 'http');
  assert.equal(http.serverPort, 443);
  assert.equal(http.tlsEnabled, true);
  const anonymous = parseProxyUri('http://proxy.example.com#Без%20авторизации');
  assert.equal(anonymous.serverPort, 8080);
  assert.equal(anonymous.username, '');
  assert.equal(anonymous.password, '');
});

test('strictly rejects incomplete or unsupported modern protocol profiles', () => {
  assert.throws(() => parseProxyUri('tuic://11111111-1111-4111-8111-111111111111@example.com:443'), /пароль/i);
  assert.throws(() => parseProxyUri('hysteria2://secret@example.com:443?obfs=gecko'), /Salamander/i);
  assert.throws(() => parseProxyUri('anytls://@example.com:443'), /пароль/i);
});

test('generates native authenticated SOCKS5 and HTTP outbounds and redacts credentials', () => {
  const input = structuredClone(appConfig);
  input.tunnels = [
    { id: 'socks', type: 'socks5', name: 'SOCKS5', server: '192.0.2.17', serverPort: 1080, username: 'alice', password: 'socks-secret' },
    { id: 'http', type: 'http', name: 'HTTPS proxy', server: '192.0.2.18', serverPort: 443, username: 'bob', password: 'http-secret', tlsEnabled: true, serverName: 'proxy.example.com' }
  ];
  input.routing.activeTunnelId = 'socks';
  input.routing.failoverEnabled = true;
  input.routing.failoverTunnelIds = ['socks', 'http'];
  const generated = generateConfig(input);
  const socks = generated.outbounds.find((item) => item.tag === 'tunnel-socks');
  const http = generated.outbounds.find((item) => item.tag === 'tunnel-http');
  assert.equal(socks.type, 'socks');
  assert.equal(socks.version, '5');
  assert.equal(socks.username, 'alice');
  assert.equal(http.type, 'http');
  assert.equal(http.tls.server_name, 'proxy.example.com');
  const preview = stringifyConfig(input, true);
  assert.doesNotMatch(preview, /alice|bob|socks-secret|http-secret/);
  assert.match(preview, /••••••••/);
});

test('includes Hysteria2, TUIC and AnyTLS in automatic failover groups', () => {
  const input = structuredClone(appConfig);
  input.tunnels = [
    { id: 'hy2', type: 'hysteria2', name: 'HY2', server: '192.0.2.14', serverPort: 443, password: 'secret', serverName: 'example.com' },
    { id: 'tuic', type: 'tuic', name: 'TUIC', server: '192.0.2.15', serverPort: 443, uuid: '11111111-1111-4111-8111-111111111111', password: 'secret', serverName: 'example.com' },
    { id: 'anytls', type: 'anytls', name: 'AnyTLS', server: '192.0.2.16', serverPort: 443, password: 'secret', serverName: 'example.com' }
  ];
  input.routing.activeTunnelId = 'hy2';
  input.routing.failoverEnabled = true;
  input.routing.failoverTunnelIds = ['hy2', 'tuic', 'anytls'];
  const generated = generateConfig(input);
  assert.deepEqual(generated.outbounds.find((item) => item.type === 'urltest').outbounds, [
    'tunnel-hy2', 'tunnel-tuic', 'tunnel-anytls'
  ]);
});

test('generates an automatic failover group across WireGuard, AmneziaWG and VLESS', () => {
  const input = structuredClone(appConfig);
  input.tunnels.push(awgTunnel);
  input.tunnels.push({
    id: 'vless-backup', type: 'vless', name: 'VLESS backup', server: '192.0.2.11', serverPort: 443,
    uuid: '11111111-1111-4111-8111-111111111111', tlsEnabled: true, serverName: 'example.com'
  });
  input.routing.failoverEnabled = true;
  input.routing.failoverTunnelIds = ['wg-main', 'awg-main', 'vless-backup'];
  input.routing.controllerPort = 39090;
  const generated = generateConfig(input);
  const group = generated.outbounds.find((item) => item.type === 'urltest');
  assert.deepEqual(group.outbounds, ['tunnel-wg-main', 'tunnel-awg-main', 'tunnel-vless-backup']);
  assert.equal(group.interval, '15s');
  assert.equal(group.tolerance, 80);
  assert.equal(group.interrupt_exist_connections, false);
  assert.equal(group.idle_timeout, '24h');
  assert.equal(generated.experimental.clash_api.external_controller, '127.0.0.1:39090');
  assert.equal(generated.route.rules[3].outbound, 'proxy');
  const binary = path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe');
  if (fs.existsSync(binary)) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-failover-test-'));
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, stringifyConfig(input));
    const result = spawnSync(binary, ['check', '-c', configPath], { encoding: 'utf8' });
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test('bundled sing-box core accepts generated configuration', { skip: !fs.existsSync(path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe')) }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-v3-test-'));
  const configPath = path.join(directory, 'config.json');
  fs.writeFileSync(configPath, stringifyConfig(appConfig));
  const result = spawnSync(path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe'), ['check', '-c', configPath], { encoding: 'utf8' });
  fs.rmSync(directory, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('bundled sing-box core accepts every supported proxy outbound', {
  skip: !fs.existsSync(path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe'))
}, () => {
  const connections = [
    { id: 'vless', type: 'vless', name: 'VLESS', server: '192.0.2.11', serverPort: 443, uuid: '11111111-1111-4111-8111-111111111111', tlsEnabled: true, serverName: 'example.com' },
    { id: 'ss', type: 'shadowsocks', name: 'SS', server: '192.0.2.12', serverPort: 8388, method: 'aes-256-gcm', password: 'secret' },
    { id: 'trojan', type: 'trojan', name: 'Trojan', server: '192.0.2.13', serverPort: 443, password: 'secret', tlsEnabled: true, serverName: 'example.com' },
    { id: 'hy2', type: 'hysteria2', name: 'Hysteria2', server: '192.0.2.14', serverPort: 443, password: 'secret', tlsEnabled: true, serverName: 'example.com', obfsType: 'salamander', obfsPassword: 'cover' },
    { id: 'tuic', type: 'tuic', name: 'TUIC', server: '192.0.2.15', serverPort: 443, uuid: '11111111-1111-4111-8111-111111111111', password: 'secret', tlsEnabled: true, serverName: 'example.com', congestionControl: 'bbr', udpRelayMode: 'native' },
    { id: 'anytls', type: 'anytls', name: 'AnyTLS', server: '192.0.2.16', serverPort: 443, password: 'secret', tlsEnabled: true, serverName: 'example.com', idleSessionCheckInterval: '30s', idleSessionTimeout: '30s', minIdleSession: 0 },
    { id: 'socks5', type: 'socks5', name: 'SOCKS5', server: '192.0.2.17', serverPort: 1080, username: 'alice', password: 'secret' },
    { id: 'http', type: 'http', name: 'HTTP', server: '192.0.2.18', serverPort: 8080, username: 'bob', password: 'secret' }
  ];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-protocols-test-'));
  try {
    for (const connection of connections) {
      const input = structuredClone(appConfig);
      input.tunnels = [connection]; input.routing.activeTunnelId = connection.id; input.routing.presetIds = [];
      const configPath = path.join(directory, `${connection.id}.json`);
      fs.writeFileSync(configPath, stringifyConfig(input));
      const result = spawnSync(path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe'), ['check', '-c', configPath], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${connection.type}: ${result.stderr || result.stdout}`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('WireGuard IPv4 mode does not open a udp6 bind on Windows', {
  skip: process.platform !== 'win32' || !fs.existsSync(path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe'))
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-wg4-test-'));
  const configPath = path.join(directory, 'config.json');
  const input = structuredClone(appConfig);
  input.routing.presetIds = [];
  input.routing.listenPort = 42080 + Math.floor(Math.random() * 1000);
  fs.writeFileSync(configPath, stringifyConfig(input));
  const child = spawn(path.join(__dirname, '..', 'windows/runtime', 'sing-box.exe'), ['run', '-c', configPath], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (data) => { output += String(data); });
  child.stderr.on('data', (data) => { output += String(data); });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  fs.rmSync(directory, { recursive: true, force: true });
  assert.doesNotMatch(output, /listen udp6|address family not supported/i, output);
});
