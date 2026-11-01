// SPDX-License-Identifier: Apache-2.0
// Convert the portable saved DNS graph only in RAM. A stock core keeps using
// the ucode helper, so rollback never requires rewriting a user's profile.
import { readfile, writefile } from 'fs';
let file = '/var/run/obhod/config.json';
let settings = json(readfile('/etc/obhod/settings.json'));
let config = json(readfile(file));
let mode = settings.options?.dnsPoolMode || 'single';
if (!settings.profile.routing.dnsResolverEnabled || mode == 'single') exit(0);
if (!match(mode, /^(parallel|balanced)$/)) die('Invalid DNS pool mode');
let removed = [];
for (let group in ['direct','proxy','bootstrap']) {
    let tag = group == 'bootstrap' ? 'bootstrap-dns' : group + '-dns';
    let gateway = filter(config.dns.servers, s => s.tag == tag)[0];
    if (gateway?.server != '127.0.0.1' || gateway.server_port != (group=='direct'?1153:group=='proxy'?1154:1155)) {
        if (group != 'bootstrap') die('Invalid portable DNS pool gateway');
        continue;
    }
    let members = filter(config.dns.servers, s => index(s.tag || '', 'dns-upstream-'+group+'-') == 0);
    if (length(members)<2 || length(members)>4) die('Invalid native DNS pool members');
    let replacement = { type:'obhod-pool', tag, mode, servers:map(members,s=>s.tag) };
    config.dns.servers = map(config.dns.servers, s => s.tag==tag ? replacement : s);
}
for (let inbound in config.inbounds || []) if (index(inbound.tag || '', 'dns-leaf-')==0) push(removed,inbound.tag);
config.inbounds=filter(config.inbounds || [],i=>index(removed,i.tag)<0);
config.dns.rules=filter(config.dns.rules || [],r=>!length(filter(r.inbound || [],tag=>index(removed,tag)>=0)));
config.route.rules=filter(config.route.rules || [],r=>!length(filter(r.inbound || [],tag=>index(removed,tag)>=0)));
if (!writefile(file,sprintf('%J\n',config))) die('Cannot write native DNS configuration');
