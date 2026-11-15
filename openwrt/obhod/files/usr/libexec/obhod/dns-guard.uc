// SPDX-License-Identifier: Apache-2.0
import { readfile } from 'fs';
let config = json(readfile('/var/run/obhod/config.json'));
let tun = filter(config.inbounds, i => i.type == 'tun')[0];
let local = ['lo'];
for (let name in tun?.include_interface || []) {
    if (!match(name, /^[a-zA-Z0-9_.-]{1,15}$/)) die('Invalid LAN interface for strict DNS');
    if (index(local, name) < 0) push(local, name);
}
let devices = join(', ', map(local, name => sprintf('"%s"', name)));
// The entire transaction is atomic. Neither fw4 nor sing-box tables are edited.
print('add table inet obhod_dns_guard\ndelete table inet obhod_dns_guard\n');
printf('table inet obhod_dns_guard {\n');
for (let hook in ['output', 'forward']) {
    printf(' chain %s { type filter hook %s priority -5; policy accept;\n', hook, hook);
    printf('  oifname != { %s } fib daddr type != local meta l4proto { tcp, udp } th dport 53 counter reject\n }\n', devices);
}
print('}\n');
