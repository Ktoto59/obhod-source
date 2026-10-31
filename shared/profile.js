const { randomUUID } = require('node:crypto');
const path = require('node:path');

const PODKOP_PRESETS = Object.freeze({
  russia_inside: 'Россия: доступ изнутри', russia_outside: 'Россия: доступ снаружи',
  geoblock: 'Geo Block', block: 'Заблокированные сайты', youtube: 'YouTube',
  discord: 'Discord', meta: 'Meta / Instagram', twitter: 'Twitter / X',
  telegram: 'Telegram', cloudflare: 'Cloudflare', google_ai: 'Google AI',
  google_meet: 'Google Meet', google_play: 'Google Play', tiktok: 'TikTok',
  anime: 'Anime', news: 'Новости', hdrezka: 'HDRezka', porn: 'Adult',
  roblox: 'Roblox', hodca: 'H.O.D.C.A.', hetzner: 'Hetzner ASN', ovh: 'OVH ASN',
  digitalocean: 'DigitalOcean ASN', cloudfront: 'CloudFront ASN', ukraine_inside: 'Украина'
});

const REGIONAL_PRESETS = Object.freeze(['russia_inside', 'russia_outside', 'ukraine_inside']);
const ALLOWED_WITH_RUSSIA_INSIDE = Object.freeze([
  'russia_inside', 'meta', 'twitter', 'discord', 'telegram', 'cloudflare',
  'google_ai', 'google_play', 'hetzner', 'ovh', 'hodca', 'roblox',
  'digitalocean', 'cloudfront'
]);

const DEFAULT_DOMAINS = [
  'microsoft.com', 'live.com', 'xbox.com', 'steampowered.com', 'bing.com',
  'spaceengineersgame.com', 'githubusercontent.com', 'windows.com', 'powdertoy.co.uk'
];

const DEFAULT_CONFIG = Object.freeze({
  version: 6,
  tunnels: [],
  routing: {
    activeTunnelId: null,
    failoverEnabled: false,
    failoverTunnelIds: [],
    failoverInterval: '15s',
    failoverTolerance: 80,
    testUrl: 'https://www.gstatic.com/generate_204',
    dnsResolverEnabled: false,
    dnsProtocol: 'tls',
    dnsServer: 'one.one.one.one',
    dnsBootstrap: '1.1.1.1',
    dnsPath: '/dns-query',
    dnsTtl: 60,
    presetIds: ['discord', 'meta', 'russia_inside', 'telegram', 'google_ai'],
    localLists: [{ id: 'local-default', name: 'Мои домены', enabled: true, domains: DEFAULT_DOMAINS, cidrs: [] }],
    remoteLists: [],
    applicationRules: [],
    listenPort: 2080,
    trafficMode: 'tun',
    enableSystemProxy: false,
    strictRoute: true,
    enableDiagnostics: false,
    onboardingCompleted: false,
    launchAtLogin: false,
    startOnLaunch: false,
    autoCheckUpdates: true,
    dismissedUpdateVersion: '',
    updateInterval: '12h'
  }
});

function normalizePresetIds(value) {
  let ids = [...new Set(Array.isArray(value) ? value : DEFAULT_CONFIG.routing.presetIds)]
    .filter((id) => Object.hasOwn(PODKOP_PRESETS, id));
  const selectedRegion = ids.find((id) => REGIONAL_PRESETS.includes(id));
  if (selectedRegion) ids = ids.filter((id) => !REGIONAL_PRESETS.includes(id) || id === selectedRegion);
  if (selectedRegion === 'russia_inside') ids = ids.filter((id) => ALLOWED_WITH_RUSSIA_INSIDE.includes(id));
  return ids;
}

function normalizeLines(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/)
    .map((line) => line.replace(/\s*\/\/.*$/, ''))
    .join(' ').split(/[,\s]+/);
  return [...new Set(source.map((item) => String(item).trim().toLowerCase())
    .filter((item) => item && !item.startsWith('//'))) ].sort();
}

function parseIniConfig(text) {
  const sections = [];
  let current = null;
  for (const original of String(text).split(/\r?\n/)) {
    const line = original.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = line.match(/^\[([^\]]+)]$/);
    if (section) {
      current = { name: section[1].toLowerCase(), values: {} };
      sections.push(current);
      continue;
    }
    const separator = line.indexOf('=');
    if (!current || separator < 1) continue;
    current.values[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return sections;
}

function parseEndpoint(value) {
  const match = value.match(/^\[([^\]]+)]:(\d+)$/) || value.match(/^(.+):(\d+)$/);
  if (!match) throw new Error('В Endpoint должен быть указан адрес и порт.');
  return { host: match[1], port: Number(match[2]) };
}

