// SPDX-License-Identifier: Apache-2.0
import { readfile, writefile, unlink } from 'fs';
let root = '/var/run/obhod/';
let settings = json(readfile('/etc/obhod/settings.json'));
let config = json(readfile(root + 'config.json'));
let mode = settings.options?.dnsPoolMode || 'single';
if (!match(mode, /^(single|parallel|balanced)$/)) die('Invalid DNS pool mode');
let enabled = settings.profile.routing.dnsResolverEnabled && mode != 'single';
for (let group in ['direct', 'proxy', 'bootstrap']) {
    let file = root + 'dns-pool-' + group + '.json';
    unlink(file);
    if (!enabled) continue;
    let canonical = filter(config.dns?.servers || [], s => s.tag == (group=='bootstrap'?'bootstrap-dns':group+'-dns'))[0];
    if (canonical?.type == 'obhod-pool') continue;
    if (group == 'bootstrap') {
        let gateway = filter(config.dns?.servers || [], s => s.tag == 'bootstrap-dns')[0];
        if (gateway?.server != '127.0.0.1' || gateway?.server_port != 1155) continue;
        let upstreams = filter(config.dns.servers, s => index(s.tag || '', 'dns-upstream-bootstrap-') == 0);
        if (length(upstreams) < 2 || length(upstreams) > 4) die('Invalid bootstrap pool size');
        let servers = map(upstreams, s => ({ address: s.server, port: s.server_port || 53 }));
        let tun = filter(config.inbounds || [], i => i.type == 'tun')[0];
        // Same output bypass mark as our sing-box TUN, never another proxy route.
        let mark = tun?.auto_redirect_output_mark || 0x2024;
        if (!writefile(file, sprintf('%J\n', { port: 1155, servers, mode, mark }))) die('Cannot write bootstrap pool');
        continue;
    }
    let leaves = filter(config.inbounds || [], i => index(i.tag || '', 'dns-leaf-' + group + '-') == 0);
    if (!length(leaves)) {
        if (group != 'bootstrap') die('Missing DNS pool inbounds; save settings in LuCI');
        continue;
    }
    if (length(leaves) < 2 || length(leaves) > 4) die('Invalid DNS pool size');
    let port = group == 'direct' ? 1153 : group == 'proxy' ? 1154 : 1155;
    let offset = group == 'direct' ? 0 : group == 'proxy' ? 4 : 8;
    let tag = group == 'bootstrap' ? 'bootstrap-dns' : group + '-dns';
    let gateway = filter(config.dns.servers, s => s.tag == tag)[0];
    if (gateway?.server != '127.0.0.1' || gateway?.server_port != port || gateway?.type != 'udp' || gateway?.detour) die('Invalid DNS pool gateway');
    let servers = [];
    for (let index, leaf in leaves) {
        if (leaf.type != 'direct' || leaf.listen != '127.0.0.1' || leaf.listen_port != 12053 + offset + index || leaf.tag != 'dns-leaf-' + group + '-' + index) die('Invalid DNS pool listener');
        push(servers, leaf.listen_port);
    }
    if (!writefile(file, sprintf('%J\n', { port, servers, mode }))) die('Cannot write DNS pool configuration');
}
