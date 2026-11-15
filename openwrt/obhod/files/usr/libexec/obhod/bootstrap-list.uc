// SPDX-License-Identifier: Apache-2.0
import { readfile } from 'fs';
import { savedBootstrap } from './bootstrap-doh.uc';

let settings = json(readfile(ARGV[0]) || '{}');
for (let endpoint in savedBootstrap(settings)) {
    let authority = endpoint.host + (endpoint.port == 443 ? '' : ':' + endpoint.port);
    let ip = index(endpoint.ip, ':') >= 0 ? '[' + endpoint.ip + ']' : endpoint.ip;
    printf('%s:%d:%s https://%s%s\n', endpoint.host, endpoint.port, ip, authority, endpoint.path);
}
