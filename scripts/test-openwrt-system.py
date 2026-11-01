#!/usr/bin/env python3
"""Isolated OpenWrt userspace tests. Run on Linux; no physical router is touched."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / '.tmp/openwrt-tools'
LAB = Path('/tmp/obhod-openwrt-lab')
APK = TOOLS / 'sbin/apk.static'
PACKAGES = ROOT / 'release/openwrt'


def run(args, **kwargs):
    return subprocess.run([str(value) for value in args], text=True, capture_output=True, **kwargs)


def inside(*args, **kwargs):
    result = run(['chroot', LAB, *args], **kwargs)
    assert result.returncode == 0, f'{args}: {result.stdout} {result.stderr}'
    return result.stdout.strip()


def checked_download(url, target, checksum):
    if not target.exists():
        with urllib.request.urlopen(url, timeout=60) as response:
            target.write_bytes(response.read())
    assert hashlib.sha256(target.read_bytes()).hexdigest() == checksum, f'Checksum mismatch: {target}'


def prepare():
    TOOLS.mkdir(parents=True, exist_ok=True)
    rootfs = TOOLS / 'rootfs.tar.gz'
    checked_download('https://downloads.openwrt.org/releases/25.12.6/targets/x86/64/openwrt-25.12.6-x86-64-rootfs.tar.gz',
                     rootfs, '55e52bb34de582a1ebe56bd50f94ff54ac7c77f5bca9cae807656d1930456da4')
    LAB.mkdir(exist_ok=True)
    # This fixed directory belongs only to this disposable test, never to a router.
    assert LAB.resolve().parent == Path('/tmp') and LAB.name == 'obhod-openwrt-lab'
    shutil.rmtree(LAB)
    LAB.mkdir()
    run(['tar', '-xzf', rootfs, '-C', LAB], check=True)
    # The Electron regression test can exercise the real class loader without
    # vendoring or shipping LuCI's code in our own packages.
    shutil.copyfile(LAB/'www/luci-static/resources/luci.js', TOOLS/'luci-25.12.6.js')
    shutil.copyfile(LAB/'www/luci-static/bootstrap/cascade.css', TOOLS/'luci-bootstrap-25.12.6.css')
    inside('/bin/mkdir', '-p', '/var/lock', '/var/run/obhod')
    # Package installation is real; virtual dependencies avoid changing the host.
    with tempfile.TemporaryDirectory(prefix='obhod-testdeps-') as temporary:
        stage = Path(temporary) / 'root'
        stage.mkdir()
        deps = ['sing-box', 'firewall4', 'kmod-tun', 'kmod-nft-tproxy', 'kmod-nft-queue',
                'uclient-fetch', 'ca-bundle', 'jshn', 'jsonfilter', 'rpcd', 'rpcd-mod-file', 'luci-base', 'ucode', 'ucode-mod-fs']
        artifact = LAB / 'tmp/testdeps.apk'
        result = run([APK, 'mkpkg', '--info', 'name:obhod-testdeps', '--info', 'version:1-r1',
                      '--info', 'arch:noarch', '--info', 'provides:' + ' '.join(deps), '--files', stage, '--output', artifact])
        assert result.returncode == 0, result.stderr
    for file in PACKAGES.glob('*.apk'):
        shutil.copyfile(file, LAB / 'tmp' / file.name)
    # Keep the official tools, but isolate the package database from rootfs world constraints.
    (LAB / 'etc/apk/world').write_text('')
    database = LAB / 'lib/apk/db'
    if database.exists():
        shutil.rmtree(database)
    inside('/usr/bin/apk', '--initdb', '--no-network', '--no-scripts', 'add', '--allow-untrusted', '/tmp/testdeps.apk',
           '/tmp/obhod-0.1.16-r1.apk', '/tmp/luci-app-obhod-0.1.16-r1.apk')
    assert (LAB / 'www/luci-static/resources/view/obhod/overview.js').exists()
    assert (LAB / 'www/luci-static/resources/obhod/overview.css').exists()
    assert (LAB / 'etc/obhod').stat().st_mode & 0o777 == 0o700
    assert not (LAB / 'etc/obhod/settings.json').exists()
    assert inside('/sbin/uci', '-q', 'get', 'obhod.main.enabled') == '0'
    print('PASS: real OpenWrt APK installation, payload, permissions and disabled defaults')


def dns_tests():
    # Stub only daemon restart; parsing and UCI writes use the real OpenWrt tools.
    (LAB / 'etc/init.d/dnsmasq').write_text('#!/bin/sh\nexit 0\n')
    (LAB / 'etc/init.d/dnsmasq').chmod(0o755)
    dhcp = LAB / 'etc/config/dhcp'
    initial = "config dnsmasq 'main'\n option noresolv '0'\n list server '9.9.9.9'\n list server '/corp.example/192.0.2.53'\n option domain 'lan'\n"
    dhcp.write_text(initial)
    inside('/sbin/uci', 'set', 'dhcp.main.domain=pending.example')
    inside('/usr/libexec/obhod/dns', 'apply')
    assert inside('/sbin/uci', 'get', 'dhcp.main.server') == '127.0.0.1#1053'
    assert inside('/sbin/uci', 'get', 'dhcp.main.noresolv') == '1'
    assert inside('/sbin/uci', 'get', 'dhcp.main.domain') == 'pending.example'
    assert 'pending.example' not in dhcp.read_text()
    inside('/usr/libexec/obhod/dns', 'apply')
    inside('/usr/libexec/obhod/dns', 'restore')
    assert inside('/sbin/uci', 'get', 'dhcp.main.server') == '9.9.9.9 /corp.example/192.0.2.53'
    assert inside('/sbin/uci', 'get', 'dhcp.main.noresolv') == '0'
    assert not (LAB / 'etc/obhod/dns-backup.json').exists()
    assert inside('/sbin/uci', 'changes', 'dhcp')
    inside('/sbin/uci', 'revert', 'dhcp')
    inside('/usr/libexec/obhod/dns', 'apply')
    inside('/sbin/uci', 'set', 'dhcp.main.server=8.8.8.8')
    inside('/sbin/uci', 'commit', 'dhcp')
    result = run(['chroot', LAB, '/usr/libexec/obhod/dns', 'restore'])
    assert result.returncode != 0
    assert inside('/sbin/uci', 'get', 'dhcp.main.server') == '8.8.8.8'
    assert (LAB / 'etc/obhod/dns-backup.json').exists()
    (LAB / 'etc/obhod/dns-backup.json').unlink()
    dhcp.write_text(initial + "config dnsmasq 'guest'\n option domain 'guest'\n")
    result = run(['chroot', LAB, '/usr/libexec/obhod/dns', 'apply'])
    assert result.returncode != 0
    assert not (LAB / 'etc/obhod/dns-backup.json').exists()
    print('PASS: DNS backup/restore, idempotency, external edits and multiple instances')
    settings = LAB / 'etc/obhod/settings.json'
    settings.write_text(json.dumps({'options': {'dnsMode': 'fakeip'}}))
    dhcp.write_text(initial + " option cachesize '150'\n")
    inside('/usr/libexec/obhod/dns', 'apply')
    assert inside('/sbin/uci', 'get', 'dhcp.main.cachesize') == '0'
    backup = json.loads((LAB / 'etc/obhod/dns-backup.json').read_text())
    assert backup['manageCache'] and backup['cachesize'] == '150'
    # A failed dnsmasq restart retains the durable backup, including cache size.
    (LAB / 'etc/init.d/dnsmasq').write_text('#!/bin/sh\nexit 1\n')
    assert run(['chroot', LAB, '/usr/libexec/obhod/dns', 'restore']).returncode != 0
    assert (LAB / 'etc/obhod/dns-backup.json').exists()
    assert inside('/sbin/uci', 'get', 'dhcp.main.cachesize') == '150'
    (LAB / 'etc/init.d/dnsmasq').write_text('#!/bin/sh\nexit 0\n')
    inside('/usr/libexec/obhod/dns', 'restore')
    assert not (LAB / 'etc/obhod/dns-backup.json').exists()
    assert inside('/sbin/uci', 'get', 'dhcp.main.server') == '9.9.9.9 /corp.example/192.0.2.53'
    # Retry an apply interrupted after making a backup but before committing.
    (LAB / 'etc/obhod/dns-backup.json').write_text(json.dumps(backup))
    inside('/usr/libexec/obhod/dns', 'apply')
    assert inside('/sbin/uci', 'get', 'dhcp.main.cachesize') == '0'
    inside('/usr/libexec/obhod/dns', 'restore')
    assert inside('/sbin/uci', 'get', 'dhcp.main.cachesize') == '150'
    settings.unlink()
    for manager, data in [
        ('apk', json.dumps([{'name':'sing-box-tiny','version':'1.13-r1','installed-size':31000000,'file-size':11000000}])),
        ('opkg', 'Package: sing-box-tiny\nVersion: 1.13-r1\nInstalled-Size: 31000000\nSize: 11000000\n\n')
    ]:
        (LAB / 'tmp/sizes').write_text(data)
        sizes = json.loads(inside('/usr/bin/ucode', '/usr/libexec/obhod/core-sizes.uc', manager, '/tmp/sizes'))
        assert sizes['lite']['installedBytes'] == 31000000 and sizes['lite']['downloadBytes'] == 11000000
        assert 'full' not in sizes
    print('PASS: FakeIP cache ownership, durable DNS restore retries, APK/opkg protocol size metadata')


def schema_tests():
    archive = TOOLS / 'sing-box-1.12.22-linux-amd64.tar.gz'
    checked_download('https://github.com/SagerNet/sing-box/releases/download/v1.12.22/sing-box-1.12.22-linux-amd64.tar.gz',
                     archive, '50a70a1b71064a7d8ef63737fbef2aa36c991d8dc1c54598b9513c2a15e25e9f')
    binary = TOOLS / 'sing-box-linux'
    with tarfile.open(archive) as package:
        member = next(item for item in package.getmembers() if item.name.endswith('/sing-box'))
        binary.write_bytes(package.extractfile(member).read())
    binary.chmod(0o755)
    config = ROOT / '.tmp/openwrt-config.json'
    result = run([binary, 'check', '-c', config])
    assert result.returncode == 0, result.stderr
    fake = json.loads((ROOT / '.tmp/openwrt-fakeip-config.json').read_text())
    fake_path = LAB / 'tmp/fakeip-schema.json'
    fake_path.write_text(json.dumps(fake))
    result = run([binary, 'check', '-c', fake_path])
    assert result.returncode == 0, result.stderr
    print('PASS: Linux sing-box 1.12.22 accepts full router config including nftables auto_redirect')
    # An old profile must run FakeIP even before its first save in the new LuCI.
    settings = LAB / 'etc/obhod/settings.json'
    settings.write_bytes((ROOT / '.tmp/openwrt-legacy-settings.json').read_bytes())
    original = settings.read_bytes()
    (LAB / 'var/run/obhod/controller-secret').write_text('11111111-2222-4333-8444-555555555555')
    inside('/usr/bin/ucode', '/usr/libexec/obhod/prepare.uc')
    migrated = json.loads((LAB / 'var/run/obhod/config.json').read_text())
    expected = json.loads((ROOT / '.tmp/openwrt-fakeip-config.json').read_text())
    expected['experimental']['clash_api'] = migrated['experimental']['clash_api']
    assert migrated == expected
    assert settings.read_bytes() == original
    # A new saved configuration is idempotent and retains its RAM cache.
    data = json.loads(original); data['config'] = expected
    settings.write_text(json.dumps(data))
    inside('/usr/bin/ucode', '/usr/libexec/obhod/prepare.uc')
    assert json.loads((LAB / 'var/run/obhod/config.json').read_text()) == expected
    settings.unlink()
    print('PASS: legacy profiles migrate to the shared FakeIP configuration without rewriting secrets or rules')


def rpc_tests():
    # A deterministic core stub allows startup failure injection without network rules.
    core = LAB / 'usr/bin/sing-box'
    core.write_text('#!/bin/sh\n[ "$1" = version ] && { echo "sing-box version 1.12.22"; exit 0; }\n[ ! -f /tmp/reject-config ]\n')
    core.chmod(0o755)
    manager = LAB / 'etc/init.d/obhod'
    manager.write_text('#!/bin/sh\ncase "$1" in start|restart) rm -f /var/run/obhod/ready; [ ! -f /tmp/reject-start ] || exit 1; touch /var/run/obhod/ready;; stop) rm -f /var/run/obhod/ready;; esac\n')
    manager.chmod(0o755)
    state = {'version': 1, 'profile': {'version': 6, 'tunnels': [], 'test_padding': 'x' * 150000}, 'options': {'manageDns': False}, 'config': {'outbounds': [{'type': 'direct', 'tag': 'direct'}]}}
    def call(method, body):
        result = run(['chroot', LAB, '/usr/libexec/rpcd/obhod', 'call', method], input=json.dumps(body))
        assert result.returncode == 0, result.stderr
        if method == 'subscription':
            assert not result.stderr, result.stderr
        return json.loads(result.stdout)
    first = json.dumps(state)
    assert call('apply', {'settings': first, 'start': False})['ok']
    # Small RPC requests carry a large UTF-8 profile without crossing LuCI's
    # single-string parser limit. Splits may fall inside a Unicode character.
    import uuid
    random_dir=LAB/'proc/sys/kernel/random';random_dir.mkdir(parents=True,exist_ok=True)
    (random_dir/'uuid').write_text(str(uuid.uuid4()))
    begin=call('upload',{'action':'begin'}); assert begin['ok'], begin
    token=begin['upload']
    staged=json.loads(first);staged['profile']['test_padding']='Я🌐'*21000
    content=json.dumps(staged,ensure_ascii=False).encode()
    assert len(content)>65536
    assert not call('upload',{'action':'chunk','upload':token,'index':1,'data':'YQ=='})['ok']
    for index,offset in enumerate(range(0,len(content),12288)):
        response=call('upload',{'action':'chunk','upload':token,'index':index,'data':base64.b64encode(content[offset:offset+12288]).decode()})
        assert response['ok'], response
    assert call('apply',{'settings':'','upload':token,'start':False})['ok']
    assert json.loads((LAB/'etc/obhod/settings.json').read_text())==staged
    assert not (LAB/'var/run/obhod'/('upload-'+token)).exists()
    assert not call('upload',{'action':'chunk','upload':'../../etc/config/dhcp','index':0,'data':'YQ=='})['ok']
    assert call('apply',{'settings':first,'start':False})['ok']
    previous = (LAB / 'etc/obhod/settings.json').read_bytes()
    oversized = json.loads(first)
    oversized['profile']['test_padding'] = 'x' * 220000
    assert not call('apply', {'settings': json.dumps(oversized), 'start': False})['ok']
    assert (LAB / 'etc/obhod/settings.json').read_bytes() == previous
    (LAB / 'tmp/reject-config').touch()
    assert not call('apply', {'settings': first, 'start': True})['ok']
    assert (LAB / 'etc/obhod/settings.json').read_bytes() == previous
    (LAB / 'tmp/reject-config').unlink()
    state['profile']['name'] = 'changed'
    (LAB / 'tmp/reject-start').touch()
    assert not call('apply', {'settings': json.dumps(state), 'start': True})['ok']
    assert (LAB / 'etc/obhod/settings.json').read_bytes() == previous
    (LAB / 'tmp/reject-start').unlink()
    assert call('apply', {'settings': json.dumps(state), 'start': True})['ok']
    assert call('status', {})['running']
    assert '1.12.22' in call('status', {})['version']
    assert call('stop', {})['ok']
    assert not call('status', {})['running']
    assert (LAB / 'etc/obhod/settings.json').stat().st_mode & 0o777 == 0o600
    curl = LAB / 'usr/bin/curl'
    curl.write_text('#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then cp /tmp/subscription-fixture "$2"; exit $?; fi; shift; done\nexit 1\n')
    curl.chmod(0o755)
    content = ('vless://example\\n' * 7000).encode()
    (LAB / 'tmp/subscription-fixture').write_bytes(content)
    result = call('subscription', {'url': 'https://provider.example/subscription'})
    assert result['ok'] and base64.b64decode(result['base64']) == content, { 'response': result if not result.get('ok') else None, 'decoded_bytes': len(base64.b64decode(result.get('base64', ''))), 'expected_bytes': len(content) }
    # Exercise the stock lightweight client against a local HTTP server as well.
    curl.rename(LAB / 'tmp/rpc-test-curl')
    import http.server, threading
    class SubscriptionHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = content if self.path == '/subscription' else b'x' * 180000
            self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
        def log_message(self, *args): pass
    server = http.server.HTTPServer(('127.0.0.1', 0), SubscriptionHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        result = call('subscription', {'url': f'http://127.0.0.1:{server.server_port}/subscription'})
        if not result['ok']:
            debug = run(['chroot', LAB, '/bin/uclient-fetch', '-T', '3', '-U', 'v2rayN/Obhod', '-O', '/tmp/http-debug', f'http://127.0.0.1:{server.server_port}/subscription'])
            raise AssertionError((result, debug.stdout, debug.stderr))
        assert base64.b64decode(result['base64']) == content
        assert not call('subscription', {'url': f'http://127.0.0.1:{server.server_port}/oversized'})['ok']
    finally:
        server.shutdown(); server.server_close(); thread.join()
        (LAB / 'tmp/rpc-test-curl').rename(curl)
    print('PASS: RPC save/start/stop, rejected configs, failed-start rollback and private settings')


def observability_tests():
    import http.server, threading
    state=LAB/'etc/obhod/settings.json'; previous=state.read_bytes()
    settings={'version':1,'profile':{'version':6,'routing':{'activeTunnelId':'aaa','failoverEnabled':True,'enableDiagnostics':False},'tunnels':[{'id':'aaa','name':'First'},{'id':'bbb','name':'Selected'}]},'options':{'interfaces':['br-lan']},'config':{'outbounds':[{'type':'direct','tag':'direct'}],'route':{'rules':[{'action':'sniff'}]}}}
    state.write_text(json.dumps(settings))
    secret='11111111-2222-4333-8444-555555555555'
    (LAB/'var/run/obhod/controller-secret').write_text(secret)
    inside('/usr/bin/ucode','/usr/libexec/obhod/prepare.uc')
    config=json.loads((LAB/'var/run/obhod/config.json').read_text())
    assert config['experimental']['clash_api']['secret']==secret
    assert config['experimental']['clash_api']['external_controller']=='127.0.0.1:2081'
    assert config['log']=={'level':'warn','timestamp':True} and secret not in state.read_text()
    assert next(rule for rule in config['route']['rules'] if rule['action']=='sniff')['timeout']=='1s'
    assert 'timeout' not in json.loads(state.read_text())['config']['route']['rules'][0]
    # The log remains bounded after a large stream and strips credentials.
    content=('INFO https://name:password@example.org/path?token=secret password=supersecret uuid=11111111-2222-4333-8444-555555555555 '+ 'x'*350+'\n')*600
    inside('/usr/bin/ucode','/usr/libexec/obhod/log.uc',input=content)
    journal=(LAB/'var/run/obhod/service.log').read_text()
    assert len(journal.encode())<=32768 and 'supersecret' not in journal and secret not in journal and 'password@example' not in journal
    # Populate sysfs fixtures without exposing the host's actual interfaces.
    inside('/bin/mkdir','-p','/sys/class/net/br-lan','/sys/class/net/br-guest','/sys/class/net/lo','/sys/class/net/obhod-tun')
    for name in ['br-lan','br-guest']:(LAB/'sys/class/net'/name/'operstate').write_text('up\n')
    (LAB/'tmp/network-fixture').write_text(json.dumps({'interface':[{'interface':'lan','l3_device':'br-lan','ipv4-address':[{'address':'192.0.2.1'}]}]}))
    devices=json.loads(inside('/usr/bin/ucode','/usr/libexec/obhod/inspect.uc','interfaces','/tmp/network-fixture'))['devices']
    assert {item['name'] for item in devices}=={'br-lan','br-guest'} and any('192.0.2.1' in item['label'] for item in devices)
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            assert self.headers.get('Authorization')=='Bearer '+secret
            value={'proxies':{'proxy':{'now':'tunnel-bbb'},'tunnel-bbb':{'history':[]}}} if self.path=='/proxies' else {'delay':83}
            body=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        def log_message(self,*args):pass
    server=http.server.HTTPServer(('127.0.0.1',2081),Handler)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        (LAB/'var/run/obhod/ready').touch()
        inside('/usr/libexec/obhod/monitor','once')
        metrics=json.loads((LAB/'var/run/obhod/telemetry.json').read_text())
        assert metrics['name']=='Selected' and metrics['delay']==83 and metrics['ok']
        # procd transport is stubbed, while worker execution, parsing and locks are real.
        ubus=LAB/'bin/ubus'; shutil.copyfile(ubus,LAB/'tmp/real-ubus');ubus.unlink()
        ubus.write_text('''#!/bin/sh
if [ "$1 $2 $3" = 'call service set' ]; then
 command=$(jsonfilter -s "$4" -e '@.instances.task.command[0]')
 action=$(jsonfilter -s "$4" -e '@.instances.task.command[2]')
 "$command" worker "$action" </dev/null >/dev/null 2>&1 &
 echo '{}';exit 0
fi
echo '{}'
''');ubus.chmod(0o755)
        for name,body in [('usr/sbin/nft','exit 0'),('usr/bin/nslookup','echo "Name: $2";case "$*" in *fakeip-check*) echo "Address: 198.18.0.2";; *) echo "Address: 192.0.2.1";; esac')]:
            target=LAB/name;target.unlink(missing_ok=True);target.write_text('#!/bin/sh\n'+body+'\n');target.chmod(0o755)
        def call(method,body={}):return json.loads(inside('/usr/libexec/rpcd/obhod','call',method,input=json.dumps(body)))
        assert call('status')['routeName']=='Selected'
        assert not call('service',{'action':'start;reboot'})['ok']
        assert call('diagnose')['ok']
        deadline=time.monotonic()+10
        while (LAB/'var/lock/obhod-job.lock').exists() and time.monotonic()<deadline:time.sleep(.05)
        result=call('diagnostics')
        assert len(result['checks'])==7 and all(item['ok'] for item in result['checks']), result
        assert len(call('logs')['text'].encode())<=32768
        assert call('clearLogs')['ok'] and call('logs')['text']==''
        # Both saved-state start and stop use short RPC calls.
        for action in ['stop','start','restart','stop']:
            assert call('service',{'action':action})['ok']
            deadline=time.monotonic()+10
            while (LAB/'var/lock/obhod-job.lock').exists() and time.monotonic()<deadline:time.sleep(.05)
            assert call('status')['running']==(action in ['start','restart'])
        assert call('service',{'action':'restart'})['ok']
        deadline=time.monotonic()+10
        while (LAB/'var/lock/obhod-job.lock').exists() and time.monotonic()<deadline:time.sleep(.05)
        assert call('status')['jobState']=='error' and not call('status')['running'], 'Restart cannot enable a stopped service'
    finally:
        server.shutdown();server.server_close();thread.join()
        shutil.copyfile(LAB/'tmp/real-ubus',LAB/'bin/ubus')
        state.write_bytes(previous)
    print('PASS: protected loopback controller, actual selected-route telemetry, bounded redacted RAM log, interface discovery, diagnostics and asynchronous service toggle')


def lifecycle_tests():
    # Exercise the actual supervisor and FIFO logger. A sleeping monitor must not
    # prevent core shutdown until procd's termination deadline kills the parent.
    state=LAB/'etc/obhod/settings.json'; saved=state.read_bytes()
    core=LAB/'usr/bin/sing-box'; original=core.read_bytes()
    (LAB/'proc/net').mkdir(parents=True,exist_ok=True)
    (LAB/'proc/net/tcp').write_text(' 0: 0100007F:041D 00000000:0000 0A \n')
    state.write_text('{"options":{"manageDns":false},"profile":{"routing":{},"tunnels":[]}}')
    core.write_text('#!/bin/sh\necho $$ > /tmp/lifecycle-core-pid\ntrap "exit 0" TERM INT\nwhile :; do sleep 1; done\n');core.chmod(0o755)
    process=subprocess.Popen(['chroot',str(LAB),'/usr/libexec/obhod/run'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        deadline=time.monotonic()+5
        while not (LAB/'var/run/obhod/ready').exists() and time.monotonic()<deadline:time.sleep(.05)
        assert (LAB/'var/run/obhod/ready').exists()
        time.sleep(.5)
        pid=int((LAB/'tmp/lifecycle-core-pid').read_text())
        process.terminate();process.wait(timeout=10)
        assert not (LAB/'var/run/obhod/ready').exists()
        try:os.kill(pid,0)
        except ProcessLookupError:pass
        else:raise AssertionError('Core remained alive after supervisor shutdown')
        assert not (LAB/'var/lock/obhod-monitor.lock').exists()
    finally:
        if process.poll() is None:process.kill();process.wait()
        core.write_bytes(original);core.chmod(0o755);state.write_bytes(saved)
    print('PASS: actual supervisor stops the core, FIFO logger and sleeping monitor within the procd deadline')


def installer_tests():
    directory = LAB / 'tmp/installer'
    directory.mkdir()
    for name in ['install.sh', 'installer-plan.uc', 'package-lib.sh', 'core-compat.sh', 'core-select.uc', 'core-catalog.json', 'presets.tsv', 'SHA256SUMS', 'LICENSE', 'NOTICE', 'README.md', 'obhod-0.1.16-r1.apk',
                 'luci-app-obhod-0.1.16-r1.apk', 'obhod_0.1.16-1_all.ipk', 'luci-app-obhod_0.1.16-1_all.ipk']:
        shutil.copyfile(PACKAGES / name, directory / name)
    # Resource fixtures are confined to this disposable chroot.
    (LAB / 'proc').mkdir(exist_ok=True)
    def memory(available=196608, total=262144):
        (LAB / 'proc/meminfo').write_text(f'MemTotal: {total} kB\nMemAvailable: {available} kB\n')
    memory()
    (LAB / 'tmp/free-flash').write_text('1048576')
    (LAB / 'tmp/free-tmp').write_text('1048576')
    df = LAB / 'bin/df'
    df.unlink(missing_ok=True)  # Replace the symlink, not the BusyBox binary.
    df.write_text('#!/bin/sh\nn=$(cat /tmp/free-flash); [ "$2" != /tmp ] || n=$(cat /tmp/free-tmp)\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nroot 1048576 0 %s 0%% /\\n" "$n"\n')
    df.chmod(0o755)
    # Exercise the APK planner against actual native query output before mocking installs.
    actual = inside('/usr/bin/apk', '--no-network', 'query', '--installed', '--format', 'json', '--fields', 'name,version,installed-size,file-size', '*')
    (LAB / 'tmp/native-query.json').write_text(actual)
    assert inside('/usr/bin/ucode', '/tmp/installer/installer-plan.uc', '/tmp/native-query.json', '/tmp/native-query.json') == '0 0'
    (LAB / 'tmp/apk-plan.json').write_text(json.dumps([{'name': 'sing-box', 'version': '1.13.21', 'installed-size': 33554432, 'file-size': 8388608}]))
    (LAB / 'tmp/apk-installed.json').write_text('[]')
    apk = LAB / 'usr/bin/apk'
    apk.write_text('#!/bin/sh\nprintf "apk %s\\n" "$*" >> /tmp/installer-calls\ncase "$*" in *--recursive*) cat /tmp/apk-plan.json;; *--installed*) cat /tmp/apk-installed.json;; --print-arch) echo x86_64;; --no-network*) rm -f /var/run/obhod/ready;; esac\nexit 0\n')
    apk.chmod(0o755)
    calls_file = LAB / 'tmp/installer-calls'
    state = LAB / 'etc/obhod/settings.json'
    state.unlink()
    calls_file.write_text('')
    # SmartBox screenshot: 115 MiB total, 39 MiB available, 59 MiB flash.
    memory(39936, 117760)
    (LAB / 'tmp/free-flash').write_text('61000'); (LAB / 'tmp/free-tmp').write_text('59000')
    output = inside('/bin/sh', '/tmp/installer/install.sh', '--yes')
    assert 'sing-box-tiny' in output and 'apk add sing-box-tiny ' in calls_file.read_text()
    assert ' curl ' not in calls_file.read_text()
    assert json.loads((LAB / 'etc/obhod/defaults.json').read_text())['presetIds'] == ['discord','telegram','google_ai']
    (LAB / 'etc/obhod/defaults.json').unlink()
    calls_file.write_text('')
    output = inside('/bin/sh', '/tmp/installer/install.sh', '--yes', '--protocols', 'all', '--check-only')
    assert 'мало ОЗУ' in output and 'apk add' not in calls_file.read_text()
    # 30–40 MiB flash is not rejected by the logical uncompressed size estimate.
    for flash in [30720, 40960]:
        (LAB / 'tmp/free-flash').write_text(str(flash))
        inside('/bin/sh', '/tmp/installer/install.sh', '--yes', '--protocols', 'proxy', '--check-only')
    (LAB / 'tmp/free-flash').write_text('61000')
    calls_file.write_text('')
    inside('/bin/sh', '/tmp/installer/install.sh', '--yes', '--protocols', 'none')
    assert 'apk add  firewall4' not in calls_file.read_text()  # shell word splitting removes empty core
    assert 'apk add firewall4' in calls_file.read_text() and 'apk add sing-box' not in calls_file.read_text()
    (LAB / 'etc/obhod/defaults.json').unlink()
    calls_file.write_text('')
    memory(); (LAB / 'tmp/free-flash').write_text('1048576'); (LAB / 'tmp/free-tmp').write_text('1048576')
    for available, total, flash, scratch in [(196608,262144,1024,1048576), (196608,262144,1048576,512)]:
        memory(available,total)
        (LAB / 'tmp/free-flash').write_text(str(flash)); (LAB / 'tmp/free-tmp').write_text(str(scratch))
        result = run(['chroot', LAB, '/bin/sh', '/tmp/installer/install.sh', '--yes'])
        assert result.returncode != 0 and not calls_file.read_text()
    for available, total in [(8192,262144),(60000,64000)]:
        memory(available,total)
        (LAB / 'tmp/free-flash').write_text('1048576'); (LAB / 'tmp/free-tmp').write_text('1048576')
        inside('/bin/sh', '/tmp/installer/install.sh', '--yes', '--check-only')
    calls_file.write_text('')
    memory()
    (LAB / 'tmp/free-flash').write_text('14336'); (LAB / 'tmp/free-tmp').write_text('1048576')
    result = run(['chroot', LAB, '/bin/sh', '/tmp/installer/install.sh', '--yes'])
    assert result.returncode != 0 and 'apk add' not in calls_file.read_text()
    (LAB / 'tmp/apk-installed.json').write_text('[{"name":"sing-box","version":"1.13.21"}]')
    inside('/bin/sh', '/tmp/installer/install.sh', '--yes', '--check-only')
    (LAB / 'tmp/apk-installed.json').write_text('[]')
    (LAB / 'tmp/free-flash').write_text('1048576')
    calls_file.write_text('')
    inside('/bin/sh', '/tmp/installer/install.sh', '--yes', '--check-only')
    assert 'apk add' not in calls_file.read_text() and not (LAB / 'etc/obhod/defaults.json').exists()
    calls_file.write_text('')
    inside('/bin/sh', '/tmp/installer/install.sh', '--yes')
    defaults = json.loads((LAB / 'etc/obhod/defaults.json').read_text())
    assert defaults['presetIds'] == ['russia_inside','discord','meta','telegram','google_ai']
    assert not state.exists()
    # Exercise a real terminal, as used by sh <(wget ...), rather than only flags.
    pid, terminal = pty.fork()
    if pid == 0:
        os.execvp('chroot', ['chroot', str(LAB), '/bin/sh', '/tmp/installer/install.sh'])
    os.write(terminal, b'3\n2\n')
    deadline = time.monotonic() + 15
    terminal_output = b''
    while time.monotonic() < deadline:
        if select.select([terminal], [], [], 0.2)[0]:
            try:
                part = os.read(terminal, 65536)
                if not part:
                    break
                terminal_output += part
            except OSError:
                break
    else:
        os.kill(pid, 9)
        raise AssertionError('Interactive installer timed out')
    os.close(terminal)
    _, status = os.waitpid(pid, 0)
    assert os.waitstatus_to_exitcode(status) == 0, terminal_output.decode(errors='replace')
    assert json.loads((LAB / 'etc/obhod/defaults.json').read_text())['presetIds'] == ['discord','telegram','google_ai']
    before = calls_file.read_text()
    for invalid in ['russia_inside,youtube', 'russia_inside,russia_outside', 'unknown']:
        result = run(['chroot', LAB, '/bin/sh', '/tmp/installer/install.sh', '--protocols', 'all', '--presets', invalid])
        assert result.returncode != 0 and calls_file.read_text() == before
    state.write_text('{"existing":"profile"}')
    inside('/bin/touch', '/var/run/obhod/ready')
    inside('/bin/sh', '/tmp/installer/install.sh', '--protocols', 'all', '--presets', 'minimal')
    assert state.read_text() == '{"existing":"profile"}'
    assert inside('/bin/sh', '-c', 'test -f /var/run/obhod/ready') == ''
    calls = (LAB / 'tmp/installer-calls').read_text()
    assert 'apk update' in calls and 'apk --no-network add --allow-untrusted ./obhod-0.1.16-r1.apk' in calls
    (LAB / 'etc/apk/world').unlink()
    (LAB / 'etc/openwrt_release').write_text("DISTRIB_ID='OpenWrt'\nDISTRIB_RELEASE='24.10.4'\n")
    opkg = LAB / 'bin/opkg'
    opkg.write_text('#!/bin/sh\n[ "$1" = status ] && exit 0\nprintf "opkg %s\\n" "$*" >> /tmp/installer-calls\ncase "$1" in --noaction) echo "Installing sing-box (1.12.22) to root...";; info) printf "Package: sing-box\\nInstalled-Size: 33554432\\nSize: 8388608\\n";; esac\nexit 0\n')
    opkg.chmod(0o755)
    inside('/bin/mkdir', '-p', '/var/opkg-lists')
    (LAB/'var/opkg-lists/fixture').write_text('Package: sing-box\nInstalled-Size: 33554432\nSize: 8388608\n\n')
    inside('/bin/sh', '/tmp/installer/install.sh', '--yes')
    calls = (LAB / 'tmp/installer-calls').read_text()
    assert 'opkg update' in calls and 'opkg install ./obhod_0.1.16-1_all.ipk ./luci-app-obhod_0.1.16-1_all.ipk' in calls
    shutil.copyfile(PACKAGES / 'obhod-openwrt-0.1.16.tar.gz', LAB / 'tmp/online-bundle.tar.gz')
    script = (PACKAGES / 'install-online.sh').read_text().replace("BUNDLE_API_URL=''", "BUNDLE_API_URL='https://api.github.com/repos/example/releases/assets/1'")
    (LAB / 'tmp/online-installer.sh').write_text(script)
    downloader = '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do case "$1" in --output|-O) cp /tmp/online-bundle.tar.gz "$2"; exit $?;; esac; shift; done\nexit 1\n'
    (LAB / 'usr/bin/curl').write_text(downloader)
    inside('/bin/sh', '/tmp/online-installer.sh', '--yes')
    (LAB / 'usr/bin/curl').rename(LAB / 'tmp/saved-curl')
    wget = LAB / 'usr/bin/wget'
    wget.unlink(missing_ok=True)
    wget.write_text(downloader); wget.chmod(0o755)
    inside('/bin/sh', '/tmp/online-installer.sh', '--yes')
    before_download = calls_file.read_text()
    with (LAB / 'tmp/online-bundle.tar.gz').open('ab') as target:
        target.write(b'tampered')
    result = run(['chroot', LAB, '/bin/sh', '/tmp/online-installer.sh', '--yes'])
    assert result.returncode != 0 and calls_file.read_text() == before_download
    calls = calls_file.read_text()
    with (directory / 'obhod_0.1.16-1_all.ipk').open('ab') as target:
        target.write(b'tampered')
    result = run(['chroot', LAB, '/bin/sh', '/tmp/installer/install.sh'])
    assert result.returncode != 0
    assert (LAB / 'tmp/installer-calls').read_text() == calls
    print('PASS: RAM/flash/tmp checks, native APK planning, presets, profile preservation, online curl/wget bootstrap, apk/opkg and checksums')


CORE_WORKER_TRANSPORT = '''#!/bin/sh
if [ "$1 $2 $3" = 'call service set' ]; then
 [ ! -f /tmp/reject-worker-start ] || exit 1
 if [ ! -f /tmp/skip-worker-start ]; then
  command=$(jsonfilter -s "$4" -e '@.instances.task.command[0]')
  profile=$(jsonfilter -s "$4" -e '@.instances.task.command[2]')
  token=$(jsonfilter -s "$4" -e '@.instances.task.command[3]')
  version=$(jsonfilter -s "$4" -e '@.instances.task.command[4]')
  "$command" worker "$profile" "$token" "$version" </dev/null >/dev/null 2>&1 &
 fi
fi
echo '{}'
'''


def core_job_tests():
    ubus=LAB/'bin/ubus';shutil.copyfile(ubus,LAB/'tmp/core-real-ubus');ubus.unlink()
    ubus.write_text(CORE_WORKER_TRANSPORT);ubus.chmod(0o755)
    (LAB / 'etc/apk/world').write_text('')
    (LAB / 'proc/meminfo').write_text('MemTotal: 117760 kB\nMemAvailable: 39936 kB\n')
    (LAB / 'tmp/free-flash').write_text('61000'); (LAB / 'tmp/free-tmp').write_text('59000')
    calls = LAB / 'tmp/installer-calls'; calls.write_text('')
    apk = LAB / 'usr/bin/apk'
    apk.write_text('#!/bin/sh\nprintf "apk %s\\n" "$*" >> /tmp/installer-calls\ncase "$*" in *--recursive*) cat /tmp/apk-plan.json;; *--installed*) cat /tmp/apk-installed.json;; add*) sleep 1;; esac\nexit 0\n')
    state = LAB / 'etc/obhod/settings.json'
    state.write_text('{"version":1,"profile":{"version":6,"tunnels":[]}}')
    inside('/sbin/uci', 'set', 'obhod.main.enabled=0'); inside('/sbin/uci', 'commit', 'obhod')
    (LAB / 'var/run/obhod/ready').unlink(missing_ok=True)
    def rpc(method, body):
        output = inside('/usr/libexec/rpcd/obhod', 'call', method, input=json.dumps(body))
        return json.loads(output)
    def wait_job():
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status = rpc('status', {})
            if not status['coreBusy']: return status
            time.sleep(0.05)
        raise AssertionError('Core installer did not finish')
    assert not rpc('installCore', {'profile':'lite;reboot'})['ok']
    assert not rpc('installCore', {'profile':'full','version':'1.13.21;reboot'})['ok']
    assert not rpc('installCore', {'profile':'full','version':'1.13.21-obhod.999'})['ok']
    (LAB/'tmp/reject-worker-start').touch()
    assert not rpc('installCore', {'profile':'lite'})['ok']
    assert not (LAB/'var/lock/obhod-core.lock').exists() and not (LAB/'var/lock/obhod-apply.lock').exists()
    (LAB/'tmp/reject-worker-start').unlink()
    (LAB/'tmp/skip-worker-start').touch()
    assert rpc('installCore', {'profile':'lite'})['ok']
    assert rpc('status', {})['coreBusy'], 'A newly scheduled worker gets a startup grace period'
    assert not rpc('removeCore', {})['ok'], 'Removal cannot overlap an installation'
    old_token=(LAB/'var/lock/obhod-core.lock/token').read_text().strip()
    (LAB/'var/lock/obhod-core.lock/started').write_text('1\n')
    assert not rpc('status', {})['coreBusy'], 'A worker that never started cannot hold the lock forever'
    assert not (LAB/'var/lock/obhod-apply.lock').exists()
    assert run(['chroot', LAB, '/usr/libexec/obhod/core-install', 'worker', 'lite', old_token]).returncode != 0
    (LAB/'tmp/skip-worker-start').unlink()
    (LAB / 'var/run/obhod/ready').touch()
    assert not rpc('installCore', {'profile':'lite'})['ok']
    (LAB / 'var/run/obhod/ready').unlink()
    assert rpc('installCore', {'profile':'lite'})['ok']
    assert not rpc('installCore', {'profile':'full'})['ok']
    assert not rpc('stop', {})['ok']
    assert wait_job()['coreState'] == 'done'
    assert 'apk add sing-box-tiny sing-box' in calls.read_text()
    # Downgrading must never silently break a saved WireGuard connection.
    state.write_text('{"version":1,"profile":{"version":6,"tunnels":[{"type":"wireguard"}]}}')
    before = calls.read_text()
    assert rpc('installCore', {'profile':'lite'})['ok']
    status = wait_job()
    assert status['coreState'] == 'error' and 'WireGuard' in status['coreMessage']
    assert calls.read_text() == before
    state.write_text('{"version":1,"profile":{"version":6,"tunnels":[]}}')
    assert rpc('installCore', {'profile':'full'})['ok']
    status = wait_job()
    assert status['coreState'] == 'done'
    assert "apk add sing-box !sing-box-tiny" in calls.read_text()
    assert 'мало ОЗУ' in (LAB/'var/run/obhod/core-log').read_text()
    before = calls.read_text()
    (LAB/'tmp/free-flash').write_text('1024')
    assert rpc('installCore', {'profile':'full'})['ok']
    assert wait_job()['coreState'] == 'error'
    assert calls.read_text().count('apk add ') == before.count('apk add ')
    inside('/bin/mkdir', '/var/lock/obhod-core.lock', '/var/lock/obhod-apply.lock')
    (LAB/'var/lock/obhod-core.lock/pid').write_text('2147483647\n')
    # A live package-manager child must retain the lock after its worker dies.
    pidof=LAB/'bin/pidof';pidof.rename(LAB/'tmp/core-real-pidof')
    pidof.write_text('#!/bin/sh\n[ -f /tmp/package-busy ]\n');pidof.chmod(0o755)
    (LAB/'tmp/package-busy').touch()
    assert rpc('status', {})['coreBusy']
    (LAB/'tmp/package-busy').unlink()
    status = rpc('status', {})
    assert not status['coreBusy'] and status['coreState'] == 'error' and 'прерван' in status['coreMessage']
    # A zombie still passes kill -0, but must not block subsequent operations.
    inside('/bin/mkdir', '/var/lock/obhod-core.lock', '/var/lock/obhod-apply.lock')
    (LAB/'var/lock/obhod-core.lock/pid').write_text(str(os.getpid())+'\n')
    process_dir=LAB/'proc'/str(os.getpid());process_dir.mkdir(exist_ok=True)
    (process_dir/'stat').write_text(str(os.getpid())+' (worker) Z 0 0 0\n')
    assert not rpc('status', {})['coreBusy']
    (process_dir/'stat').unlink();process_dir.rmdir()
    pidof.unlink();(LAB/'tmp/core-real-pidof').rename(pidof)
    shutil.copyfile(LAB/'tmp/core-real-ubus',ubus)
    print('PASS: asynchronous LuCI core job, serialization, injection rejection, SmartBox budget and WireGuard downgrade protection')


def apk_switch_tests():
    with tempfile.TemporaryDirectory(prefix='obhod-apk-switch-') as temporary:
        stage = Path(temporary) / 'stage'; stage.mkdir()
        root = Path(temporary) / 'root'; root.mkdir()
        for name in ['sing-box','sing-box-tiny']:
            (stage / 'core-fixture').write_text(name)
            args = [APK,'mkpkg','--info','name:'+name,'--info','version:1-r1','--info','arch:noarch','--files',stage,'--output',Path(temporary)/(name+'.apk')]
            if name.endswith('tiny'): args += ['--info','provides:sing-box','--info','depends:!sing-box']
            assert run(args).returncode == 0
        def add(*packages):
            result = run([APK,'--root',root,'--initdb','--no-network','--no-scripts','add','--allow-untrusted',*packages])
            assert result.returncode == 0, result.stdout + result.stderr
        add(Path(temporary)/'sing-box-tiny.apk')
        add(Path(temporary)/'sing-box.apk', '!sing-box-tiny')
        assert (root/'core-fixture').read_text() == 'sing-box'
        add(Path(temporary)/'sing-box-tiny.apk', 'sing-box')
        assert (root/'core-fixture').read_text() == 'sing-box-tiny'
    print('PASS: native APK atomically replaces tiny/full in both directions with shared files and world pins')


def update_tests():
    # Bootstrap the new updater onto the previously released app, as on a router.
    shutil.copyfile(APK, LAB/'usr/bin/apk'); (LAB/'usr/bin/apk').chmod(0o755)
    (LAB/'etc/apk/world').write_text('obhod-testdeps\n')
    for name in ['obhod-0.1.4-r1.apk','luci-app-obhod-0.1.4-r1.apk']:
        shutil.copyfile(PACKAGES/name, LAB/'tmp'/name)
    inside('/usr/bin/apk','--no-network','--no-scripts','add','--allow-untrusted','/tmp/obhod-0.1.4-r1.apk','/tmp/luci-app-obhod-0.1.4-r1.apk')
    base = LAB/'usr/libexec/obhod'
    for name in ['update','update-metadata.uc','package-lib.sh']:
        shutil.copyfile(ROOT/'openwrt/obhod/files/usr/libexec/obhod'/name, base/name); (base/name).chmod(0o755)
    (LAB/'usr/share/obhod/version').parent.mkdir(parents=True,exist_ok=True)
    (LAB/'usr/share/obhod/version').write_text('0.1.4\n')
    (base/'control').write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> /tmp/update-controls\nexit 0\n'); (base/'control').chmod(0o755)
    (LAB/'etc/init.d/rpcd').write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> /tmp/update-rpcd\nexit 0\n')
    (LAB/'etc/init.d/rpcd').chmod(0o755)
    ubus = LAB/'bin/ubus'; ubus.unlink(missing_ok=True)
    ubus.write_text('''#!/bin/sh
if [ "$1 $2 $3" = 'call service set' ]; then
 command=$(jsonfilter -s "$4" -e '@.instances.job.command[0]')
 action=$(jsonfilter -s "$4" -e '@.instances.job.command[2]')
 "$command" worker "$action" </dev/null >/dev/null 2>&1 &
 echo '{}'; exit 0
fi
echo '{}'
'''); ubus.chmod(0o755)
    downloader = LAB/'bin/uclient-fetch'; downloader.unlink(missing_ok=True)
    downloader.write_text('''#!/bin/sh
while [ "$#" -gt 0 ]; do case "$1" in -O) output=$2;shift;; https://*) url=$1;; esac;shift;done
case "$url" in
 https://raw.githubusercontent.com/Ktoto59/obhod-releases/main/openwrt/release.json) cp /tmp/update-metadata "$output";;
 https://api.github.com/repos/Ktoto59/obhod-releases/releases/assets/1) cp /tmp/update-bundle "$output";;
 *) exit 1;;
esac
'''); downloader.chmod(0o755)
    state = LAB/'etc/obhod/settings.json'; state.write_text('{"saved":"profile","version":1,"profile":{"version":6,"tunnels":[]}}')
    previous = state.read_bytes()
    (LAB/'var/run/obhod/ready').unlink(missing_ok=True)
    (LAB/'tmp/free-flash').write_text('61000'); (LAB/'tmp/free-tmp').write_text('59000')
    archive = (PACKAGES/'obhod-openwrt-0.1.16.tar.gz').read_bytes()
    metadata = {'version':'0.1.16','tag':'openwrt-v0.1.16','bundleUrl':'https://api.github.com/repos/Ktoto59/obhod-releases/releases/assets/1','bundleSha256':hashlib.sha256(archive).hexdigest()}
    (LAB/'tmp/update-bundle').write_bytes(archive)
    def write_metadata(data): (LAB/'tmp/update-metadata').write_text(json.dumps(data))
    def job(action):
        inside('/usr/libexec/obhod/update','start',action)
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            if not (LAB/'var/lock/obhod-update.lock').exists():
                return (LAB/'var/run/obhod/update-state').read_text().strip(), (LAB/'var/run/obhod/update-message').read_text()
            time.sleep(.05)
        raise AssertionError('Updater did not finish')
    write_metadata(metadata)
    result,message = job('check'); assert result == 'available', (result,message)
    assert state.read_bytes() == previous and not (LAB/'tmp/update-controls').exists()
    for mutation in [{'bundleUrl':'https://example.org/evil'}, {'tag':'v0.18.0'}, {'version':'0.1.16;reboot'}, {'bundleSha256':'x'*64}]:
        write_metadata({**metadata,**mutation}); result,message = job('install')
        assert result == 'error' and state.read_bytes() == previous
        assert not (LAB/'tmp/update-controls').exists()
    write_metadata(metadata)
    (LAB/'tmp/update-bundle').write_bytes(archive+b'tampered')
    result,message = job('install'); assert result == 'error' and 'Контрольная сумма' in message
    assert not (LAB/'tmp/update-controls').exists()
    # Even a correctly hashed archive must not extract traversal or symlinks.
    for mode in ['traversal','symlink']:
        buf=io.BytesIO()
        with tarfile.open(fileobj=buf,mode='w:gz') as tar:
            entry=tarfile.TarInfo('../escaped' if mode=='traversal' else 'link')
            if mode=='symlink': entry.type=tarfile.SYMTYPE;entry.linkname='/etc/obhod/settings.json'
            tar.addfile(entry)
        invalid=buf.getvalue(); (LAB/'tmp/update-bundle').write_bytes(invalid)
        write_metadata({**metadata,'bundleSha256':hashlib.sha256(invalid).hexdigest()})
        result,message=job('install'); assert result=='error' and state.read_bytes()==previous, (result,message)
    assert not (LAB/'tmp/escaped').exists()
    (LAB/'tmp/update-bundle').write_bytes(archive); write_metadata(metadata)
    result,message=job('install')
    assert result=='done', (result,message,(LAB/'var/run/obhod/update-log').read_text()[-2500:])
    assert (LAB/'usr/share/obhod/version').read_text().strip()=='0.1.16'
    assert state.read_bytes()==previous
    # The updater releases its lock before the deferred rpcd reload finishes.
    deadline=time.monotonic()+3
    while not (LAB/'tmp/update-rpcd').exists() and time.monotonic()<deadline:time.sleep(0.05)
    assert (LAB/'tmp/update-rpcd').read_text().splitlines()==['reload']
    result,message=job('check'); assert result=='current', (result,message)
    print('PASS: native APK self-update from 0.1.4, profile preservation, deferred rpcd reload, version check and unsafe metadata/archive rejection')


def ipk_tests():
    archive = TOOLS / 'rootfs-24.10.4.tar.gz'
    checked_download('https://downloads.openwrt.org/releases/24.10.4/targets/x86/64/openwrt-24.10.4-x86-64-rootfs.tar.gz',
                     archive, 'e7f8ab84eef55c7eb23492de7b0517dbc23fbedaa4abbb680fe64720c309dc03')
    with tempfile.TemporaryDirectory(prefix='obhod-opkg-lab-') as temporary:
        lab = Path(temporary)
        run(['tar', '-xzf', archive, '-C', lab], check=True)
        run(['chroot', lab, '/bin/mkdir', '-p', '/var/lock'], check=True)
        for source in PACKAGES.glob('*.ipk'):
            shutil.copyfile(source, lab / 'tmp' / source.name)
        spec = importlib.util.spec_from_file_location('builder', ROOT / 'scripts/build-openwrt-packages.py')
        builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(builder)
        control = b'Package: obhod-testdeps\nVersion: 1\nArchitecture: all\nProvides: kmod-tun, kmod-nft-tproxy, kmod-nft-queue\nDescription: Isolated test dependencies\n'
        (lab / 'tmp/testdeps.ipk').write_bytes(builder.tar_bytes({
            'debian-binary': (b'2.0\n', 0o644), 'control.tar.gz': (builder.tar_bytes({'control': (control, 0o644)}), 0o644),
            'data.tar.gz': (builder.tar_bytes({}), 0o644)}))
        result = run(['chroot', lab, '/bin/opkg', '--offline-root', '/', 'install', '/tmp/testdeps.ipk'])
        assert result.returncode == 0, result.stdout + result.stderr
        result = run(['chroot', lab, '/bin/opkg', '--offline-root', '/', 'install',
                      '/tmp/obhod_0.1.16-1_all.ipk', '/tmp/luci-app-obhod_0.1.16-1_all.ipk'])
        assert result.returncode == 0, result.stdout + result.stderr
        assert (lab / 'usr/libexec/rpcd/obhod').exists()
        assert (lab / 'www/luci-static/resources/obhod/core.js').exists()
        assert (lab / 'www/luci-static/resources/obhod/overview.css').exists()
        assert (lab / 'etc/obhod').stat().st_mode & 0o777 == 0o700
        # Real opkg mutations with a deterministic offline repository transport.
        # Dependencies and signatures are not bypassed in production code.
        def inside_lab(*args):
            result = run(['chroot', lab, *args])
            assert result.returncode == 0, result.stdout + result.stderr
            return result
        inside_lab('/bin/mkdir', '-p', '/var/opkg-lists', '/var/run/obhod', '/tmp/core-repo', '/proc')
        (lab / 'proc/meminfo').write_text('MemTotal: 262144 kB\nMemAvailable: 196608 kB\n')
        df = lab / 'bin/df'; df.unlink(missing_ok=True)
        df.write_text('#!/bin/sh\nprintf "Filesystem 1024-blocks Used Available Capacity Mounted\\nroot 1048576 0 1048576 0%% /\\n"\n'); df.chmod(0o755)
        metadata = []
        for name in ['sing-box','sing-box-tiny']:
            control = f'Package: {name}\nVersion: 1.13.21\nArchitecture: all\nInstalled-Size: 100000\nDescription: Isolated core fixture\n'
            if name.endswith('tiny'): control += 'Provides: sing-box\nConflicts: sing-box\n'
            payload = builder.tar_bytes({'debian-binary': (b'2.0\n',0o644),
                'control.tar.gz':(builder.tar_bytes({'control':(control.encode(),0o644)}),0o644),
                'data.tar.gz':(builder.tar_bytes({'usr/bin/sing-box':(name.encode(),0o755)}),0o644)})
            (lab/'tmp/core-repo'/f'{name}.ipk').write_bytes(payload)
            metadata.append(control+f'Size: {len(payload)}\nSHA256sum: {hashlib.sha256(payload).hexdigest()}\nFilename: {name}.ipk\n')
        (lab / 'var/opkg-lists/fixture').write_text('\n'.join(metadata))
        with (lab/'etc/opkg.conf').open('a') as config: config.write('\nsrc fixture file:///tmp/core-repo\n')
        config = lab/'etc/opkg.conf'
        config.write_text(config.read_text().replace('option check_signature', '# Unsigned offline test fixture'))
        native = lab/'bin/opkg'; native.rename(lab/'bin/opkg-real')
        native.write_text('''#!/bin/sh
printf '%s\\n' "$*" >> /tmp/core-calls
case "$1" in
 update) exit 0;;
 download) cp "/tmp/core-repo/$2.ipk" .; exit $?;;
 install) case "$2" in */sing-box/*.ipk) [ ! -f /tmp/reject-core ] || exit 1;; esac;;
esac
exec /bin/opkg-real --conf /etc/opkg.conf --offline-root / "$@"
'''); native.chmod(0o755)
        inside_lab('/bin/opkg','install','/tmp/core-repo/sing-box-tiny.ipk')
        core_ubus=lab/'bin/ubus';core_ubus.unlink(missing_ok=True)
        core_ubus.write_text(CORE_WORKER_TRANSPORT);core_ubus.chmod(0o755)
        def job(profile):
            inside_lab('/usr/libexec/obhod/core-install','start',profile)
            deadline = time.monotonic()+10
            while time.monotonic()<deadline:
                if not (lab/'var/lock/obhod-core.lock').exists():
                    return (lab/'var/run/obhod/core-state').read_text().strip(), (lab/'var/run/obhod/core-message').read_text()
                time.sleep(0.05)
            raise AssertionError('opkg core job did not finish')
        (lab/'tmp/reject-core').touch()
        status,message = job('full')
        assert status == 'error' and 'восстановлено' in message, (status,message,(lab/'var/run/obhod/core-log').read_text(), inside_lab('/bin/opkg','info','sing-box').stdout, inside_lab('/bin/opkg','info','sing-box-tiny').stdout)
        assert (lab/'usr/bin/sing-box').read_text() == 'sing-box-tiny'
        (lab/'tmp/reject-core').unlink()
        status,message = job('full')
        assert status == 'done', (status,message,(lab/'var/run/obhod/core-log').read_text())
        assert (lab/'usr/bin/sing-box').read_text() == 'sing-box'
        status,message = job('lite')
        assert status == 'done', (status,message,(lab/'var/run/obhod/core-log').read_text())
        assert (lab/'usr/bin/sing-box').read_text() == 'sing-box-tiny'
        # A tampered cached archive cannot cause removal of the working core.
        before = (lab/'tmp/core-calls').read_text()
        with (lab/'tmp/core-repo/sing-box.ipk').open('ab') as output: output.write(b'tampered')
        status,message = job('full')
        assert status == 'error' and 'Контрольная сумма' in message, (status,message)
        assert (lab/'usr/bin/sing-box').read_text() == 'sing-box-tiny'
        assert (lab/'tmp/core-calls').read_text().count('\nremove ') == before.count('\nremove ')
        # Exercise the same self-updater with the other supported package manager.
        inside_lab('/bin/opkg','--force-downgrade','install','/tmp/obhod_0.1.4-1_all.ipk','/tmp/luci-app-obhod_0.1.4-1_all.ipk')
        for name in ['update','update-metadata.uc','package-lib.sh']:
            target=lab/'usr/libexec/obhod'/name
            shutil.copyfile(ROOT/'openwrt/obhod/files/usr/libexec/obhod'/name,target); target.chmod(0o755)
        (lab/'usr/share/obhod').mkdir(parents=True,exist_ok=True)
        (lab/'usr/share/obhod/version').write_text('0.1.4\n')
        for relative in ['bin/ubus','bin/uclient-fetch','etc/init.d/rpcd','tmp/update-metadata','tmp/update-bundle']:
            target=lab/relative; target.unlink(missing_ok=True); shutil.copyfile(LAB/relative,target)
            if relative.startswith(('bin/','etc/')): target.chmod(0o755)
        control=lab/'usr/libexec/obhod/control'; control.write_text('#!/bin/sh\nexit 0\n');control.chmod(0o755)
        profile=lab/'etc/obhod/settings.json'; profile.write_text('{"saved":"opkg profile"}')
        inside_lab('/usr/libexec/obhod/update','start','install')
        deadline=time.monotonic()+15
        while (lab/'var/lock/obhod-update.lock').exists() and time.monotonic()<deadline: time.sleep(.05)
        result=(lab/'var/run/obhod/update-state').read_text().strip()
        assert result=='done', (result,(lab/'var/run/obhod/update-log').read_text()[-2500:])
        assert profile.read_text()=='{"saved":"opkg profile"}'
        assert (lab/'usr/share/obhod/version').read_text().strip()=='0.1.16'
    print('PASS: real OpenWrt 24.10 opkg installation of both IPK packages')
    print('PASS: native opkg tiny/full switching, verified predownload, failed-install rollback and tamper rejection')
    print('PASS: native opkg self-update from 0.1.4 preserves the saved profile')


if __name__ == '__main__':
    prepare()
    dns_tests()
    schema_tests()
    rpc_tests()
    observability_tests()
    lifecycle_tests()
    installer_tests()
    core_job_tests()
    apk_switch_tests()
    update_tests()
    ipk_tests()
