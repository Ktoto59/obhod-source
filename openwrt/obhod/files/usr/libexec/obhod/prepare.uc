// SPDX-License-Identifier: Apache-2.0
import { readfile, writefile } from 'fs';
import { bootstrapPorts, savedBootstrap, dohTransport } from './bootstrap-doh.uc';
let root = ARGV[2] || '/var/run/obhod';
let settings = json(readfile(ARGV[1] || '/etc/obhod/settings.json'));
if (type(settings?.profile?.routing) != 'object' || type(settings?.config?.route?.rules) != 'array' ||
    type(settings?.config?.dns?.servers) != 'array' || type(settings?.config?.inbounds) != 'array')
    die('Invalid saved configuration graph');
let config = settings.config;

function migrateExperimental115(graph) {
    delete graph.dns.independent_cache;
    for (let inbound in graph.inbounds || [])
        if (inbound.type == 'tun') delete inbound.stack;
    for (let set in graph.route.rule_set || []) {
        if (set.type != 'remote') continue;
        if (set.http_client && set.download_detour) die('Conflicting rule set HTTP options');
        if (!set.http_client) {
            let outbound = filter(graph.outbounds || [], o => o.tag == set.download_detour)[0];
            if (set.download_detour && !(outbound?.type == 'direct' && length(keys(outbound)) == 2))
                set.http_client = { detour: set.download_detour };
            else
                set.http_client = { domain_resolver: outbound?.domain_resolver ||
                    graph.route.default_domain_resolver || graph.dns.final };
        }
        delete set.download_detour;
    }
}

let routing = settings.profile.routing;
let bootstrap = { '1.1.1.1': 'cloudflare-dns.com', '1.0.0.1': 'cloudflare-dns.com',
    '8.8.8.8': 'dns.google', '8.8.4.4': 'dns.google' };
let defaults = keys(bootstrap);
let migrated = { '9.9.9.9': ['dns.quad9.net', '/dns-query'], '9.9.9.10': ['dns10.quad9.net', '/dns-query'],
    '94.140.14.14': ['dns.adguard-dns.com', '/dns-query'], '76.76.2.0': ['freedns.controld.com', '/p0'],
    '76.76.2.2': ['freedns.controld.com', '/p2'], 'dns.google': ['dns.google', '/dns-query'] };
let bootstrapServers = savedBootstrap(settings);
function pinned(tag, ip, detour) {
    return dohTransport(tag, { host: bootstrap[ip], ip, path: '/dns-query', port: 443 }, detour);
}
let resolver = { server: 'bootstrap-dns', strategy: 'ipv4_only' };
// Migrate the saved DNS graph in RAM before checking or starting either core.
config.dns.servers = filter(config.dns.servers, s => s.tag != 'bootstrap-dns' && index(s.tag || '', 'dns-upstream-bootstrap-') != 0);
let ports = { 'direct-dns': 1153, 'proxy-dns': 1154, 'filtered-fake-dns': 1156 };
config.dns.servers = map(config.dns.servers, s => {
    if (s.type == 'fakeip') return s;
    if (s.type == 'udp' && s.server == '127.0.0.1' && ports[s.tag] == s.server_port &&
        s.server_port && !s.detour) return s;
    if (s.type == 'udp' || s.type == 'tcp') {
        let proxy = s.tag == 'proxy-dns' || index(s.tag, 'dns-upstream-proxy-') == 0;
        if (!proxy && s.tag != 'direct-dns' && index(s.tag, 'dns-upstream-direct-') != 0) die('Unexpected plaintext DNS transport');
        let replacement = migrated[s.server];
        if (replacement && routing.dnsResolverEnabled) return { tag: s.tag, type: 'https', server: replacement[0],
            path: replacement[1], tls: { enabled: true, server_name: replacement[0] }, domain_resolver: resolver,
            ...(s.detour ? { detour: s.detour } : {}) };
        if (!routing.dnsResolverEnabled) return pinned(s.tag, proxy ? '8.8.8.8' : '1.1.1.1', s.detour);
        let ip = index(defaults, s.server) >= 0 ? s.server : (proxy ? '8.8.8.8' : '1.1.1.1');
        return pinned(s.tag, ip, s.detour);
    }
    if (s.type != 'https' && s.type != 'tls') die('Unexpected DNS transport');
    if (s.tls?.insecure || s.tls?.disable_sni || s.server_port == 53) die('Invalid encrypted DNS transport');
    if (s.type == 'https' && index(defaults, s.server) >= 0 &&
        (!s.server_port || s.server_port == 443) && (!s.path || s.path == '/dns-query')) return pinned(s.tag, s.server, s.detour);
    s.tls ||= {};
    s.tls.enabled = true;
    if (!match(s.server || '', /^[0-9]+(\.[0-9]+){3}$/) && index(s.server || '', ':') < 0)
        s.domain_resolver = resolver;
    else delete s.domain_resolver;
    return s;
});
push(config.dns.servers, { tag: 'bootstrap-dns', type: 'tcp', server: '127.0.0.1', server_port: 1155 });
config.dns.independent_cache = true;
config.dns.final = 'direct-dns';
config.route.default_domain_resolver = { server: 'direct-dns', strategy: settings.options?.ipv6 ? 'prefer_ipv4' : 'ipv4_only' };
for (let item in [...config.outbounds, ...(config.endpoints || [])]) {
    if (item.tag == 'direct') item.domain_resolver = config.route.default_domain_resolver;
    else if (item.server || item.peers || item.tag == 'dns-infrastructure') {
        item.domain_resolver = { ...resolver, strategy: item.domain_resolver?.strategy || 'ipv4_only' };
    }
}
if (!length(filter(config.outbounds, o => o.tag == 'dns-infrastructure')))
    push(config.outbounds, { tag: 'dns-infrastructure', type: 'direct', domain_resolver: resolver });
