// SPDX-License-Identifier: Apache-2.0
import { readfile, lsdir } from 'fs';
let mode = ARGV[0];
if (mode == 'interfaces') {
    let network = json(readfile(ARGV[1]) || '{}'), devices = [];
    for (let name in lsdir('/sys/class/net') || []) {
        if (name == 'lo' || name == 'obhod-tun' || !match(name, /^[a-zA-Z0-9_.-]{1,15}$/)) continue;
        let labels = [], addresses = [];
        for (let iface in network.interface || []) {
            if (iface.device != name && iface.l3_device != name) continue;
            push(labels, iface.interface);
            for (let address in iface['ipv4-address'] || []) push(addresses, address.address);
        }
        push(devices, { name, label: (length(labels) ? join(', ', labels) + ' · ' : '') + name + (length(addresses) ? ' · ' + join(', ', addresses) : ''), up: trim(readfile('/sys/class/net/' + name + '/operstate') || '') == 'up' });
    }
    printf('%J\n', { devices });
    exit(0);
}
let settings = json(readfile('/etc/obhod/settings.json'));
let routing = settings.profile.routing;
let tag = 'tunnel-' + replace(routing.activeTunnelId || '', /[^a-z0-9_-]/gi, '_');
let proxies = json(readfile(ARGV[1]) || '{}').proxies || {};
if (routing.failoverEnabled) tag = proxies.proxy?.now || '';
if (!match(tag, /^tunnel-[a-zA-Z0-9_-]+$/)) tag = '';
if (mode == 'tag') { if (!routing.failoverEnabled || ARGV[2] == 'diagnose') print(tag); exit(0); }
let selected;
for (let tunnel in settings.profile.tunnels) if ('tunnel-' + replace(tunnel.id, /[^a-z0-9_-]/gi, '_') == tag) selected = tunnel;
let delay = json(readfile(ARGV[2]) || '{}').delay;
let explicit = ARGV[3] == 'diagnose', active = explicit || ARGV[3] == 'active', proxy = proxies[tag];
let history = proxy?.history || [], sample = length(history) ? history[length(history) - 1] : null;
if (!active) delay = sample?.delay;
let valid = type(delay) == 'int' && delay > 0 && delay < 60000;
// An absent urltest sample means unknown latency, not a failed connection.
// Only explicit diagnosis or an actual failed urltest sample reports failure.
let ok = active ? valid : !!proxy && (!sample || valid);
printf('%J\n', { name: selected?.name || '', tag, delay: valid ? delay : null, ok,
    checkedAt: time(), delayTime: active ? null : sample?.time, diagnostic: explicit });