const AWG_NUMBER_FIELDS = ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4'];
const AWG_HEADER_FIELDS = ['h1', 'h2', 'h3', 'h4'];
const AWG_SIGNATURE_FIELDS = ['i1', 'i2', 'i3', 'i4', 'i5'];
const AWG_FIELDS = [...AWG_NUMBER_FIELDS, ...AWG_HEADER_FIELDS, ...AWG_SIGNATURE_FIELDS];

function normalizeAwgHeader(value, field) {
  const text = String(value || '').trim();
  if (!text) return '';
  const match = text.match(/^(\d+)(?:-(\d+))?$/);
  if (!match) throw new Error(`${field.toUpperCase()} должен быть числом или диапазоном вида 100-200.`);
  const start = Number(match[1]);
  const end = Number(match[2] || match[1]);
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end > 0xffffffff || start > end) {
    throw new Error(`Некорректное значение ${field.toUpperCase()} в параметрах AWG.`);
  }
  return match[2] ? `${start}-${end}` : String(start);
}

function normalizeAwgSignature(value, field) {
  const text = String(value || '').trim();
  if (text.length > 2048 || /[\r\n]/.test(text)) throw new Error(`Некорректная сигнатура ${field.toUpperCase()} в параметрах AWG.`);
  return text;
}

function parseWireGuardConfig(text, name = 'WireGuard') {
  const sections = parseIniConfig(text);
  const iface = sections.find((item) => item.name === 'interface')?.values;
  const peer = sections.find((item) => item.name === 'peer')?.values;
  if (!iface?.privatekey || !iface?.address || !peer?.publickey || !peer?.endpoint) {
    throw new Error('Конфигурация должна содержать PrivateKey, Address, PublicKey и Endpoint.');
  }
  const endpoint = parseEndpoint(peer.endpoint);
  const type = AWG_FIELDS.some((field) => Object.hasOwn(iface, field)) ? 'awg' : 'wireguard';
  return {
    id: randomUUID(), type, name: String(name).replace(/\.conf$/i, '').slice(0, 80) || (type === 'awg' ? 'AmneziaWG' : 'WireGuard'),
    privateKey: iface.privatekey, addresses: normalizeLines(iface.address),
    dns: normalizeLines(iface.dns), mtu: Number(iface.mtu || 1408),
    peerPublicKey: peer.publickey, preSharedKey: peer.presharedkey || '',
    endpointHost: endpoint.host, endpointPort: endpoint.port,
    allowedIps: normalizeLines(peer.allowedips || '0.0.0.0/0, ::/0'),
    keepalive: Number(peer.persistentkeepalive || 25), networkFamily: 'ipv4',
    ...Object.fromEntries(AWG_NUMBER_FIELDS.map((field) => [field, Number(iface[field] || 0)])),
    ...Object.fromEntries(AWG_HEADER_FIELDS.map((field) => [field, String(iface[field] || '')])),
    ...Object.fromEntries(AWG_SIGNATURE_FIELDS.map((field) => [field, String(iface[field] || '')]))
  };
}

