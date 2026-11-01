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
  config.route.rules.splice(config.route.rules.findIndex(rule => rule.action === 'sniff'), 0, ...early);
}

function defaultRouterProfile() {
  const profile = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  profile.routing.localLists = [];
  profile.routing.presetIds = [];
  return profile;
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
  Object.assign(tun, { auto_redirect: true, stack: 'system', include_interface: interfaces });
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
  if (options.disableQuic === true) config.route.rules.splice(1, 0, { network: 'udp', port: 443, action: 'reject' });
  if (options.downloadListsViaProxy === true) {
    const proxyTag = profile.routing.failoverEnabled ? 'proxy' : tunnelTag({ id: profile.routing.activeTunnelId });
    for (const list of config.route.rule_set) if (list.type === 'remote') list.download_detour = proxyTag;
  }
  // Keep the router's default interface detection and the direct final route.
  return config;
}

module.exports = { defaultRouterProfile, generateRouterConfig };
