// SPDX-License-Identifier: Apache-2.0
import { readfile } from 'fs';
let catalog=json(readfile(ARGV[0]));
if (catalog.schema != 1) die('Unsupported core catalog');
let rows=filter(catalog.packages || [],p=>p.arch==ARGV[1] && p.manager==ARGV[2] && (ARGV[3]=='list' || p.profile==ARGV[3]) && index(p.releases || [],ARGV[4])>=0);
for (let p in rows) {
    let version=match(p.version || '',/^1\.13\.21-(r)?(200|300)$/);
    if (!version || !match(p.url || '',/^https:\/\/api\.github\.com\/repos\/Ktoto59\/obhod-releases\/releases\/assets\/[0-9]+$/) ||
        !match(p.sha256 || '',/^[a-f0-9]{64}$/) || type(p.bytes)!='int' || p.bytes<1024 || p.bytes>67108864 ||
        type(p.installedBytes)!='int' || p.installedBytes<1024 || p.installedBytes>134217728) die('Invalid pinned core package');
    let expected='1.13.21-obhod.'+(version[2]=='300'?'3':'2');
    if (p.coreVersion && p.coreVersion!=expected) die('Invalid core version');
    p.coreVersion=expected;
}
if (ARGV[3]=='list') {
    printf('%J\n',{ versions: map(rows,p=>({value:p.coreVersion,profile:p.profile,recommended:p.coreVersion==catalog.version,
        downloadBytes:p.bytes,installedBytes:p.installedBytes})), recommended:catalog.version });
    exit(0);
}
let wanted=ARGV[5] || 'auto';
if (wanted=='auto') wanted=catalog.version || '1.13.21-obhod.3';
rows=filter(rows,p=>p.coreVersion==wanted);
if (!length(rows)) exit(0);
if (length(rows)!=1) die('Ambiguous core package');
let p=rows[0];
print(p.url,' ',p.sha256,' ',p.bytes,' ',p.installedBytes,' ',p.version,'\n');