function validateTunnel(input = {}) {
  const type = input.type === 'awg' ? 'awg' : 'wireguard';
  const tunnel = {
    id: String(input.id || randomUUID()), type, name: String(input.name || (type === 'awg' ? 'AmneziaWG' : 'WireGuard')).trim().slice(0, 80),
    privateKey: String(input.privateKey || '').trim(), addresses: normalizeLines(input.addresses),
    dns: normalizeLines(input.dns), mtu: Number(input.mtu || 1408),
    peerPublicKey: String(input.peerPublicKey || '').trim(), preSharedKey: String(input.preSharedKey || '').trim(),
    endpointHost: String(input.endpointHost || '').trim(), endpointPort: Number(input.endpointPort || 51820),
    allowedIps: normalizeLines(input.allowedIps || ['0.0.0.0/0', '::/0']), keepalive: Number(input.keepalive ?? 25),
    networkFamily: input.networkFamily === 'dual' ? 'dual' : 'ipv4',
    ...Object.fromEntries(AWG_NUMBER_FIELDS.map((field) => [field, Math.floor(Number(input[field]) || 0)])),
    ...Object.fromEntries(AWG_HEADER_FIELDS.map((field) => [field, normalizeAwgHeader(input[field], field)])),
    ...Object.fromEntries(AWG_SIGNATURE_FIELDS.map((field) => [field, normalizeAwgSignature(input[field], field)]))
  };
  if (!tunnel.name) throw new Error('Укажите название туннеля.');
  if (!tunnel.privateKey || !tunnel.addresses.length || !tunnel.peerPublicKey || !tunnel.endpointHost) {
    throw new Error('Заполните ключи, адрес интерфейса и Endpoint туннеля.');
  }
  if (!Number.isInteger(tunnel.endpointPort) || tunnel.endpointPort < 1 || tunnel.endpointPort > 65535) throw new Error('Некорректный порт Endpoint.');
  if (!Number.isInteger(tunnel.mtu) || tunnel.mtu < 576 || tunnel.mtu > 9000) throw new Error('MTU должен быть от 576 до 9000.');
  if (type === 'awg') {
    if (AWG_NUMBER_FIELDS.some((field) => tunnel[field] < 0 || tunnel[field] > 1500)) {
      throw new Error('Числовые параметры AWG должны быть от 0 до 1500.');
    }
    if (tunnel.jmin > tunnel.jmax) throw new Error('В параметрах AWG значение Jmin не может быть больше Jmax.');
  }
  return tunnel;
}

