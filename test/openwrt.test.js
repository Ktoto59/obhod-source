const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseProxyUri } = require('../shared/profile');
const { defaultRouterProfile, generateRouterConfig } = require('../openwrt/lib/config');
const { buildCore } = require('../scripts/build-openwrt-core');
const link = 'vless://11111111-1111-4111-8111-111111111111@192.0.2.10:443?security=tls&sni=example.com#Router';

function profile() {
  const value = defaultRouterProfile();
  value.tunnels = [parseProxyUri(link), parseProxyUri('socks5://192.0.2.20:1080#Backup')];
  value.routing.activeTunnelId = value.tunnels[0].id;
  value.routing.failoverEnabled = true;
  value.routing.failoverTunnelIds = value.tunnels.map((tunnel) => tunnel.id);
  value.routing.localLists = [{ id: 'test', name: 'Sites', enabled: true, domains: ['example.org'], cidrs: [] }];
  return value;
}

test('OpenWrt starts without bundled accounts or preselected provider rules', () => {
  const value = defaultRouterProfile();
  assert.deepEqual(value.tunnels, []);
  assert.deepEqual(value.routing.presetIds, []);
  assert.deepEqual(value.routing.localLists, []);
});

test('router configuration scopes TUN to LAN and provides a loopback DNS upstream', () => {
  const config = generateRouterConfig(profile(), { interfaces: ['br-lan', 'br-guest'], ipv6: true });
  const tun = config.inbounds.find((inbound) => inbound.type === 'tun');
  assert.deepEqual(tun.include_interface, ['br-lan', 'br-guest']);
  assert.equal(tun.auto_redirect, true);
  assert.equal(tun.stack, 'system');
  assert.equal(tun.address.length, 2);
  assert.equal(config.inbounds.find((inbound) => inbound.tag === 'dns-in').listen, '127.0.0.1');
  assert.equal(config.inbounds.find((inbound) => inbound.tag === 'dns-in').listen_port, 1053);
  assert.deepEqual(config.route.rules[0], { inbound: ['dns-in'], action: 'hijack-dns' });
  assert.equal(config.route.final, 'direct');
  assert.equal(config.outbounds.find((outbound) => outbound.type === 'urltest').outbounds.length, 2);
  assert.equal(config.experimental.clash_api.external_controller, '127.0.0.1:2081');
  assert.equal(config.log.level, 'warn');
  assert.equal(config.dns.reverse_mapping, false);
  assert.equal(config.route.rules.find(rule => rule.action === 'sniff').timeout, '1s');
  assert.equal(generateRouterConfig(profile()).dns.strategy, 'ipv4_only');
});

test('router preserves desktop DNS settings for UDP, TCP, TLS and HTTPS', () => {
  for (const protocol of ['udp','tcp','tls','https']) {
    const value=profile();
    Object.assign(value.routing,{dnsResolverEnabled:true,dnsProtocol:protocol,dnsServer:protocol==='udp'||protocol==='tcp'?'9.9.9.9':'dns.quad9.net',dnsBootstrap:'9.9.9.9',dnsPath:'/dns-query',dnsTtl:120,enableDiagnostics:true});
    const config=generateRouterConfig(value);
    const dns=config.dns.servers.find(server=>server.tag==='proxy-dns');
    assert.equal(dns.type,protocol);
    assert.equal(dns.detour,'proxy');
    assert.ok(config.dns.rules.some(rule=>rule.rewrite_ttl===120));
    assert.equal(config.log.level,'info');
  }
});

test('router rejects unsupported Windows rules, AWG, text lists and invalid devices', () => {
  assert.throws(() => generateRouterConfig(profile(), { interfaces: ['lo'] }), /LAN/);
  assert.throws(() => generateRouterConfig(profile(), { interfaces: ['br-lan;reboot'] }), /LAN/);
  const applications = profile(); applications.routing.applicationRules = [{ path: 'C:\\test.exe' }];
  assert.throws(() => generateRouterConfig(applications), /Windows/);
  const awg = profile(); awg.tunnels[0].type = 'awg';
  assert.throws(() => generateRouterConfig(awg), /AmneziaWG/);
  const remote = profile(); remote.routing.remoteLists = [{ url: 'https://example.org/list.txt', enabled: true }];
  assert.throws(() => generateRouterConfig(remote), /\.srs/);
});

