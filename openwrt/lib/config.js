const { DEFAULT_CONFIG, validateConfig } = require('../../shared/profile');
const { generateConfig, tunnelTag } = require('../../shared/config-generator');
const { configureDnsPool } = require('./dns-pool');

function configureFakeIp(config, profile, options) {
  const selectedDns = config.dns.rules.filter(rule => rule.server === 'proxy-dns').map(rule => {
    const match = { ...rule }; delete match.action; delete match.server; delete match.rewrite_ttl; return match;
  });
  const direct = profile.routing.dnsResolverEnabled
    ? { ...config.dns.servers.find(server => server.tag === 'proxy-dns'), tag: 'direct-dns' }
    : { type: 'udp', tag: 'direct-dns', server: '1.1.1.1' };
  delete direct.detour;
  config.dns.servers = [direct, ...config.dns.servers.filter(server => server.tag !== 'direct-dns')];
  config.dns.servers.push({ type: 'fakeip', tag: 'fake-dns', inet4_range: '198.18.0.0/15', ...(options.ipv6 === true ? { inet6_range: '2001:2::/48' } : {}) });
  const fakeMatches = [{ domain: ['fakeip-check.obhod.example.com'] }, ...selectedDns];
  config.dns.rules = [
    ...fakeMatches.map(match => ({ ...match, query_type: ['HTTPS', 'SVCB', ...(options.ipv6 === true ? [] : ['AAAA'])], action: 'predefined', rcode: 'NOERROR' })),
    ...fakeMatches.map(match => ({ ...match, query_type: options.ipv6 === true ? ['A', 'AAAA'] : ['A'], action: 'route', server: 'fake-dns', rewrite_ttl: profile.routing.dnsTtl })),
    ...selectedDns.map(match => ({ ...match, action: 'route', server: 'proxy-dns', rewrite_ttl: profile.routing.dnsTtl }))
  ];
  config.dns.reverse_mapping = false;
  config.dns.independent_cache = true;
  config.experimental.cache_file = { enabled: true, path: '/var/run/obhod/dns-cache.db', store_fakeip: true };
  // FakeIP restores the original name before routing. Use it before sniffing,
  // so ECH, delayed ClientHello or a shared CDN IP cannot replace that identity.
  const earlyRoutes = config.route.rules.filter(rule => rule.action === 'route' && (rule.domain_suffix || rule.rule_set));
  const early = earlyRoutes.flatMap(rule => {
    if (!config.endpoints.length) return [{ ...rule }];
    const resolve = { ...rule, action: 'resolve', server: 'proxy-dns' };
    delete resolve.outbound;
    return [resolve, { ...rule }];
  });
  const ipRoutes = config.route.rules.filter(rule => rule.action === 'route' && rule.ip_cidr);
  if (ipRoutes.length) {
    // Preserve the private-address policy before explicit CIDRs, while routing
    // server-first TCP and non-DNS UDP without waiting for a sniff timeout.
    early.push(...config.route.rules.filter(rule => rule.ip_is_private && rule.outbound === 'direct').map(rule => ({ ...rule })));
    early.push(...ipRoutes.map(rule => ({ ...rule })));
  }
  config.route.rules.splice(config.route.rules.findIndex(rule => rule.action === 'sniff'), 0, ...early);
  // Sniff can add a domain, so domain/rule-set matches need a second pass.
  // It does not change the destination IP. Identical terminal IP/private rules
  // which already ran before sniff cannot match for the first time afterwards.
  const terminalIps = new Set();
  config.route.rules = config.route.rules.filter(rule => {
    if (rule.action !== 'route' || !(rule.ip_cidr || rule.ip_is_private)) return true;
    const key = JSON.stringify(rule);
    if (terminalIps.has(key)) return false;
    terminalIps.add(key); return true;
  });
}

function defaultRouterProfile() {
  const profile = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  profile.routing.localLists = [];
  profile.routing.presetIds = [];
  return profile;
}

function configureKernelRouting(config) {
  const tun = config.inbounds.find(inbound => inbound.type === 'tun');
  const addresses = config.dns.servers.filter(server => server.type === 'fakeip')
    .flatMap(server => [server.inet4_range, server.inet6_range].filter(Boolean));
  const sets = [];
  for (const rule of config.route.rules) {
    if (rule.action !== 'route' || rule.outbound === 'direct') continue;
    addresses.push(...(rule.ip_cidr || []));
    sets.push(...(rule.rule_set || []));
  }
  // One union is essential: route_address and route_address_set are intersected
  // by auto_redirect. Keep FakeIP present even when no subnet list is selected.
  config.route.rule_set.push({ type: 'inline', tag: 'obhod-selected-addresses',
    rules: [{ ip_cidr: [...new Set(addresses)] }] });
  tun.route_address_set = ['obhod-selected-addresses', ...new Set(sets)];
  // Disabling IPv6 proxying must not install a global IPv6 unreachable rule.
  tun.strict_route = false;
}