function decodeBase64(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function parseProxyUri(text, fallbackName = 'Подключение') {
  const raw = String(text).trim();
  if (!/^(vless|trojan|ss|hysteria2|hy2|tuic|anytls|socks5|socks|http|https):\/\//i.test(raw)) {
    throw new Error('Поддерживаются ссылки SOCKS5, HTTP(S), VLESS, Shadowsocks, Trojan, Hysteria2, TUIC и AnyTLS.');
  }
  if (/^ss:\/\//i.test(raw)) {
    const url = new URL(raw);
    let credentials = decodeURIComponent(url.username || '');
    if (!credentials.includes(':')) credentials = decodeBase64(credentials);
    const separator = credentials.indexOf(':');
    if (separator < 1) throw new Error('В Shadowsocks-ссылке не найдены метод и пароль.');
    return validateConnection({
      type: 'shadowsocks', name: decodeURIComponent(url.hash.slice(1)) || fallbackName,
      server: url.hostname, serverPort: Number(url.port), method: credentials.slice(0, separator),
      password: credentials.slice(separator + 1)
    });
  }
  const url = new URL(raw);
  const uriType = url.protocol.slice(0, -1).toLowerCase();
  const type = uriType === 'hy2' ? 'hysteria2' : (['socks', 'socks5'].includes(uriType) ? 'socks5' : (['http', 'https'].includes(uriType) ? 'http' : uriType));
  const defaultPort = type === 'socks5' ? 1080 : (type === 'http' ? (uriType === 'https' ? 443 : 8080) : 443);
  const security = url.searchParams.get('security') || (type === 'trojan' ? 'tls' : 'none');
  const tlsRequired = ['hysteria2', 'tuic', 'anytls'].includes(type);
  const username = decodeURIComponent(url.username || '');
  const password = decodeURIComponent(url.password || '');
  return validateConnection({
    type, name: decodeURIComponent(url.hash.slice(1)) || fallbackName,
    server: url.hostname, serverPort: Number(url.port || defaultPort),
    username: ['socks5', 'http'].includes(type) ? username : '',
    uuid: ['vless', 'tuic'].includes(type) ? username : '',
    password: ['socks5', 'http'].includes(type) ? password : (type === 'tuic' ? password : (type === 'hysteria2' && password ? `${username}:${password}` : (['trojan', 'hysteria2', 'anytls'].includes(type) ? username : ''))),
    flow: url.searchParams.get('flow') || '', tlsEnabled: type === 'http' ? uriType === 'https' : (tlsRequired || security !== 'none'),
    realityEnabled: security === 'reality', serverName: url.searchParams.get('sni') || url.hostname,
    insecure: ['1', 'true'].includes((url.searchParams.get('allowInsecure') || url.searchParams.get('insecure') || '').toLowerCase()),
    fingerprint: url.searchParams.get('fp') || 'chrome',
    realityPublicKey: url.searchParams.get('pbk') || '', realityShortId: url.searchParams.get('sid') || '',
    transportType: url.searchParams.get('type') || 'none',
    transportPath: url.searchParams.get('path') || url.searchParams.get('serviceName') || '',
    transportHost: url.searchParams.get('host') || '',
    obfsType: url.searchParams.get('obfs') || 'none', obfsPassword: url.searchParams.get('obfs-password') || '',
    congestionControl: url.searchParams.get('congestion_control') || url.searchParams.get('congestion-control') || 'cubic',
    udpRelayMode: url.searchParams.get('udp_relay_mode') || url.searchParams.get('udp-relay-mode') || 'native',
    zeroRttHandshake: ['1', 'true'].includes((url.searchParams.get('zero_rtt_handshake') || '').toLowerCase())
  });
}

function validateProxyTunnel(input = {}) {
  const supportedTypes = ['vless', 'shadowsocks', 'trojan', 'hysteria2', 'tuic', 'anytls', 'socks5', 'http'];
  if (!supportedTypes.includes(input.type)) throw new Error(`Неподдерживаемый протокол подключения: ${input.type || 'не указан'}.`);
  const type = input.type;
  const tlsRequired = ['hysteria2', 'tuic', 'anytls'].includes(type);
  if (type === 'hysteria2' && input.obfsType && !['none', 'salamander'].includes(input.obfsType)) {
    throw new Error('Эта версия ядра поддерживает для Hysteria2 только обфускацию Salamander.');
  }
  if (type === 'tuic' && input.congestionControl && !['cubic', 'new_reno', 'bbr'].includes(input.congestionControl)) {
    throw new Error('Некорректный алгоритм контроля перегрузки TUIC.');
  }
  if (type === 'tuic' && input.udpRelayMode && !['native', 'quic'].includes(input.udpRelayMode)) throw new Error('Некорректный режим UDP relay TUIC.');
  const tunnel = {
    id: String(input.id || randomUUID()), type, name: String(input.name || type.toUpperCase()).trim().slice(0, 80),
    server: String(input.server || '').trim(), serverPort: Number(input.serverPort || (type === 'socks5' ? 1080 : (type === 'http' ? 8080 : 443))),
    username: String(input.username || '').trim(), uuid: String(input.uuid || '').trim(), password: String(input.password || ''),
    method: String(input.method || 'chacha20-ietf-poly1305').trim(), flow: String(input.flow || '').trim(),
    tlsEnabled: tlsRequired || input.tlsEnabled === true, realityEnabled: input.realityEnabled === true,
    serverName: String(input.serverName || '').trim(), insecure: input.insecure === true,
    fingerprint: String(input.fingerprint || 'chrome').trim(), realityPublicKey: String(input.realityPublicKey || '').trim(),
    realityShortId: String(input.realityShortId || '').trim(),
    transportType: ['none', 'ws', 'grpc', 'http'].includes(input.transportType) ? input.transportType : 'none',
    transportPath: String(input.transportPath || '').trim(), transportHost: String(input.transportHost || '').trim(),
    obfsType: ['none', 'salamander'].includes(input.obfsType) ? input.obfsType : 'none',
    obfsPassword: String(input.obfsPassword || ''),
    upMbps: Math.max(0, Number(input.upMbps) || 0), downMbps: Math.max(0, Number(input.downMbps) || 0),
    congestionControl: ['cubic', 'new_reno', 'bbr'].includes(input.congestionControl) ? input.congestionControl : 'cubic',
    udpRelayMode: ['native', 'quic'].includes(input.udpRelayMode) ? input.udpRelayMode : 'native',
    zeroRttHandshake: input.zeroRttHandshake === true,
    idleSessionCheckInterval: String(input.idleSessionCheckInterval || '30s').trim(),
    idleSessionTimeout: String(input.idleSessionTimeout || '30s').trim(),
    minIdleSession: Math.max(0, Math.floor(Number(input.minIdleSession) || 0))
  };
  if (!tunnel.name) throw new Error('Укажите название подключения.');
  if (!tunnel.server) throw new Error('Укажите адрес сервера подключения.');
  if (!Number.isInteger(tunnel.serverPort) || tunnel.serverPort < 1 || tunnel.serverPort > 65535) throw new Error('Некорректный порт сервера.');
  if (['vless', 'tuic'].includes(type) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tunnel.uuid)) {
    throw new Error(`Укажите корректный UUID для ${type === 'tuic' ? 'TUIC' : 'VLESS'}.`);
  }
  if (['trojan', 'shadowsocks', 'hysteria2', 'tuic', 'anytls'].includes(type) && !tunnel.password) throw new Error('Укажите пароль подключения.');
  if (type === 'hysteria2' && tunnel.obfsType !== 'none' && !tunnel.obfsPassword) throw new Error('Укажите пароль обфускации Hysteria2.');
  if (type === 'hysteria2' && (![tunnel.upMbps, tunnel.downMbps].every(Number.isFinite) || tunnel.upMbps > 100000 || tunnel.downMbps > 100000)) {
    throw new Error('Скорость Hysteria2 должна быть от 0 до 100000 Мбит/с.');
  }
  if (tlsRequired && !tunnel.serverName && !tunnel.insecure) tunnel.serverName = tunnel.server;
  if (type === 'anytls' && (!/^\d+(?:ns|us|ms|s|m|h)$/.test(tunnel.idleSessionCheckInterval) || !/^\d+(?:ns|us|ms|s|m|h)$/.test(tunnel.idleSessionTimeout))) {
    throw new Error('Интервалы AnyTLS должны быть указаны как 30s, 1m или 1h.');
  }
  if (tunnel.realityEnabled && !tunnel.realityPublicKey) throw new Error('Для Reality нужен публичный ключ сервера.');
  return tunnel;
}

