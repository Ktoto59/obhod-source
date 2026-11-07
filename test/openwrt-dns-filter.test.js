const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProxyUri } = require('../shared/profile');
const { defaultRouterProfile, generateRouterConfig } = require('../openwrt/lib/config');

function profile(enabled = true) {
  const value = defaultRouterProfile();
  value.tunnels = [parseProxyUri('vless://11111111-1111-4111-8111-111111111111@192.0.2.10:443?security=tls&sni=example.com#Fixture')];
  Object.assign(value.routing, { activeTunnelId: value.tunnels[0].id, dnsResolverEnabled: enabled,
    dnsProtocol: 'https', dnsServer: 'dns.example.com', dnsBootstrap: '192.0.2.53',
    localLists: [{ id: 'selected', name: 'Selected', enabled: true, domains: ['selected.example.com'], cidrs: [] }] });
  return value;
}

test('configured DNS filters selected names before native FakeIP without resolving VLESS destinations to IPs', () => {
  const config = generateRouterConfig(profile());
  const gate = config.dns.servers.find(s => s.tag === 'filtered-fake-dns');
  assert.deepEqual(gate, { type: 'udp', tag: 'filtered-fake-dns', server: '127.0.0.1', server_port: 1156 });
  assert.ok(config.dns.servers.some(s => s.type === 'fakeip' && s.tag === 'fake-dns'));
  const selected = config.dns.rules.find(r => r.domain_suffix && r.query_type?.includes('A'));
  assert.equal(selected.server, 'filtered-fake-dns');
  assert.equal(selected.disable_cache, true, 'outer cache must not bypass the policy gate or cache a FakeIP as a real address');
  for (const [tag, port, server] of [['dns-filter-real-in', 12065, 'proxy-dns'], ['dns-filter-fake-in', 12066, 'fake-dns']]) {
    assert.deepEqual(config.inbounds.find(i => i.tag === tag), { type: 'direct', tag, listen: '127.0.0.1', listen_port: port });
    assert.deepEqual(config.dns.rules.find(r => r.inbound?.includes(tag)), { inbound: [tag], action: 'route', server });
    assert.ok(config.route.rules.findIndex(r => r.action === 'hijack-dns' && r.inbound?.includes(tag)) < config.route.rules.findIndex(r => r.domain_suffix));
  }
  assert.equal(config.dns.rules.find(r => r.domain?.includes('fakeip-check.obhod.example.com') && r.query_type?.includes('A')).server, 'fake-dns', 'synthetic health probe must not query public DNS');
  assert.ok(!config.route.rules.some(r => r.action === 'resolve'), 'VLESS must keep its original domain destination');
  assert.equal(config.dns.final, 'direct-dns');
  assert.equal(config.experimental.cache_file.store_fakeip, true);
});

test('filtering applies to both selected domains and rule sets in single and pool configurations', () => {
  for (const ipv6 of [false, true]) for (const dnsPoolMode of ['single', 'fallback', 'balanced', 'parallel']) {
    const value = profile(); value.routing.presetIds = ['discord'];
    const config = generateRouterConfig(value, { ipv6, dnsPoolMode,
      dnsUpstreams: ['https://dns.example.com/dns-query', 'tls://backup.example.com'], dnsBootstrapServers: ['192.0.2.53'] });
    const selected = config.dns.rules.filter(r => r.server === 'filtered-fake-dns');
    assert.equal(selected.length, 2);
    assert.ok(selected.some(r => r.rule_set?.includes('preset-discord')));
    assert.ok(selected.every(r => r.disable_cache && r.query_type.includes('A') && r.query_type.includes('AAAA') === ipv6));
    assert.ok(config.dns.rules.some(r => r.rule_set?.includes('preset-discord') && r.server === 'proxy-dns' && !r.query_type));
    assert.ok(config.dns.rules.slice(0, 2).every(r => r.inbound?.[0].startsWith('dns-filter-')));
  }
});

test('filter helper reserves its loopback ports only when custom DNS is enabled', () => {
  for (const port of [1156, 12065, 12066]) {
    const value = profile(); value.routing.listenPort = port;
    assert.throws(() => generateRouterConfig(value), /проверкой DNS/);
    value.routing.dnsResolverEnabled = false;
    const config = generateRouterConfig(value);
    assert.ok(!config.inbounds.some(i => i.tag.startsWith('dns-filter-')));
    assert.ok(!config.dns.servers.some(s => s.tag === 'filtered-fake-dns'));
  }
});