function configureFilteredFakeIp(config, profile) {
  if (!profile.routing.dnsResolverEnabled) return;
  const ports = [1156, 12065, 12066];
  if (config.inbounds.some(inbound => ports.includes(inbound.listen_port))) {
    throw new Error('Локальный порт прокси занят проверкой DNS. Выберите другой порт прокси.');
  }
  // Keep the native FakeIP store and the original name sent to the proxy.
  // The bounded helper checks the real resolver first, then asks this store
  // for a FakeIP only when the requested address was actually permitted.
  config.dns.servers.push({ type: 'udp', tag: 'filtered-fake-dns', server: '127.0.0.1', server_port: 1156 });
  for (const rule of config.dns.rules) {
    if (rule.server !== 'fake-dns' || !(rule.domain_suffix || rule.rule_set)) continue;
    rule.server = 'filtered-fake-dns';
    rule.disable_cache = true;
  }
  const leaves = [
    { tag: 'dns-filter-real-in', port: 12065, server: 'proxy-dns' },
    { tag: 'dns-filter-fake-in', port: 12066, server: 'fake-dns' }
  ];
  config.inbounds.push(...leaves.map(leaf => ({ type: 'direct', tag: leaf.tag, listen: '127.0.0.1', listen_port: leaf.port })));
  config.dns.rules.unshift(...leaves.map(leaf => ({ inbound: [leaf.tag], action: 'route', server: leaf.server })));
  config.route.rules.unshift({ inbound: leaves.map(leaf => leaf.tag), action: 'hijack-dns' });
}

function generateRouterConfig(input, options = {}) {
  if (input.tunnels?.some((tunnel) => tunnel.type === 'awg')) {
    throw new Error('AmneziaWG требует отдельного совместимого ядра и пока недоступен в пакете OpenWrt.');
  }
  if (input.routing?.applicationRules?.length) throw new Error('Правила программ Windows не применяются на роутере.');
  if (input.routing?.remoteLists?.some((list) => list.enabled !== false && !/\.(srs|json)$/i.test(new URL(list.url).pathname))) {
    throw new Error('На роутере внешние списки должны быть в формате .srs или .json.');
  }
  const interfaces = [...new Set(options.interfaces || ['br-lan'])];
  if (!interfaces.length || interfaces.some((value) => !/^[a-zA-Z0-9_.-]{1,15}$/.test(value) || value === 'lo')) {
    throw new Error('Укажите LAN-устройства Linux, например br-lan.');
  }
  const profile = validateConfig({ ...input, routing: { ...input.routing, trafficMode: 'tun', applicationRules: [] } });
  const config = generateConfig(profile);
  const tun = config.inbounds.find((inbound) => inbound.type === 'tun');
  // lo enables the native output chains too: router tools receive FakeIP from
  // dnsmasq just like LAN clients. The same positive set keeps other output direct.
  Object.assign(tun, { auto_redirect: true, stack: 'system', include_interface: [...interfaces, 'lo'] });
  if (options.ipv6 === true) tun.address.push('fdfe:dcba:9876::1/126');
  config.dns.strategy = options.ipv6 === true ? 'prefer_ipv4' : 'ipv4_only';
  config.dns.reverse_mapping = true;
  config.log = { level: profile.routing.enableDiagnostics ? 'info' : 'warn', timestamp: true };
  // The service adds a random secret to the runtime copy before starting.
  config.experimental = { clash_api: { external_controller: '127.0.0.1:2081' } };
  // dnsmasq keeps answering local names and forwards upstream requests here.
  config.inbounds.push({ type: 'direct', tag: 'dns-in', listen: '127.0.0.1', listen_port: 1053 });
  config.route.rules.unshift({ inbound: ['dns-in'], action: 'hijack-dns' });
  // The router owns LAN DNS, including TCP and requests to a stale TUN DNS IP.
  // Other UDP ports must never inherit a DNS-session routing decision.
  config.route.rules.splice(1, 0, { inbound: ['tun-in'], network: ['tcp', 'udp'], port: 53, action: 'hijack-dns' });
  config.route.rules = config.route.rules.filter(rule => !(rule.protocol === 'dns' && rule.action === 'hijack-dns'));
  // Wi-Fi clients can send ClientHello after the default 300 ms window.
  // A missed name would send a selected domain to the direct final route.
  for (const rule of config.route.rules) if (rule.action === 'sniff') rule.timeout = '1s';
  configureFakeIp(config, profile, options);
  configureDnsPool(config, profile, options);
  configureFilteredFakeIp(config, profile);
  configureKernelRouting(config);
  if (options.disableQuic === true) config.route.rules.splice(1, 0, { network: 'udp', port: 443, action: 'reject' });
  if (options.downloadListsViaProxy === true) {
    const proxyTag = profile.routing.failoverEnabled ? 'proxy' : tunnelTag({ id: profile.routing.activeTunnelId });
    for (const list of config.route.rule_set) if (list.type === 'remote') list.download_detour = proxyTag;
  }
  // Keep the router's default interface detection and the direct final route.
  return config;
}

module.exports = { defaultRouterProfile, generateRouterConfig };
