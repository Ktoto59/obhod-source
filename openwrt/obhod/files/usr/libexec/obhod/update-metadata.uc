// SPDX-License-Identifier: Apache-2.0
import { readfile } from 'fs';
let release = json(readfile(ARGV[0]));
let current = trim(readfile('/usr/share/obhod/version') || '');
let pattern = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/;
if (type(release) != 'object' || !match(release.version || '', pattern) || !match(current, pattern)) die('Invalid release version');
if (release.tag != 'openwrt-v' + release.version
    || !match(release.bundleSha256 || '', /^[a-f0-9]{64}$/)
    || !match(release.bundleUrl || '', /^https:\/\/api\.github\.com\/repos\/Ktoto59\/obhod-releases\/releases\/assets\/[1-9][0-9]{0,19}$/)) die('Invalid release metadata');
let next = split(release.version, '.'), installed = split(current, '.'), newer = false;
for (let i = 0; i < 3; i++) {
    if (int(next[i]) == int(installed[i])) continue;
    newer = int(next[i]) > int(installed[i]); break;
}
printf('%J\n', { installedVersion: current, version: release.version, available: newer,
    bundleUrl: release.bundleUrl, bundleSha256: release.bundleSha256 });
