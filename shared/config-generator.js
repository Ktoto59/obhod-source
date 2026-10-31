const { validateConfig } = require('./profile');
const net = require('node:net');

const PRESET_BASE = 'https://github.com/itdoginfo/allow-domains/releases/latest/download';

function tunnelTag(tunnel) { return `tunnel-${tunnel.id.replace(/[^a-z0-9_-]/gi, '_')}`; }

function isWireGuardFamily(tunnel) { return ['wireguard', 'awg'].includes(tunnel.type); }

function makeWireGuardEndpoint(tunnel, tag = 'proxy') {
  const ipv4Only = tunnel.networkFamily !== 'dual';
  const addresses = ipv4Only ? tunnel.addresses.filter((value) => !value.includes(':')) : tunnel.addresses;
  const allowedIps = ipv4Only ? tunnel.allowedIps.filter((value) => !value.includes(':')) : tunnel.allowedIps;
  if (!addresses.length) throw new Error('Для режима IPv4 у туннеля должен быть IPv4-адрес интерфейса.');
  if (!allowedIps.length) throw new Error('Для режима IPv4 в Allowed IPs должна быть IPv4-подсеть.');
  const peer = {
    address: tunnel.endpointHost,
    port: tunnel.endpointPort,
    public_key: tunnel.peerPublicKey,
    allowed_ips: allowedIps,
    persistent_keepalive_interval: tunnel.keepalive
  };
  if (tunnel.preSharedKey) peer.pre_shared_key = tunnel.preSharedKey;
  return {
    type: 'wireguard', tag, system: false, mtu: tunnel.mtu,
    address: addresses, private_key: tunnel.privateKey, peers: [peer],
    domain_resolver: { server: 'direct-dns', strategy: ipv4Only ? 'ipv4_only' : 'prefer_ipv4' },
    ...(ipv4Only ? { inet4_bind_address: '0.0.0.0' } : {})
  };
}

function makeTransport(tunnel) {
  if (tunnel.transportType === 'ws') {
    const transport = { type: 'ws', path: tunnel.transportPath || '/' };
    if (tunnel.transportHost) transport.headers = { Host: tunnel.transportHost };
    return transport;
  }
  if (tunnel.transportType === 'grpc') return { type: 'grpc', service_name: tunnel.transportPath };
  if (tunnel.transportType === 'http') {
    return { type: 'http', path: tunnel.transportPath || '/', host: tunnel.transportHost ? [tunnel.transportHost] : [] };
  }
  return null;
}

function makeTls(tunnel) {
  if (['shadowsocks', 'socks5'].includes(tunnel.type) || !tunnel.tlsEnabled) return null;
  const tls = { enabled: true, server_name: tunnel.serverName || tunnel.server, insecure: tunnel.insecure };
  if (tunnel.fingerprint && !['hysteria2', 'tuic', 'http'].includes(tunnel.type)) {
    tls.utls = { enabled: true, fingerprint: tunnel.fingerprint };
  }
  if (tunnel.realityEnabled) {
    tls.reality = { enabled: true, public_key: tunnel.realityPublicKey, short_id: tunnel.realityShortId };
  }
  return tls;
}

