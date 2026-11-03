// SPDX-License-Identifier: Apache-2.0
// Serialize the compare-and-replace with libuci's flock on the actual package.
import { open, readfile, stat, chmod, chown, rename, unlink } from 'fs';
let path = '/etc/config/dhcp', before = stat(path), source = open(path, 'r+');
if (!before || !source || !source.lock('x')) die('Cannot lock dhcp configuration');
let current = stat(path), original = readfile(ARGV[0]), replacement = readfile(ARGV[1]);
// A writer may have renamed the file while we waited for its old inode.
if (!current || current.inode != before.inode || sprintf('%J', current.dev) != sprintf('%J', before.dev) ||
    original == null || replacement == null || source.read('all') != original || readfile(path) != original)
    die('DNS configuration changed concurrently; retry the operation');
let temporary = ARGV[2];
if (!match(temporary || '', /^\/etc\/config\/\.dhcp\.obhod\.[a-zA-Z0-9]+$/)) die('Invalid staging path');
let target = open(temporary, 'w', 0600);
// Keep both old and replacement inodes locked through the atomic rename.
if (!target) die('Cannot stage dhcp configuration');
if (!target.lock('x') || target.write(replacement) != length(replacement)) {
    unlink(temporary); die('Cannot write dhcp configuration');
}
// Older ucode returns null from flush even on success; error() is authoritative.
target.flush();
if (target.error() || !chown(temporary, before.uid, before.gid) || !chmod(temporary, before.mode & 0777) || !rename(temporary, path)) {
    unlink(temporary); die('Cannot commit dhcp configuration');
}
