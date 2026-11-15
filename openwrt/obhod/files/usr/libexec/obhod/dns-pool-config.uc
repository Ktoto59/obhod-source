// SPDX-License-Identifier: Apache-2.0
import { readfile, writefile, unlink } from 'fs';
import { bootstrapPorts } from './bootstrap-doh.uc';
let root = (ARGV[1] || '/var/run/obhod') + '/';
let settings = json(readfile(ARGV[0] || '/etc/obhod/settings.json'));
let config = json(readfile(root + 'config.json'));
let mode = settings.options?.dnsPoolMode || 'single';
if (!match(mode, /^(single|fallback|parallel|balanced)$/)) die('Invalid DNS pool mode');
let enabled = settings.profile.routing.dnsResolverEnabled && mode != 'single';
for (let group in ['direct', 'proxy', 'bootstrap']) {
    let file = root + 'dns-pool-' + group + '.json';
    unlink(file);
    if (group == 'bootstrap') {
        let sidecar = json(readfile(root + 'bootstrap.json'));
        let servers = map(sidecar.inbounds, leaf => leaf.listen_port);
        if (!length(servers) || length(servers) > length(bootstrapPorts) ||
            !writefile(file, sprintf('%J\n', { port: 1155, servers, mode: 'fallback' }))) die('Cannot write bootstrap DoH pool');
        continue;
    }
    if (!enabled) continue;
    let canonical = filter(config.dns?.servers || [], s => s.tag == (group=='bootstrap'?'bootstrap-dns':group+'-dns'))[0];
    if (canonical?.type == 'obhod-pool') continue;
    let leaves = filter(config.inbounds || [], i => index(i.tag || '', 'dns-leaf-' + group + '-') == 0);
    if (!length(leaves)) die('Missing DNS pool inbounds; save settings in LuCI');
    if (length(leaves) < 2 || length(leaves) > 4) die('Invalid DNS pool size');
    let port = group == 'direct' ? 1153 : 1154;
    let offset = group == 'direct' ? 0 : 4;
    let tag = group + '-dns';
    let gateway = filter(config.dns.servers, s => s.tag == tag)[0];
    if (gateway?.server != '127.0.0.1' || gateway?.server_port != port || gateway?.type != 'udp' || gateway?.detour) die('Invalid DNS pool gateway');
    let servers = [];
    for (let index, leaf in leaves) {
        if (leaf.type != 'direct' || leaf.listen != '127.0.0.1' || leaf.listen_port != 12053 + offset + index || leaf.tag != 'dns-leaf-' + group + '-' + index) die('Invalid DNS pool listener');
        push(servers, leaf.listen_port);
    }
    if (!writefile(file, sprintf('%J\n', { port, servers, mode }))) die('Cannot write DNS pool configuration');
}
