const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUpstream, normalizeDnsPool } = require('../openwrt/lib/dns-pool');
const { defaultRouterProfile, generateRouterConfig } = require('../openwrt/lib/config');
const { parseProxyUri } = require('../shared/profile');
const { buildCore } = require('../scripts/build-openwrt-core');

function profile() {
  const p = defaultRouterProfile();
  p.tunnels = [parseProxyUri('socks5://192.0.2.10:1080')];
  p.routing.activeTunnelId = p.tunnels[0].id;
  p.routing.dnsResolverEnabled = true;
  p.routing.localLists = [{ id: 'test', name: 'Test', enabled: true, domains: ['selected.example'], cidrs: [] }];
  return p;
}
const options = { dnsPoolMode: 'parallel', dnsUpstreams: ['https://1.1.1.1/dns-query', 'tls://dns.google'], dnsBootstrapServers: ['8.8.8.8', '1.1.1.1'] };

test('DNS pool accepts mixed transports, custom ports, IPv6 and provider DoH paths', () => {
  assert.deepEqual(parseUpstream('1.1.1.1'), { protocol: 'udp', server: '1.1.1.1', port: 53, path: '' });
  assert.deepEqual(parseUpstream('https://resolver.example:8443/p2?profile=example'), { protocol: 'https', server: 'resolver.example', port: 8443, path: '/p2?profile=example' });
  assert.equal(parseUpstream('tls://dns.example').port, 853);
  assert.equal(parseUpstream('tcp://192.0.2.10:5353').port, 5353);
  assert.equal(parseUpstream('2606:4700:4700::1111').server, '2606:4700:4700::1111');
});

test('DNS pool rejects invalid endpoints, credentials, loops and duplicate-only groups', () => {
  for (const value of ['https://user:secret@resolver.example/dns-query', 'file:///etc/passwd', 'tls://dns.example/path', 'udp://127.0.0.1:1053', 'tcp://127.0.0.1:12053', 'https://resolver.example/#token', 'udp://192.0.2.1:0']) {
    assert.throws(() => parseUpstream(value));
  }
  assert.throws(() => normalizeDnsPool({ ...options, dnsUpstreams: ['1.1.1.1', 'udp://1.1.1.1:53'] }, profile().routing), /двух/);
  assert.throws(() => normalizeDnsPool({ ...options, dnsBootstrapServers: ['dns.example'] }, profile().routing), /IP/);
  assert.throws(() => normalizeDnsPool({ ...options, dnsBootstrapServers: ['::ffff:127.0.0.1'] }, profile().routing), /IP/);
  assert.throws(() => normalizeDnsPool({ ...options, dnsUpstreams: Array.from({ length: 5 }, (_, i) => `192.0.2.${i + 1}`) }, profile().routing), /четырёх/);
});

test('DNS pool keeps real proxy DNS on the selected route and bootstrap outside it', () => {
  const p = profile(), config = generateRouterConfig(p, options);
  const proxy = config.dns.servers.filter(s => s.tag.startsWith('dns-upstream-proxy-'));
  assert.equal(proxy.length, 2);
  assert.ok(proxy.every(s => s.detour === `tunnel-${p.routing.activeTunnelId}`));
  assert.ok(config.dns.servers.filter(s => s.tag.startsWith('dns-upstream-direct-') || s.tag.startsWith('dns-upstream-bootstrap-')).every(s => !s.detour));
  const groupedProxy = config.dns.servers.find(s => s.tag === 'proxy-dns');
  assert.deepEqual(groupedProxy, { tag: 'proxy-dns', type: 'udp', server: '127.0.0.1', server_port: 1154 });
  assert.equal(config.dns.servers.find(s => s.tag === 'bootstrap-dns').server_port, 1155);
  assert.equal(proxy.find(s => s.type === 'tls').domain_resolver.server, 'bootstrap-dns');
});

test('DNS pool leaf requests bypass FakeIP while client domain rules retain it', () => {
  const config = generateRouterConfig(profile(), options);
  const leaves = config.inbounds.filter(i => i.tag.startsWith('dns-leaf-'));
  assert.equal(leaves.length, 4);
  assert.ok(leaves.every(i => i.listen === '127.0.0.1'));
  assert.equal(new Set(leaves.map(i => i.listen_port)).size, leaves.length);
  assert.deepEqual(config.route.rules[0], { inbound: leaves.map(i => i.tag), action: 'hijack-dns' });
  assert.ok(config.dns.rules.slice(0, leaves.length).every(r => r.inbound?.length === 1 && r.server.startsWith('dns-upstream-')));
  assert.ok(config.dns.rules.some(r => r.domain_suffix?.includes('selected.example') && r.server === 'fake-dns'));
  assert.ok(config.dns.rules.some(r => r.domain_suffix?.includes('selected.example') && !r.query_type && r.server === 'proxy-dns'));
  assert.equal(config.experimental.cache_file.store_fakeip, true);
});

test('IP-only DNS upstreams skip bootstrap while legacy single DNS stays unchanged', () => {
  const p = profile();
  const grouped = generateRouterConfig(p, { ...options, dnsUpstreams: ['https://76.76.2.11/p2', 'https://76.76.10.11/p2'] });
  assert.ok(!grouped.inbounds.some(i => i.tag.startsWith('dns-leaf-bootstrap')));
  assert.ok(grouped.dns.servers.filter(s => /^dns-upstream-(direct|proxy)-/.test(s.tag)).every(s => !s.domain_resolver && s.path === '/p2'));
  assert.deepEqual(generateRouterConfig(p), generateRouterConfig(p, { ...options, dnsPoolMode: 'single' }));
  p.routing.dnsResolverEnabled = false;
  assert.ok(!generateRouterConfig(p, options).inbounds.some(i => i.tag.startsWith('dns-leaf-')));
});

test('cold-start infrastructure DNS is independent and list downloads keep their selected route', () => {
  const p = profile();
  p.routing.remoteLists = [{ id: 'cold', name: 'Cold', kind: 'domains', enabled: true, url: 'https://lists.example/rules.json' }];
  const config = generateRouterConfig(p, options);
  assert.equal(config.route.rule_set[0].download_detour, 'dns-infrastructure');
  assert.equal(config.outbounds.find(o => o.tag === 'dns-infrastructure').domain_resolver.server, 'bootstrap-dns');
  assert.equal(config.outbounds.find(o => o.tag === 'direct').domain_resolver.server, 'direct-dns');
  const viaProxy = generateRouterConfig(p, { ...options, downloadListsViaProxy: true });
  assert.equal(viaProxy.route.rule_set[0].download_detour, `tunnel-${p.routing.activeTunnelId}`);
});

test('DNS pool rejects collisions with the configured local proxy port', () => {
  const p = profile(); p.routing.listenPort = 1153;
  assert.throws(() => generateRouterConfig(p, options), /порт/);
});

test('DNS pool parser and graph are identical in Node and the LuCI bundle', () => {
  const baseclass = { extend: value => value };
  const core = new Function('baseclass', buildCore())(baseclass);
  const p = profile();
  assert.deepEqual(core.generate(p, options).dns, generateRouterConfig(p, options).dns);
});