function makeProxyOutbound(tunnel, tag) {
  const base = {
    type: tunnel.type === 'socks5' ? 'socks' : tunnel.type, tag, server: tunnel.server, server_port: tunnel.serverPort,
    domain_resolver: { server: 'direct-dns', strategy: 'ipv4_only' }
  };
  if (['socks5', 'http'].includes(tunnel.type)) {
    if (tunnel.username) base.username = tunnel.username;
    if (tunnel.password) base.password = tunnel.password;
    if (tunnel.type === 'socks5') base.version = '5';
  } else if (tunnel.type === 'vless') {
    base.uuid = tunnel.uuid;
    if (tunnel.flow) base.flow = tunnel.flow;
  } else if (tunnel.type === 'shadowsocks') {
    base.method = tunnel.method;
    base.password = tunnel.password;
  } else if (tunnel.type === 'trojan') base.password = tunnel.password;
  else if (tunnel.type === 'hysteria2') {
    base.password = tunnel.password;
    if (tunnel.upMbps) base.up_mbps = tunnel.upMbps;
    if (tunnel.downMbps) base.down_mbps = tunnel.downMbps;
    if (tunnel.obfsType !== 'none') base.obfs = { type: tunnel.obfsType, password: tunnel.obfsPassword };
  } else if (tunnel.type === 'tuic') {
    base.uuid = tunnel.uuid;
    base.password = tunnel.password;
    base.congestion_control = tunnel.congestionControl;
    base.udp_relay_mode = tunnel.udpRelayMode;
    base.zero_rtt_handshake = tunnel.zeroRttHandshake;
  } else if (tunnel.type === 'anytls') {
    base.password = tunnel.password;
    base.idle_session_check_interval = tunnel.idleSessionCheckInterval;
    base.idle_session_timeout = tunnel.idleSessionTimeout;
    base.min_idle_session = tunnel.minIdleSession;
  }
  const tls = makeTls(tunnel);
  const transport = makeTransport(tunnel);
  if (tls) base.tls = tls;
  if (transport) base.transport = transport;
  return base;
}

function presetRuleSet(id, preparedRuleSets, updateInterval) {
  const prepared = preparedRuleSets.find((item) => item.scope === 'preset' && item.id === id);
  if (prepared) return { type: 'local', tag: `preset-${id}`, format: 'binary', path: prepared.path };
  return {
    type: 'remote', tag: `preset-${id}`, format: 'binary',
    url: `${PRESET_BASE}/${id}.srs`, update_interval: updateInterval
  };
}

function remoteRuleSet(list, preparedRuleSets, updateInterval) {
  const extension = new URL(list.url).pathname.toLowerCase();
  const prepared = preparedRuleSets.find((item) => item.scope === 'remote' && item.id === list.id)
    || preparedRuleSets.find((item) => !item.scope && item.id === list.id);
  if (prepared) {
    return { type: 'local', tag: `remote-${list.id}`, format: prepared.format || 'source', path: prepared.path };
  }
  if (extension.endsWith('.srs')) {
    return { type: 'remote', tag: `remote-${list.id}`, format: 'binary', url: list.url, update_interval: updateInterval };
  }
  if (extension.endsWith('.json')) {
    return { type: 'remote', tag: `remote-${list.id}`, format: 'source', url: list.url, update_interval: updateInterval };
  }
  throw new Error(`Список «${list.name}» нужно загрузить перед запуском.`);
}

function makeAwgEndpoint(tunnel, tag = 'proxy') {
  const ipv4Only = tunnel.networkFamily !== 'dual';
  const addresses = ipv4Only ? tunnel.addresses.filter((value) => !value.includes(':')) : tunnel.addresses;
  const allowedIps = ipv4Only ? tunnel.allowedIps.filter((value) => !value.includes(':')) : tunnel.allowedIps;
  if (!addresses.length) throw new Error('Для режима IPv4 у AWG-туннеля должен быть IPv4-адрес интерфейса.');
  if (!allowedIps.length) throw new Error('Для режима IPv4 в Allowed IPs AWG должна быть IPv4-подсеть.');
  const peer = {
    address: tunnel.endpointHost,
    port: tunnel.endpointPort,
    public_key: tunnel.peerPublicKey,
    allowed_ips: allowedIps,
    persistent_keepalive_interval: tunnel.keepalive
  };
  if (tunnel.preSharedKey) peer.preshared_key = tunnel.preSharedKey;
  return {
    type: 'awg', tag, useIntegratedTun: false, mtu: tunnel.mtu,
    address: addresses, private_key: tunnel.privateKey,
    jc: tunnel.jc, jmin: tunnel.jmin, jmax: tunnel.jmax,
    s1: tunnel.s1, s2: tunnel.s2, s3: tunnel.s3, s4: tunnel.s4,
    h1: tunnel.h1, h2: tunnel.h2, h3: tunnel.h3, h4: tunnel.h4,
    i1: tunnel.i1, i2: tunnel.i2, i3: tunnel.i3, i4: tunnel.i4, i5: tunnel.i5,
    peers: [peer],
    domain_resolver: { server: 'direct-dns', strategy: ipv4Only ? 'ipv4_only' : 'prefer_ipv4' },
    ...(ipv4Only ? { inet4_bind_address: '0.0.0.0' } : {})
  };
}

