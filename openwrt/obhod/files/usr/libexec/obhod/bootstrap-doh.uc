// SPDX-License-Identifier: Apache-2.0
export const bootstrapPorts = [12061, 12062, 12063, 12064, 12067, 12068, 12069, 12070];
const defaults = ['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4'];
const providers = {
    '1.1.1.1': ['cloudflare-dns.com', '/dns-query'],
    '1.0.0.1': ['cloudflare-dns.com', '/dns-query'],
    '8.8.8.8': ['dns.google', '/dns-query'],
    '8.8.4.4': ['dns.google', '/dns-query'],
    '9.9.9.9': ['dns.quad9.net', '/dns-query'],
    '9.9.9.10': ['dns10.quad9.net', '/dns-query'],
    '94.140.14.14': ['dns.adguard-dns.com', '/dns-query'],
    '76.76.2.0': ['freedns.controld.com', '/p0', '76.76.2.11'],
    '76.76.2.2': ['freedns.controld.com', '/p2', '76.76.2.11']
};

export function dnsHost(host) {
    return length(host) <= 253 && !!match(host,
        /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i);
};

export function bootstrapEndpoints(entries) {
    if (type(entries) == 'string') entries = split(entries, /\r?\n/);
    if (entries == null) entries = [];
    if (type(entries) != 'array' || length(entries) > 32) die('Invalid Bootstrap DoH list');
    let result = [], seen = {};
    for (let value in entries) {
        if (type(value) != 'string') die('Invalid Bootstrap DoH server');
        let line = trim(value);
        if (!line) continue;
        let item;
        if (line in providers) {
            item = { host: providers[line][0], path: providers[line][1], ip: providers[line][2] || line, port: 443 };
        } else {
            let parts = match(line, /^https:\/\/([a-z0-9.-]+)(:([0-9]{1,5}))?(\/[^[:space:]#\\]*)?[[:space:]]+@[[:space:]]+([^[:space:]]+)$/i);
            let port = parts ? int(parts[3] || 443) : 0;
            if (!parts || !dnsHost(parts[1]) || iptoarr(parts[1]) || !iptoarr(parts[5]) ||
                port < 1 || port > 65535 || port == 53 || length(parts[4] || '') > 1025 ||
                index(replace(parts[4] || '', /%[a-fA-F0-9]{2}/g, ''), '%') >= 0) die('Invalid Bootstrap DoH server');
            item = { host: lc(parts[1]), path: parts[4] || '/dns-query', ip: arrtoip(iptoarr(parts[5])), port };
        }
        let key = sprintf('%J', item);
        if (!seen[key]) { seen[key] = true; push(result, item); }
    }
    if (length(result) > length(bootstrapPorts)) die('Too many Bootstrap DoH servers');
    return length(result) ? result : map(defaults, ip => ({ host: providers[ip][0], path: '/dns-query', ip, port: 443 }));
};

export function savedBootstrap(settings) {
    let routing = settings.profile?.routing || {};
    if (settings.options?.bootstrapDoH != null) return bootstrapEndpoints(settings.options.bootstrapDoH);
    let legacy = settings.options?.dnsBootstrapServers || routing.dnsBootstrapServers || routing.dnsBootstrap || [];
    if (type(legacy) == 'string') legacy = split(legacy, /[[:space:],]+/);
    if (type(legacy) != 'array') legacy = [];
    // Old plaintext entries have no authenticated hostname unless they match a preset.
    let compatible = filter(legacy, ip => ip in providers);
    let ordered = [];
    for (let ip in [...compatible, ...defaults])
        if (index(ordered, ip) < 0 && length(ordered) < 4) push(ordered, ip);
    return bootstrapEndpoints(ordered);
};

export function dohTransport(tag, endpoint, detour) {
    let authority = endpoint.host + (endpoint.port == 443 ? '' : ':' + endpoint.port);
    return { tag, type: 'https', server: endpoint.ip, server_port: endpoint.port, path: endpoint.path,
        headers: { Host: authority }, tls: { enabled: true, server_name: endpoint.host },
        ...(detour ? { detour } : {}) };
};