test('FakeIP uses common domain rules before sniffing and keeps ordinary DNS direct', () => {
  const value = profile();
  Object.assign(value.routing, { dnsResolverEnabled: true, dnsProtocol: 'https', dnsServer: 'dns.google', dnsBootstrap: '8.8.8.8', dnsTtl: 120, presetIds: ['discord'] });
  for (const ipv6 of [false, true]) {
    const config = generateRouterConfig(value, { dnsMode: 'fakeip', ipv6, disableQuic: true, downloadListsViaProxy: true });
    const direct = config.dns.servers.find(s => s.tag === 'direct-dns');
    assert.equal(direct.server, 'dns.google');
    assert.equal(direct.detour, undefined);
    assert.equal(config.dns.final, 'direct-dns');
    assert.equal(config.dns.reverse_mapping, false);
    const fake = config.dns.servers.find(s => s.type === 'fakeip');
    assert.equal(fake.inet4_range, '198.18.0.0/15');
    assert.equal(!!fake.inet6_range, ipv6);
    const a = config.dns.rules.find(r => r.domain_suffix && r.server === 'fake-dns');
    assert.deepEqual(a.domain_suffix, ['example.org']);
    assert.equal(a.rewrite_ttl, 120);
    assert.deepEqual(a.query_type, ipv6 ? ['A', 'AAAA'] : ['A']);
    assert.ok(config.dns.rules.some(r => r.rule_set?.includes('preset-discord') && r.server === 'fake-dns'));
    const empty = config.dns.rules.find(r => r.domain_suffix && r.action === 'predefined');
    assert.deepEqual(empty.query_type, ipv6 ? ['HTTPS', 'SVCB'] : ['HTTPS', 'SVCB', 'AAAA']);
    assert.equal(empty.rcode, 'NOERROR');
    const route = config.route.rules.findIndex(r => r.domain_suffix);
    assert.ok(route < config.route.rules.findIndex(r => r.action === 'sniff'));
    assert.equal(config.route.final, 'direct');
    assert.equal(config.experimental.cache_file.store_fakeip, true);
    assert.equal(config.experimental.cache_file.path, '/var/run/obhod/dns-cache.db');
    assert.ok(config.route.rules.some(r => r.action === 'reject' && r.port === 443 && r.network === 'udp'));
    assert.ok(config.route.rule_set.every(r => r.download_detour === 'proxy'));
  }
});

test('legacy DNS options cannot disable FakeIP', () => {
  assert.ok(generateRouterConfig(profile(), { dnsMode: 'realip' }).dns.servers.some(s => s.type === 'fakeip'));
});

test('LuCI shares the real parser and generator without a Node.js runtime', () => {
  class BaseClass {}
  BaseClass.extend = (methods) => {
    class Derived extends BaseClass {}
    Object.assign(Derived.prototype, methods);
    return Derived;
  };
  const Core = new Function('baseclass', buildCore())(BaseClass);
  assert.equal(typeof Core, 'function');
  assert.ok(Core.prototype instanceof BaseClass, 'LuCI requires a baseclass constructor');
  const core = new Core();
  const parsed = core.parseUri(link);
  assert.equal(parsed.name, 'Router');
  const subscription = core.parseSubscription(Buffer.from(`${link}\n${link}`).toString('base64'));
  assert.equal(core.mergeSubscription([], subscription).tunnels.length, 1);
  const value = profile();
  assert.deepEqual(core.generate(value, { interfaces: ['br-lan'] }), generateRouterConfig(value, { interfaces: ['br-lan'] }));
  const stored = fs.readFileSync(path.join(__dirname, '../openwrt/luci-app-obhod/htdocs/luci-static/resources/obhod/core.js'), 'utf8');
  assert.equal(stored.replace(/\r\n/g, '\n'), buildCore());
});

test('sing-box accepts the router DNS, LAN interception and failover configuration', {
  skip: !fs.existsSync(path.join(__dirname, '../windows/runtime/sing-box.exe'))
}, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-openwrt-config-'));
  try {
    const file = path.join(directory, 'config.json');
    for (const dnsMode of [undefined, 'realip']) {
    const config = generateRouterConfig(profile(), { ipv6: true, dnsMode, disableQuic: true });
    // Windows cannot initialize Linux nftables. Linux validation is run separately.
    if (process.platform === 'win32') delete config.inbounds.find((inbound) => inbound.type === 'tun').auto_redirect;
    fs.writeFileSync(file, JSON.stringify(config));
    const result = spawnSync(path.join(__dirname, '../windows/runtime/sing-box.exe'), ['check', '-c', file], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
