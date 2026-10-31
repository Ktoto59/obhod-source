// SPDX-License-Identifier: Apache-2.0
import { readfile, writefile } from 'fs';
let settings = json(readfile('/etc/obhod/settings.json'));
let config = settings.config;
let secret = trim(readfile('/var/run/obhod/controller-secret'));
if (!match(secret, /^[a-f0-9-]{32,36}$/)) die('Missing controller secret');
config.experimental ||= {};
// Upgrade the runtime copy of old profiles without rewriting tunnels or rules.
// New profiles already contain FakeIP rules from the shared browser generator.
if (config.dns && !length(filter(config.dns.servers, s => s.type == 'fakeip'))) {
    let routing = settings.profile.routing, ipv6 = settings.options?.ipv6 == true;
    let selected = [];
    for (let rule in config.dns.rules || []) if (rule.server == 'proxy-dns') {
        let copy = { ...rule };
        delete copy.action; delete copy.server; delete copy.rewrite_ttl;
        push(selected, copy);
    }
    let proxy = filter(config.dns.servers, s => s.tag == 'proxy-dns')[0];
    let direct = routing.dnsResolverEnabled ? { ...proxy, tag: 'direct-dns' }
        : { type: 'udp', tag: 'direct-dns', server: '1.1.1.1' };
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
config.log = { level: settings.profile.routing.enableDiagnostics ? 'info' : 'warn', timestamp: true };
// Apply the routing fix to existing profiles without rewriting user settings.
for (let rule in config.route?.rules || []) if (rule.action == 'sniff') rule.timeout = '1s';
writefile('/var/run/obhod/config.json', sprintf('%J\n', config));
