const net = require('node:net');

const POOLS = Object.freeze({ direct: 1153, proxy: 1154, bootstrap: 1155 });
const LEAF_PORT = 12053;
function localAddress(ip) {
  return /^127\./.test(ip) || ['::1', '0.0.0.0', '::'].includes(ip) || /^::ffff:7f[0-9a-f]{2}:/i.test(ip);
}

function entries(value) {
  if (typeof value === 'string') {
    if (value.length > 16384) throw new Error('Список DNS слишком большой.');
    value = value.split(/\r?\n/);
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(v => String(v).trim()).filter(Boolean))];
}

function parseUpstream(value) {
  if (value.length > 2048 || /[\x00-\x20]/.test(value)) throw new Error('Адрес DNS содержит пробелы или слишком длинный.');
  let url;
  try {
    const text = net.isIP(value) === 6 ? `udp://[${value}]` : /^[a-z]+:\/\//i.test(value) ? value : `udp://${value}`;
    url = new URL(text);
  } catch (_) { throw new Error('Неверный адрес DNS. Используйте IP, udp://, tcp://, tls:// или https://.'); }
  const protocol = url.protocol.slice(0, -1);
  if (!['udp', 'tcp', 'tls', 'https'].includes(protocol) || url.username || url.password || url.hash) {
    throw new Error('DNS поддерживает UDP, TCP, TLS и HTTPS без логина, пароля и фрагмента URL.');
  }
  const server = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number(url.port || (protocol === 'https' ? 443 : protocol === 'tls' ? 853 : 53));
  if (!server || (!net.isIP(server) && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]+\.?$/i.test(server)) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Укажите корректное имя или IP и порт DNS-сервера.');
  }
  if (protocol !== 'https' && ((url.pathname && url.pathname !== '/') || url.search)) {
    throw new Error('Путь и параметры URL доступны только для DNS over HTTPS.');
  }
  if (localAddress(server) &&
      ([53, 1053, ...Object.values(POOLS)].includes(port) || (port >= LEAF_PORT && port < LEAF_PORT + 12))) {
    throw new Error('Этот локальный адрес создаёт петлю DNS. Укажите вышестоящий DNS-сервер.');
  }
  return { protocol, server, port, path: protocol === 'https' ? (url.pathname === '/' ? '/dns-query' : url.pathname) + url.search : '' };
}

function normalizeDnsPool(options, routing) {
  const mode = options.dnsPoolMode || 'single';
  if (!['single', 'parallel', 'balanced'].includes(mode)) throw new Error('Выберите режим опроса DNS.');
  if (mode === 'single' || !routing.dnsResolverEnabled) return null;
  const list = entries(options.dnsUpstreams).map(parseUpstream);
  const upstreams = [...new Map(list.map(v => [JSON.stringify(v), v])).values()];
  if (upstreams.length < 2 || upstreams.length > 4) throw new Error('Для группы укажите от двух до четырёх разных DNS-серверов.');
  let bootstrap = entries(options.dnsBootstrapServers || routing.dnsBootstrap);
  try { bootstrap = [...new Set(bootstrap.map(ip => net.isIP(ip) === 6 ? new URL(`http://[${ip}]`).hostname.replace(/^\[|\]$/g, '') : ip))]; }
  catch (_) { throw new Error('Bootstrap: укажите IP-адреса без имени интерфейса.'); }
  if (!bootstrap.length || bootstrap.length > 4 || bootstrap.some(ip => !net.isIP(ip) || localAddress(ip))) {
    throw new Error('Bootstrap: укажите от одного до четырёх IP-адресов, по одному в строке.');
  }
  return { mode, upstreams, bootstrap };
}

function configureDnsPool(config, profile, options) {
  const pool = normalizeDnsPool(options, profile.routing);
  if (!pool) return;
  if (config.inbounds.some(i => Object.values(POOLS).includes(i.listen_port) || (i.listen_port >= LEAF_PORT && i.listen_port < LEAF_PORT + 12))) {
    throw new Error('Локальный порт прокси занят группой DNS. Выберите другой порт прокси.');
  }
  const proxyTag = profile.routing.failoverEnabled ? 'proxy' : `tunnel-${profile.routing.activeTunnelId.replace(/[^a-z0-9_-]/gi, '_')}`;
  const servers = config.dns.servers.filter(s => !['direct-dns', 'proxy-dns', 'bootstrap-dns'].includes(s.tag));
  const rules = [], inbounds = [];
  function leaf(group, index, upstream) {
    const tag = `dns-upstream-${group}-${index}`, inbound = `dns-leaf-${group}-${index}`;
    const offset = group === 'direct' ? 0 : group === 'proxy' ? 4 : 8;
    const dns = { tag, type: upstream.protocol, server: upstream.server, server_port: upstream.port,
      ...(group === 'proxy' ? { detour: proxyTag } : {}) };
    if (!net.isIP(upstream.server)) dns.domain_resolver = { server: 'bootstrap-dns', strategy: 'ipv4_only' };
    if (['https', 'tls'].includes(upstream.protocol)) {
      dns.tls = { enabled: true, ...(!net.isIP(upstream.server) ? { server_name: upstream.server } : {}) };
    }
    if (upstream.protocol === 'https') dns.path = upstream.path;
    servers.push(dns);
    inbounds.push({ type: 'direct', tag: inbound, listen: '127.0.0.1', listen_port: LEAF_PORT + offset + index });
    rules.push({ inbound: [inbound], action: 'route', server: tag, disable_cache: true });
  }
  for (const group of ['direct', 'proxy']) {
    servers.push({ tag: `${group}-dns`, type: 'udp', server: '127.0.0.1', server_port: POOLS[group] });
    pool.upstreams.forEach((upstream, index) => leaf(group, index, upstream));
  }
  if (pool.bootstrap.length === 1) servers.push({ tag: 'bootstrap-dns', type: 'udp', server: pool.bootstrap[0] });
  else {
    servers.push({ tag: 'bootstrap-dns', type: 'udp', server: '127.0.0.1', server_port: POOLS.bootstrap });
    pool.bootstrap.forEach((ip, index) => servers.push({ tag: `dns-upstream-bootstrap-${index}`, type: 'udp', server: ip, server_port: 53 }));
  }
  // Infrastructure resolution must work before sing-box opens its inbounds.
  // Client/direct resolution continues to use the encrypted upstream pool.
  config.route.default_domain_resolver = { server: 'bootstrap-dns', strategy: 'ipv4_only' };
  for (const outbound of [...config.outbounds, ...config.endpoints]) {
    if (outbound.tag === 'direct') outbound.domain_resolver = { server: 'direct-dns', strategy: 'ipv4_only' };
    else if (outbound.domain_resolver) outbound.domain_resolver.server = 'bootstrap-dns';
  }
  config.outbounds.push({ type: 'direct', tag: 'dns-infrastructure', domain_resolver: { server: 'bootstrap-dns', strategy: 'ipv4_only' } });
  for (const set of config.route.rule_set) if (set.type === 'remote' && !options.downloadListsViaProxy) set.download_detour = 'dns-infrastructure';
  config.dns.servers = servers;
  config.dns.rules.unshift(...rules);
  config.inbounds.push(...inbounds);
  config.route.rules.unshift({ inbound: inbounds.map(i => i.tag), action: 'hijack-dns' });
}

module.exports = { configureDnsPool, normalizeDnsPool, parseUpstream, POOLS, LEAF_PORT };