function validateConnection(input = {}) {
  return input.type && !['wireguard', 'awg'].includes(input.type) ? validateProxyTunnel(input) : validateTunnel(input);
}

function validateLocalList(input = {}) {
  const list = {
    id: String(input.id || randomUUID()), name: String(input.name || 'Локальный список').trim().slice(0, 80),
    enabled: input.enabled !== false, domains: normalizeLines(input.domains), cidrs: normalizeLines(input.cidrs)
  };
  if (!list.name) throw new Error('Укажите название локального списка.');
  if (list.domains.some((value) => !/^\.?[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/i.test(value))) throw new Error(`Некорректный домен в списке «${list.name}».`);
  if (list.cidrs.some((value) => !/^[0-9a-f:.]+(?:\/\d{1,3})?$/i.test(value))) throw new Error(`Некорректная подсеть в списке «${list.name}».`);
  return list;
}

function validateRemoteList(input = {}) {
  const url = String(input.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('URL внешнего списка должен начинаться с http:// или https://.');
  return {
    id: String(input.id || randomUUID()), name: String(input.name || 'Онлайн-список').trim().slice(0, 80),
    enabled: input.enabled !== false, url, kind: input.kind === 'cidrs' ? 'cidrs' : 'domains'
  };
}

function validateApplicationRule(input = {}) {
  const rawPath = String(input.path || '').trim();
  if (rawPath.length > 1024) throw new Error('Путь к приложению слишком длинный.');
  const applicationPath = path.win32.normalize(rawPath.replace(/\//g, '\\'));
  if (!path.win32.isAbsolute(applicationPath) || !/\.exe$/i.test(applicationPath) || /[\r\n\0]/.test(applicationPath)) {
    throw new Error('Выберите корректный исполняемый файл .exe.');
  }
  if (input.action && !['proxy', 'direct'].includes(input.action)) throw new Error('Некорректное действие правила приложения.');
  return {
    id: String(input.id || randomUUID()),
    name: String(input.name || path.win32.basename(applicationPath, '.exe')).trim().slice(0, 80) || path.win32.basename(applicationPath),
    path: applicationPath,
    action: input.action === 'direct' ? 'direct' : 'proxy',
    ...(input.needsReview === true ? { needsReview: true } : {}),
    enabled: input.enabled !== false
  };
}

function validateConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const routingInput = source.routing || {};
  const tunnels = (Array.isArray(source.tunnels) ? source.tunnels : []).map(validateConnection);
  const legacyTrafficMode = routingInput.enableSystemProxy === false ? 'local-proxy' : 'system-proxy';
  const trafficMode = ['tun', 'system-proxy', 'local-proxy'].includes(routingInput.trafficMode)
    ? routingInput.trafficMode : legacyTrafficMode;
  const routing = {
    activeTunnelId: routingInput.activeTunnelId ? String(routingInput.activeTunnelId) : null,
    failoverEnabled: routingInput.failoverEnabled === true,
    failoverTunnelIds: [...new Set(Array.isArray(routingInput.failoverTunnelIds) ? routingInput.failoverTunnelIds.map(String) : [])],
    failoverInterval: ['10s', '15s', '30s', '1m', '3m', '5m', '10m', '15m'].includes(routingInput.failoverInterval) ? routingInput.failoverInterval : '15s',
    failoverTolerance: [20, 50, 80].includes(Number(routingInput.failoverTolerance))
      ? Number(routingInput.failoverTolerance) : 80,
    testUrl: /^https?:\/\//i.test(String(routingInput.testUrl || '')) ? String(routingInput.testUrl) : 'https://www.gstatic.com/generate_204',
    dnsResolverEnabled: routingInput.dnsResolverEnabled === true,
    dnsProtocol: ['udp', 'tcp', 'tls', 'https'].includes(routingInput.dnsProtocol) ? routingInput.dnsProtocol : 'tls',
    dnsServer: String(routingInput.dnsServer || 'one.one.one.one').trim().slice(0, 253),
    dnsBootstrap: String(routingInput.dnsBootstrap || '1.1.1.1').trim().slice(0, 253),
    dnsPath: String(routingInput.dnsPath || '/dns-query').trim().slice(0, 200),
    dnsTtl: Number.isInteger(Number(routingInput.dnsTtl)) && Number(routingInput.dnsTtl) >= 1 && Number(routingInput.dnsTtl) <= 86400
      ? Number(routingInput.dnsTtl) : 60,
    presetIds: normalizePresetIds(routingInput.presetIds),
    localLists: (Array.isArray(routingInput.localLists) ? routingInput.localLists : DEFAULT_CONFIG.routing.localLists).map(validateLocalList),
    remoteLists: (Array.isArray(routingInput.remoteLists) ? routingInput.remoteLists : []).map(validateRemoteList),
    applicationRules: (Array.isArray(routingInput.applicationRules) ? routingInput.applicationRules : []).map(validateApplicationRule),
    listenPort: Number(routingInput.listenPort || 2080),
    trafficMode,
    enableSystemProxy: trafficMode === 'system-proxy',
    strictRoute: routingInput.strictRoute !== false,
    enableDiagnostics: routingInput.enableDiagnostics === true,
    onboardingCompleted: routingInput.onboardingCompleted === true,
    launchAtLogin: routingInput.launchAtLogin === true,
    startOnLaunch: routingInput.startOnLaunch === true,
    autoCheckUpdates: routingInput.autoCheckUpdates !== false,
    dismissedUpdateVersion: String(routingInput.dismissedUpdateVersion || '').trim().slice(0, 40),
    updateInterval: ['1h', '6h', '12h', '24h'].includes(routingInput.updateInterval) ? routingInput.updateInterval : '12h'
  };
  if (routing.activeTunnelId && !tunnels.some((item) => item.id === routing.activeTunnelId)) routing.activeTunnelId = tunnels[0]?.id || null;
  if (!routing.activeTunnelId && tunnels.length) routing.activeTunnelId = tunnels[0].id;
  routing.failoverTunnelIds = routing.failoverTunnelIds.filter((id) => tunnels.some((item) => item.id === id));
  routing.applicationRules = routing.applicationRules.filter((rule, index, rules) =>
    rules.findIndex((candidate) => candidate.path.toLowerCase() === rule.path.toLowerCase()) === index);
  if (routing.failoverEnabled && routing.failoverTunnelIds.length < 2) routing.failoverEnabled = false;
  if (!Number.isInteger(routing.listenPort) || routing.listenPort < 1024 || routing.listenPort > 65535) throw new Error('Локальный порт должен быть от 1024 до 65535.');
  if (!/^[a-z0-9_.:-]+$/i.test(routing.dnsServer)) throw new Error('Укажите корректный адрес DNS-сервера.');
  if (!/^[a-z0-9_.:-]+$/i.test(routing.dnsBootstrap)) throw new Error('Укажите корректный адрес bootstrap DNS-сервера.');
  if (!routing.dnsPath.startsWith('/')) throw new Error('Путь DoH должен начинаться с /.');
  return { version: 6, tunnels, routing };
}

module.exports = {
  DEFAULT_CONFIG, PODKOP_PRESETS, ALLOWED_WITH_RUSSIA_INSIDE, normalizePresetIds,
  normalizeLines, parseIniConfig, parseWireGuardConfig, parseProxyUri, validateTunnel, validateConnection,
  validateApplicationRule, validateConfig
};
