// SPDX-License-Identifier: Apache-2.0
// Upgrade the runtime graph too, without rewriting saved profiles or FakeIP.
import { readfile, writefile, unlink } from 'fs';
let root = '/var/run/obhod/';
let settings = json(readfile('/etc/obhod/settings.json'));
let config = json(readfile(root + 'config.json'));
let file = root + 'dns-pool-filter.json';
unlink(file);
if (!settings.profile.routing.dnsResolverEnabled) exit(0);
let fake = filter(config.dns.servers || [], s => s.type == 'fakeip')[0];
if (!fake) die('Missing native FakeIP store');
let leaves = [
    { tag: 'dns-filter-real-in', port: 12065, server: 'proxy-dns' },
    { tag: 'dns-filter-fake-in', port: 12066, server: fake.tag }
];
for (let leaf in leaves) {
    let inbound = filter(config.inbounds, i => i.tag == leaf.tag)[0];
    if (inbound) {
        if (inbound.type != 'direct' || inbound.listen != '127.0.0.1' || inbound.listen_port != leaf.port)
            die('Invalid DNS filter listener');
    } else {
        if (length(filter(config.inbounds, i => i.listen_port == leaf.port))) die('DNS filter port is occupied');
        push(config.inbounds, { type: 'direct', tag: leaf.tag, listen: '127.0.0.1', listen_port: leaf.port });
    }
}
let gateway = filter(config.dns.servers, s => s.tag == 'filtered-fake-dns')[0];
if (gateway) {
    if (gateway.type != 'udp' || gateway.server != '127.0.0.1' || gateway.server_port != 1156 || gateway.detour)
        die('Invalid DNS filter gateway');
} else {
    if (length(filter(config.inbounds, i => i.listen_port == 1156))) die('DNS filter port is occupied');
    push(config.dns.servers, { type: 'udp', tag: 'filtered-fake-dns', server: '127.0.0.1', server_port: 1156 });
}
for (let rule in config.dns.rules) if (rule.server == fake.tag && (rule.domain_suffix || rule.rule_set)) {
    rule.server = 'filtered-fake-dns';
    rule.disable_cache = true;
}
// Rebuild only our loopback dispatch to make repeated preparation idempotent.
let tags = map(leaves, l => l.tag);
config.dns.rules = filter(config.dns.rules, r => !length(filter(r.inbound || [], tag => index(tags, tag) >= 0)));
config.route.rules = filter(config.route.rules, r => !length(filter(r.inbound || [], tag => index(tags, tag) >= 0)));
for (let i = length(leaves) - 1; i >= 0; i--) {
    let leaf = leaves[i];
    splice(config.dns.rules, 0, 0, { inbound: [leaf.tag], action: 'route', server: leaf.server });
}
splice(config.route.rules, 0, 0, { inbound: tags, action: 'hijack-dns' });
if (!writefile(root + 'config.json', sprintf('%J\n', config))) die('Cannot write DNS filtering graph');
if (!writefile(file, sprintf('%J\n', { mode: 'filtered-fakeip', port: 1156, servers: [12065, 12066] })))
    die('Cannot write DNS filtering helper');
