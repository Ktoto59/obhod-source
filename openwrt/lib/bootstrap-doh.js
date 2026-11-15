const { isIP } = require('node:net');

const BOOTSTRAP_PORTS = [12061, 12062, 12063, 12064, 12067, 12068, 12069, 12070];
const DEFAULTS = ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4'];
const PROVIDERS = {
  '1.1.1.1': ['cloudflare-dns.com', '/dns-query'],
  '1.0.0.1': ['cloudflare-dns.com', '/dns-query'],
  '8.8.8.8': ['dns.google', '/dns-query'],
  '8.8.4.4': ['dns.google', '/dns-query'],
  '9.9.9.9': ['dns.quad9.net', '/dns-query'],
  '9.9.9.10': ['dns10.quad9.net', '/dns-query'],
  '94.140.14.14': ['dns.adguard-dns.com', '/dns-query'],
  '76.76.2.0': ['freedns.controld.com', '/p0'],
  '76.76.2.2': ['freedns.controld.com', '/p2'],
  'dns.google': ['dns.google', '/dns-query']
};

function legacyDoH(address) {
  return Object.hasOwn(PROVIDERS, address) ? PROVIDERS[address] : PROVIDERS['1.1.1.1'];
}

function bootstrapAddresses(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  const result = [];
  for (const item of entries) {
    const line = String(item).trim();
    if (!line) continue;
    if (isIP(line) && Object.hasOwn(PROVIDERS, line)) {
      result.push(line);
      continue;
    }
    const parts = /^https:\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?(\/[^\s#\\]{0,1024})?\s+@\s+(\S+)$/i.exec(line);
    if (!parts || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(parts[1]) ||
        parts[1].length > 253 || isIP(parts[1]) || !isIP(parts[4]) ||
        (parts[3] && /%(?![0-9a-f]{2})/i.test(parts[3])) ||
        (parts[2] && (Number(parts[2]) < 1 || Number(parts[2]) > 65535 || Number(parts[2]) === 53))) {
      throw new Error('Bootstrap DoH: укажите известный IP или HTTPS-адрес с закреплённым IP, например https://dns.quad9.net/dns-query @ 9.9.9.9.');
    }
    result.push(line);
  }
  const unique = [...new Set(result)];
  if (unique.length > BOOTSTRAP_PORTS.length) throw new Error('Bootstrap DoH: укажите до восьми серверов.');
  return unique.length ? unique : [...DEFAULTS];
}

function legacyBootstrapAddresses(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
  return [...new Set([...values.filter(value => isIP(value) && Object.hasOwn(PROVIDERS, value)), ...DEFAULTS])].slice(0, 4);
}

module.exports = { BOOTSTRAP_PORTS, bootstrapAddresses, legacyBootstrapAddresses, legacyDoH };
