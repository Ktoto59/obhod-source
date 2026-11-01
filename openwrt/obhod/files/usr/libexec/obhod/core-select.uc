// SPDX-License-Identifier: Apache-2.0
import { readfile } from 'fs';
let catalog=json(readfile(ARGV[0]));
if (catalog.schema != 1) die('Unsupported core catalog');
let rows=filter(catalog.packages || [],p=>p.arch==ARGV[1] && p.manager==ARGV[2] && p.profile==ARGV[3] && index(p.releases || [],ARGV[4])>=0);
if (!length(rows)) exit(0);
if (length(rows)!=1) die('Ambiguous core package');
let p=rows[0];
if (!match(p.url || '',/^https:\/\/api\.github\.com\/repos\/Ktoto59\/obhod-releases\/releases\/assets\/[0-9]+$/) ||
    !match(p.sha256 || '',/^[a-f0-9]{64}$/) || type(p.bytes)!='int' || p.bytes<1024 || p.bytes>67108864 ||
    type(p.installedBytes)!='int' || p.installedBytes<1024 || p.installedBytes>134217728 ||
    !match(p.version || '',/^1\.13\.21-(r)?200$/)) die('Invalid pinned core package');
print(p.url,' ',p.sha256,' ',p.bytes,' ',p.installedBytes,' ',p.version,'\n');
