// SPDX-License-Identifier: Apache-2.0
// The caller owns the core operation lease. Never edit opkg's database.
import { open, readfile, lstat, stat, chmod, chown, rename, unlink, mkdir, popen } from 'fs';
const journal='/etc/obhod/core-package-backup.json';
const paths=['/etc/config/sing-box','/etc/sing-box/config.json'];
let guard=open('/var/lock/obhod-core-config.guard','a');
if (!guard || !guard.lock('xn')) die('Core configuration transaction is busy');
// A killed parent can still have a live package-manager child holding FD 9.
if (system('pidof opkg opkg-real >/dev/null 2>&1')==0) die('opkg is still running; retry after it finishes');
function quote(s) { return "'"+replace(s, /'/g, "'\\''")+"'"; }
function digest(command) {
    let stream=popen(command,'r');
    if (!stream) die('Cannot verify core package payload');
    let value=trim(stream.read('all') || ''),result=stream.close();
    if (result!=0 || !match(value,/^[a-f0-9]{64} /)) return '';
    return substr(value,0,64);
}
function atomic(path,data,mode,uid,gid) {
    let tmp=path+'.obhod-core.tmp';
    if (lstat(tmp) && !unlink(tmp)) die('Cannot clear core configuration staging file');
    let file=open(tmp,'w',0600);
    if (!file || file.write(data)!=length(data)) die('Cannot stage core configuration');
    file.flush();
    if (file.error() || !chmod(tmp,mode) || !chown(tmp,uid,gid) || !rename(tmp,path))
        die('Cannot commit core configuration; backup retained at '+journal);
    file.close();
}
function recover() {
    if (!lstat(journal)) return;
    let entry=lstat(journal);
    if (entry.type!='file') die('Invalid core configuration journal');
    let state=json(readfile(journal));
    if (state.schema!=1 || type(state.files)!='array') die('Invalid core configuration journal');
    // Validate every file before restoring any; unknown external edits win.
    for (let row in state.files) {
        if (index(paths,row.path)<0 || type(row.before)!='string' || type(row.incoming)!='string' ||
            type(row.mode)!='int' || row.mode<0 || row.mode>0777 || type(row.uid)!='int' || type(row.gid)!='int')
            die('Invalid core configuration backup');
        let current=lstat(row.path),data=readfile(row.path);
        if (current && (current.type!='file' || (data!=row.before && data!=row.incoming)))
            die('Core configuration changed externally; preserve edits and recover from '+journal);
    }
    for (let row in state.files) {
        if (row.path=='/etc/sing-box/config.json' && !lstat('/etc/sing-box') && !mkdir('/etc/sing-box',0755))
            die('Cannot recreate core configuration directory');
        if (readfile(row.path)!=row.before) atomic(row.path,row.before,row.mode,row.uid,row.gid);
        else if (!chmod(row.path,row.mode) || !chown(row.path,row.uid,row.gid)) die('Cannot restore core configuration permissions');
    }
    if (!unlink(journal)) die('Cannot finish core configuration recovery');
}
recover();
if (ARGV[0]=='recover') exit(0);
let file=ARGV[0];
if (!match(file || '',/^\/tmp\/[a-zA-Z0-9_./-]+\.ipk$/) || index(file,'..')>=0 || lstat(file)?.type!='file') die('Invalid verified core package path');
let records=[];
let expected=digest('tar -xOzf '+quote(file)+' ./data.tar.gz | tar -xzOf - ./usr/bin/sing-box | sha256sum');
if (!expected || expected=='e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') die('Core package has no executable payload');
for (let path in paths) {
    let info=lstat(path);
    if (!info) continue;
    if (info.type!='file' || info.size>4194304) die('Unsupported core configuration; installation cancelled');
    let input=popen('tar -xOzf '+quote(file)+' ./data.tar.gz | tar -xzOf - '+quote('.'+path)+' 2>/dev/null','r');
    if (!input) die('Cannot inspect core package configuration');
    let incoming=input.read('all'),result=input.close();
    if (result!=0) continue; // A package fixture may not carry this configuration.
    let before=readfile(path);
    if (before==null || length(incoming)>4194304) die('Cannot snapshot core configuration');
    push(records,{path,before,incoming,mode:info.mode & 0777,uid:info.uid,gid:info.gid});
}
if (!stat('/etc/obhod') && !mkdir('/etc/obhod',0700)) die('Cannot create private core configuration backup');
atomic(journal,sprintf('%J\n',{schema:1,files:records}),0600,0,0);
let result=system('opkg --force-downgrade --force-reinstall install '+quote(file));
recover();
// opkg 38eccbb1 can return success after a short data-file write. Verify bytes,
// not just its exit status or the resulting package-database version.
if (result==0 && digest('sha256sum /usr/bin/sing-box')!=expected) die('Installed core payload does not match the verified package; retry installation');
exit(result==0 ? 0 : 1);