for (let set in config.route.rule_set || [])
    if (set.type == 'remote' && !settings.options?.downloadListsViaProxy) set.download_detour = 'dns-infrastructure';

// The portable bootstrap leaves must listen before the main core starts.
let sidecar = { log: { level: 'warn' }, dns: { servers: [], rules: [], independent_cache: true },
    inbounds: [], outbounds: [{ type: 'direct', tag: 'direct' }], route: { rules: [] } };
let tun = filter(config.inbounds, i => i.type == 'tun')[0];
for (let i, endpoint in bootstrapServers) {
    let tag = 'bootstrap-doh-' + i, inbound = 'bootstrap-in-' + i;
    let server = dohTransport(tag, endpoint);
    server.routing_mark = tun?.auto_redirect_output_mark || 0x2024;
    push(sidecar.dns.servers, server);
    push(sidecar.inbounds, { type: 'direct', tag: inbound, listen: '127.0.0.1', listen_port: bootstrapPorts[i] });
    push(sidecar.dns.rules, { inbound: [inbound], action: 'route', server: tag, disable_cache: true });
    push(sidecar.route.rules, { inbound: [inbound], action: 'hijack-dns' });
}
sidecar.dns.final = sidecar.dns.servers[0].tag;
sidecar.route.default_domain_resolver = { server: sidecar.dns.final, strategy: 'ipv4_only' };
if (ARGV[0] == 'experimental-1.15') migrateExperimental115(sidecar);
if (!writefile(root + '/bootstrap.json', sprintf('%J\n', sidecar))) die('Cannot write bootstrap DoH configuration');
let secret = trim(readfile(root + '/controller-secret') || '');
if (!match(secret, /^[a-f0-9-]{32,36}$/)) die('Missing controller secret');
config.experimental ||= {};
// Upgrade the runtime copy of old profiles without rewriting tunnels or rules.
// New profiles already contain FakeIP rules from the shared browser generator.
if (config.dns && !length(filter(config.dns.servers, s => s.type == 'fakeip'))) {
    let ipv6 = settings.options?.ipv6 == true;
    let selected = [];
    for (let rule in config.dns.rules || []) if (rule.server == 'proxy-dns') {
        let copy = { ...rule };
        delete copy.action; delete copy.server; delete copy.rewrite_ttl;
        push(selected, copy);
    }
    let proxy = filter(config.dns.servers, s => s.tag == 'proxy-dns')[0];
    let direct = routing.dnsResolverEnabled ? { ...proxy, tag: 'direct-dns' }
        : pinned('direct-dns', '1.1.1.1');
    delete direct.detour;
    config.dns.servers = [direct, ...filter(config.dns.servers, s => s.tag != 'direct-dns')];
    let fake = { type: 'fakeip', tag: 'fake-dns', inet4_range: '198.18.0.0/15' };
    if (ipv6) fake.inet6_range = '2001:2::/48';
    push(config.dns.servers, fake);
    let matches = [{ domain: ['fakeip-check.obhod.example.com'] }, ...selected];
    config.dns.rules = [];
    for (let rule in matches) push(config.dns.rules, { ...rule,
        query_type: ipv6 ? ['HTTPS', 'SVCB'] : ['HTTPS', 'SVCB', 'AAAA'], action: 'predefined', rcode: 'NOERROR' });
    for (let rule in matches) push(config.dns.rules, { ...rule,
        query_type: ipv6 ? ['A', 'AAAA'] : ['A'], action: 'route', server: 'fake-dns', rewrite_ttl: routing.dnsTtl || 60 });
    config.dns.reverse_mapping = false;
    config.dns.independent_cache = true;
    config.experimental.cache_file = { enabled: true, path: '/var/run/obhod/dns-cache.db', store_fakeip: true };
    let early = [];
    for (let rule in config.route.rules) if (rule.action == 'route' && (rule.domain_suffix || rule.rule_set)) {
        if (length(config.endpoints || [])) {
            let resolve = { ...rule, action: 'resolve', server: 'proxy-dns' };
            delete resolve.outbound;
            push(early, resolve);
        }
        push(early, { ...rule });
    }
    // Keep DNS interception first, ahead of restored-name routes and sniffing.
    splice(config.route.rules, 1, 0, ...early);
}
config.experimental.clash_api = { external_controller: '127.0.0.1:2081', secret, access_control_allow_origin: [] };
// TXT, MX and other non-address requests for selected domains keep the proxy
// route too. Upgrade existing FakeIP profiles without rewriting user settings.
for (let fake in filter(config.dns?.rules || [], r => r.server == 'fake-dns' && (r.domain_suffix || r.rule_set))) {
    let match = { ...fake };
    delete match.query_type; delete match.action; delete match.server; delete match.rewrite_ttl;
    let known = filter(config.dns.rules, r => r.server == 'proxy-dns' && !r.query_type &&
        sprintf('%J', r.domain_suffix) == sprintf('%J', match.domain_suffix) && sprintf('%J', r.rule_set) == sprintf('%J', match.rule_set));
    if (!length(known)) push(config.dns.rules, { ...match, action: 'route', server: 'proxy-dns', rewrite_ttl: settings.profile.routing.dnsTtl || 60 });
}
config.log = { level: settings.profile.routing.enableDiagnostics ? 'info' : 'warn', timestamp: true };
// Own standard LAN DNS regardless of sniffing, including TCP to a stale TUN IP.
config.route.rules = filter(config.route.rules, r => !(r.protocol == 'dns' && r.action == 'hijack-dns'));
if (!length(filter(config.route.rules, r => r.action=='hijack-dns' && r.port==53 && index(r.inbound || [],'tun-in')>=0))) {
    let position=0;
    while (position<length(config.route.rules) && config.route.rules[position].action=='hijack-dns' && length(config.route.rules[position].inbound || [])) position++;
    splice(config.route.rules,position,0,{inbound:['tun-in'],network:['tcp','udp'],port:53,action:'hijack-dns'});
}
// Apply the routing fix to existing profiles without rewriting user settings.
for (let rule in config.route?.rules || []) if (rule.action == 'sniff') rule.timeout = '1s';
let sniff = -1;
for (let i = 0; i < length(config.route.rules); i++) if (config.route.rules[i].action == 'sniff') { sniff = i; break; }
if (sniff >= 0) {
    let early = slice(config.route.rules, 0, sniff);
    let ips = filter(slice(config.route.rules, sniff + 1), r => r.action == 'route' && r.ip_cidr &&
        !length(filter(early, e => sprintf('%J', e) == sprintf('%J', r))));
    if (length(ips)) {
        let private = filter(config.route.rules, r => r.ip_is_private && r.outbound == 'direct');
        splice(config.route.rules, sniff, 0, ...private, ...ips);
    }
}
// Preserve the second domain/rule-set pass after sniff. Only immutable terminal
// IP matches are redundant once an identical earlier rule has already run.
let terminalIPs = [];
config.route.rules = filter(config.route.rules, r => {
    if (r.action != 'route' || !(r.ip_cidr || r.ip_is_private)) return true;
    let key = sprintf('%J', r);
    if (index(terminalIPs, key) >= 0) return false;
    push(terminalIPs, key); return true;
});
if (ARGV[0] == 'experimental-1.15') migrateExperimental115(config);
if (!writefile(root + '/config.json', sprintf('%J\n', config))) die('Cannot write runtime DNS configuration');
