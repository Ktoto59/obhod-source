// SPDX-License-Identifier: Apache-2.0
import { readfile, writefile } from 'fs';
import { bootstrapEndpoints, dnsHost, dohTransport } from './bootstrap-doh.uc';

let request = json(readfile(ARGV[0]));
let input = type(request?.settings) == 'string' && length(request.settings) <= 12288 ? json(request.settings) : null;
if (type(input?.bootstrap) != 'array' || type(input?.upstreams) != 'array' || length(input.upstreams) > 4)
    die('Invalid DNS check request');
let directory = ARGV[1], first = int(ARGV[2]), upstreamMode = ARGV[3] == 'upstream';
let running = json(readfile('/var/run/obhod/config.json') || '{}');
let tun = filter(running.inbounds || [], item => item.type == 'tun')[0];
let mark = tun?.auto_redirect_output_mark || 0x2024;
let boot = bootstrapEndpoints(input.bootstrap);
let config = { log: { level: 'info' }, inbounds: [], outbounds: [{ type: 'direct', tag: 'direct' }],
    dns: { servers: [], rules: [], strategy: 'ipv4_only' }, route: { rules: [], final: 'direct' } };
let tests = [];
function add(kind, number, server) {
    let tag = 'dns-' + length(tests), inbound = 'check-' + length(tests), port = first + length(tests);
    server.tag = tag;
    server.routing_mark = mark;
    push(config.dns.servers, server);
    push(config.inbounds, { type: 'direct', tag: inbound, listen: '127.0.0.1', listen_port: port });
    push(config.route.rules, { inbound: [inbound], action: 'hijack-dns' });
    push(config.dns.rules, { inbound: [inbound], action: 'route', server: tag, disable_cache: true });
    push(tests, { kind, number, port });
    return tag;
}
let resolver = 'dns-0';
if (upstreamMode) {
    resolver = 'test-bootstrap';
    let server = dohTransport(resolver, boot[int(ARGV[4]) - 1] || boot[0]);
    server.routing_mark = mark;
    push(config.dns.servers, server);
} else {
    for (let i, endpoint in boot) add('bootstrap', i + 1, dohTransport('', endpoint));
}
for (let i, url in input.upstreams) {
    let parts = type(url) == 'string' &&
        match(url, /^(https|tls):\/\/(\[[a-fA-F0-9:.]+\]|[a-zA-Z0-9.-]+)(:([0-9]{1,5}))?(\/[^[:space:]#\\]*)?$/);
    if (!parts || length(parts[5] || '') > 1025 ||
        index(replace(parts[5] || '', /%[a-fA-F0-9]{2}/g, ''), '%') >= 0) die('Invalid encrypted upstream');
    let protocol = parts[1], host = lc(replace(parts[2], /^\[|\]$/g, ''));
    let port = int(parts[4] || (protocol == 'tls' ? 853 : 443));
    if ((!iptoarr(host) && !dnsHost(host)) || port < 1 || port > 65535 || port == 53 ||
        (protocol == 'tls' && parts[5] && parts[5] != '/')) die('Invalid encrypted upstream');
    let path = parts[5] && parts[5] != '/' ? parts[5] : '/dns-query';
    let server = { type: protocol, server: host, server_port: port, tls: { enabled: true, server_name: host } };
    if (!iptoarr(host)) server.domain_resolver = { server: resolver, strategy: 'ipv4_only' };
    if (protocol == 'https') {
        server.path = path;
        if (port == 443 && path == '/dns-query' && index(['1.1.1.1','1.0.0.1','8.8.8.8','8.8.4.4'],host) >= 0)
            server = dohTransport('', bootstrapEndpoints([host])[0]);
    }
    if (upstreamMode) add('upstream', i + 1, server);
}
config.dns.final = resolver;
config.route.default_domain_resolver = { server: resolver, strategy: 'ipv4_only' };
if (!writefile(directory + '/config.json', sprintf('%J\n', config)) ||
    !writefile(directory + '/tests.json', sprintf('%J\n', tests))) die('Cannot write DNS check configuration');