function makeProxyDnsServer(config, proxyTag, fallbackServer) {
  if (!config.routing.dnsResolverEnabled) {
    return { tag: 'proxy-dns', type: 'udp', server: fallbackServer || '8.8.8.8', detour: proxyTag };
  }
  const server = {
    tag: 'proxy-dns', type: config.routing.dnsProtocol, server: config.routing.dnsServer, detour: proxyTag
  };
  if (!net.isIP(config.routing.dnsServer)) {
    server.domain_resolver = { server: 'bootstrap-dns', strategy: 'ipv4_only' };
  }
  if (config.routing.dnsProtocol === 'tls' || config.routing.dnsProtocol === 'https') {
    server.tls = { enabled: true, ...(!net.isIP(config.routing.dnsServer) ? { server_name: config.routing.dnsServer } : {}) };
  }
  if (config.routing.dnsProtocol === 'https') server.path = config.routing.dnsPath;
  return server;
}

function generateConfig(input) {
  const preparedRuleSets = Array.isArray(input?.preparedRuleSets) ? input.preparedRuleSets : [];
  const controllerPort = Number(input?.routing?.controllerPort);
  const config = validateConfig(input);
  const tunnel = config.tunnels.find((item) => item.id === config.routing.activeTunnelId);
  if (!tunnel) throw new Error('Создайте и выберите подключение.');
  const selectedTunnels = config.routing.failoverEnabled
    ? config.routing.failoverTunnelIds.map((id) => config.tunnels.find((item) => item.id === id)).filter(Boolean)
    : [tunnel];
  const ipv4Only = selectedTunnels.every((item) => !isWireGuardFamily(item) || item.networkFamily !== 'dual');
  const proxyDns = isWireGuardFamily(tunnel)
    ? (ipv4Only ? tunnel.dns.find((value) => !value.includes(':')) : tunnel.dns[0]) : null;
  const proxyTag = config.routing.failoverEnabled ? 'proxy' : tunnelTag(tunnel);
  const enabledApplicationRules = config.routing.trafficMode === 'tun'
    ? config.routing.applicationRules.filter((item) => item.enabled)
    : [];

  const rules = [
    { action: 'sniff' },
    { protocol: 'dns', action: 'hijack-dns' },
    { ip_is_private: true, action: 'route', outbound: 'direct' }
  ];
  for (const applicationRule of enabledApplicationRules) {
    rules.push({
      process_path: [applicationRule.path], action: 'route',
      outbound: applicationRule.action === 'direct' ? 'direct' : proxyTag
    });
  }
  for (const list of config.routing.localLists.filter((item) => item.enabled)) {
    if (list.domains.length) rules.push({ domain_suffix: list.domains, action: 'route', outbound: proxyTag });
    if (list.cidrs.length) rules.push({ ip_cidr: list.cidrs, action: 'route', outbound: proxyTag });
  }

  const presetTags = config.routing.presetIds.map((id) => `preset-${id}`);
  const enabledRemote = config.routing.remoteLists.filter((item) => item.enabled);
  const remoteTags = enabledRemote.map((item) => `remote-${item.id}`);
  if (presetTags.length || remoteTags.length) {
    rules.push({ rule_set: [...presetTags, ...remoteTags], action: 'route', outbound: proxyTag });
  }

  const ruleSets = [
    ...config.routing.presetIds.map((id) => presetRuleSet(id, preparedRuleSets, config.routing.updateInterval)),
    ...enabledRemote.map((list) => remoteRuleSet(list, preparedRuleSets, config.routing.updateInterval))
  ];
  const dnsRouteOptions = config.routing.dnsResolverEnabled ? { rewrite_ttl: config.routing.dnsTtl } : {};
  const dnsRules = enabledApplicationRules.map((applicationRule) => ({
    process_path: [applicationRule.path], action: 'route',
    server: applicationRule.action === 'direct' ? 'direct-dns' : 'proxy-dns',
    ...(applicationRule.action === 'proxy' ? dnsRouteOptions : {})
  }));
  dnsRules.push(...config.routing.localLists
    .filter((item) => item.enabled && item.domains.length)
    .map((item) => ({ domain_suffix: item.domains, action: 'route', server: 'proxy-dns', ...dnsRouteOptions })));
  const dnsRuleSetTags = [...presetTags, ...enabledRemote.filter((item) => item.kind === 'domains').map((item) => `remote-${item.id}`)];
  if (dnsRuleSetTags.length) dnsRules.push({ rule_set: dnsRuleSetTags, action: 'route', server: 'proxy-dns', ...dnsRouteOptions });

  const inbounds = [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: config.routing.listenPort }];
  if (config.routing.trafficMode === 'tun') {
    inbounds.unshift({
      type: 'tun', tag: 'tun-in', interface_name: 'obhod-tun',
      address: ['172.19.0.1/30'], mtu: 1500, stack: 'mixed',
      auto_route: true, strict_route: config.routing.strictRoute
    });
  }

  return {
    log: { level: config.routing.enableDiagnostics ? 'info' : 'error', timestamp: true },
    ...(Number.isInteger(controllerPort) ? {
      experimental: { clash_api: { external_controller: `127.0.0.1:${controllerPort}` } }
    } : {}),
    dns: {
      servers: [
        { tag: 'direct-dns', type: 'https', server: '1.1.1.1' },
        ...(config.routing.dnsResolverEnabled ? [{ tag: 'bootstrap-dns', type: 'udp', server: config.routing.dnsBootstrap }] : []),
        makeProxyDnsServer(config, proxyTag, proxyDns)
      ],
      rules: dnsRules,
      final: 'direct-dns'
    },
    inbounds,
    endpoints: selectedTunnels.filter(isWireGuardFamily).map((item) => (item.type === 'awg'
      ? makeAwgEndpoint(item, tunnelTag(item))
      : makeWireGuardEndpoint(item, tunnelTag(item)))),
    outbounds: [
      { type: 'direct', tag: 'direct' },
      ...selectedTunnels.filter((item) => !isWireGuardFamily(item)).map((item) => makeProxyOutbound(item, tunnelTag(item))),
      ...(config.routing.failoverEnabled ? [{
        type: 'urltest', tag: 'proxy', outbounds: selectedTunnels.map(tunnelTag),
        url: config.routing.testUrl, interval: config.routing.failoverInterval,
        tolerance: config.routing.failoverTolerance,
        idle_timeout: '24h', interrupt_exist_connections: false
      }] : [])
    ],
    route: {
      rules, rule_set: ruleSets, final: 'direct', auto_detect_interface: true,
      default_domain_resolver: { server: 'direct-dns', strategy: ipv4Only ? 'ipv4_only' : 'prefer_ipv4' }
    }
  };
}

function stringifyConfig(config, redact = false) {
  const result = generateConfig(config);
  if (redact) {
    for (const endpoint of result.endpoints || []) {
      endpoint.private_key = '••••••••';
      if (endpoint.peers?.[0]?.pre_shared_key) endpoint.peers[0].pre_shared_key = '••••••••';
      if (endpoint.peers?.[0]?.preshared_key) endpoint.peers[0].preshared_key = '••••••••';
    }
    for (const outbound of result.outbounds || []) {
      if (outbound.password) outbound.password = '••••••••';
      if (outbound.username) outbound.username = '••••••••';
      if (outbound.uuid) outbound.uuid = '••••••••';
      if (outbound.obfs?.password) outbound.obfs.password = '••••••••';
    }
  }
  return JSON.stringify(result, null, 2);
}

module.exports = { generateConfig, stringifyConfig, makeAwgEndpoint, makeWireGuardEndpoint, tunnelTag };
