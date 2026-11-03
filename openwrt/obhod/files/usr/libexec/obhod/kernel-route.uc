// SPDX-License-Identifier: Apache-2.0
// Upgrade saved profiles too: only selected destination addresses enter TUN.
import { readfile, writefile } from 'fs';
let file = ARGV[0], config = json(readfile(file));
let tun = filter(config.inbounds || [], i => i.type == 'tun')[0];
if (!tun) die('Missing TUN inbound');
let addresses = [], sets = [];
for (let dns in config.dns.servers) if (dns.type == 'fakeip') {
    if (dns.inet4_range) push(addresses, dns.inet4_range);
    if (dns.inet6_range) push(addresses, dns.inet6_range);
}
for (let rule in config.route.rules) {
    if (rule.action != 'route' || rule.outbound == 'direct') continue;
    for (let cidr in rule.ip_cidr || []) if (index(addresses, cidr) < 0) push(addresses, cidr);
    for (let tag in rule.rule_set || []) if (tag != 'obhod-selected-addresses' && index(sets, tag) < 0) push(sets, tag);
}
if (!length(addresses)) die('Missing FakeIP ranges');
config.route.rule_set = filter(config.route.rule_set || [], r => r.tag != 'obhod-selected-addresses');
push(config.route.rule_set, { type: 'inline', tag: 'obhod-selected-addresses', rules: [{ ip_cidr: addresses }] });
tun.route_address_set = ['obhod-selected-addresses', ...sets];
tun.strict_route = false;
// These would intersect the union or silently exclude a selected destination.
delete tun.route_address; delete tun.route_exclude_address; delete tun.route_exclude_address_set;
if (!writefile(file, sprintf('%J\n', config))) die('Cannot prepare kernel routing');
