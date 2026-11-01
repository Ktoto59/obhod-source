#!/usr/bin/env python3
"""Local integration test: real OpenWrt ucode + sing-box, no router/WAN changes."""
import hashlib
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import select
import shutil
import socket
import socketserver
import struct
import stat
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / '.tmp/openwrt-tools'


def receive(sock, count):
    data = b''
    while len(data) < count:
        part = sock.recv(count-len(data))
        if not part: raise EOFError()
        data += part
    return data


def response(data, address='203.0.113.42', rcode=0):
    end = 12
    while data[end]: end += data[end]+1
    end += 5
    kind = struct.unpack('!H', data[end-4:end-2])[0]
    answer = b'\xc0\x0c\0\1\0\1\0\0\0\0\0\4'+socket.inet_aton(address) if kind == 1 else b''
    if answer and b'large' in data: answer *= 200
    if rcode:answer=b''
    return data[:2]+struct.pack('!HHHHH', 0x8180 | rcode, 1, len(answer)//16, 0, 0)+data[12:end]+answer


class UDP(socketserver.ThreadingUDPServer):
    daemon_threads = True
    def __init__(self, drop=False, address='203.0.113.42'):
        self.count = 0
        class Handler(socketserver.BaseRequestHandler):
            def handle(handler):
                self.count += 1
                packet=handler.request[0]
                if b'refused' in packet or b'all-servfail' in packet:
                    handler.request[1].sendto(response(packet,rcode=5 if b'refused' in packet else 2),handler.client_address)
                elif drop and b'servfail' in packet:
                    answer=response(packet);answer=answer[:3]+b'\x82'+answer[4:6]+b'\0\0'+answer[8:-16]
                    handler.request[1].sendto(answer,handler.client_address)
                elif not drop:handler.request[1].sendto(response(packet,address),handler.client_address)
        super().__init__(('127.0.0.1', 0), Handler)


class TCP(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    def __init__(self, proxy=False):
        self.count = 0; self.sockets = set()
        class Handler(socketserver.BaseRequestHandler):
            def handle(handler):
                client = handler.request; client.settimeout(3); self.sockets.add(client)
                remote = None
                try:
                    if proxy:
                        version, methods = receive(client, 2)
                        assert version == 5
                        receive(client, methods); client.sendall(b'\x05\x00')
                        _, cmd, _, atyp = receive(client, 4)
                        if atyp == 1: host = socket.inet_ntoa(receive(client, 4))
                        elif atyp == 3: host = receive(client, receive(client, 1)[0]).decode()
                        elif atyp == 4: host = socket.inet_ntop(socket.AF_INET6, receive(client, 16))
                        else: raise ValueError('Unexpected SOCKS address')
                        port = struct.unpack('!H', receive(client, 2))[0]
                        self.count += 1
                        if cmd != 1:
                            client.sendall(b'\x05\x07\x00\x01'+b'\0'*6); return
                        assert host == '127.0.0.1', 'Test proxy must remain local'
                        remote = socket.create_connection((host, port), 2)
                        client.sendall(b'\x05\x00\x00\x01'+b'\0'*6)
                        while True:
                            ready, _, _ = select.select([client, remote], [], [], 1)
                            for origin in ready:
                                chunk = origin.recv(65536)
                                if not chunk: return
                                (remote if origin is client else client).sendall(chunk)
                    else:
                        while True:
                            size = struct.unpack('!H', receive(client, 2))[0]
                            packet=receive(client,size)
                            if b'servfail' in packet:time.sleep(0.08)
                            answer = response(packet,rcode=5 if b'refused' in packet else 2 if b'all-servfail' in packet else 0); self.count += 1
                            client.sendall(struct.pack('!H', len(answer))+answer)
                except (OSError, EOFError): pass
                finally:
                    self.sockets.discard(client)
                    if remote: remote.close()
        super().__init__(('127.0.0.1', 0), Handler)

    def close_clients(self):
        for client in list(self.sockets):
            try: client.shutdown(socket.SHUT_RDWR)
            except OSError: pass


def query(port, name, tcp=False, timeout=3, kind=1, rcode=False):
    question = b''.join(bytes([len(part)])+part.encode() for part in name.split('.'))+b'\0'+struct.pack('!HH',kind,1)
    packet = b'\x42\x42\x01\x00\x00\x01'+b'\0'*6+question
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM if tcp else socket.SOCK_DGRAM) as sock:
        sock.settimeout(timeout); sock.connect(('127.0.0.1', port))
        if tcp:
            sock.sendall(struct.pack('!H', len(packet))+packet)
            data = receive(sock, struct.unpack('!H', receive(sock, 2))[0])
        else:
            sock.send(packet); data = sock.recv(65536)
    assert data[:2] == packet[:2] and data[2] & 128
    assert data[12:12+len(question)]==question
    if rcode:return data[3] & 15
    if data[3] & 15 or not struct.unpack('!H', data[6:8])[0]: return None
    if name.startswith('large'):assert struct.unpack('!H',data[6:8])[0]==200
    return socket.inet_ntoa(data[-4:])


def main(native_core=None):
    archive = TOOLS/'rootfs.tar.gz'
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == '55e52bb34de582a1ebe56bd50f94ff54ac7c77f5bca9cae807656d1930456da4'
    for port in [1053, 1153, 1154, 2081, *range(12053, 12065)]:
        with socket.socket() as probe: probe.bind(('127.0.0.1', port))
    servers = [UDP(drop=True), TCP(), TCP(proxy=True)]
    processes = []
    for server in servers: threading.Thread(target=server.serve_forever, daemon=True).start()
    drop, healthy, socks = servers
    try:
        with tempfile.TemporaryDirectory(prefix='obhod-dns-pool-') as directory:
            lab = Path(directory)
            subprocess.run(['tar','-xzf',archive,'-C',lab],check=True)
            for name, minor in [('null',3),('random',8),('urandom',9)]:
                device=lab/'dev'/name;device.unlink(missing_ok=True)
                os.mknod(device,stat.S_IFCHR|0o666,os.makedev(1,minor))
            for path in ['etc/obhod','var/run/obhod','usr/libexec/obhod']:(lab/path).mkdir(parents=True,exist_ok=True)
            resolver=lab/'etc/resolv.conf';resolver.unlink(missing_ok=True)
            resolver.write_text(Path('/etc/resolv.conf').read_text())
            if not native_core:
                installed=subprocess.run(['chroot',lab,'/usr/bin/apk','--no-cache','add','ucode-mod-socket'],text=True,capture_output=True)
                assert installed.returncode==0,installed.stderr
            for name in ['prepare.uc','native-dns.uc','dns-pool-config.uc','dns-pool.uc']:
                shutil.copyfile(ROOT/'openwrt/obhod/files/usr/libexec/obhod'/name,lab/'usr/libexec/obhod'/name)
            # Node generates the same graph as LuCI; all test servers are local.
            js = '''const root=process.argv[1],ports=JSON.parse(process.argv[2]);
const {defaultRouterProfile,generateRouterConfig}=require(root+'/openwrt/lib/config');
const {parseProxyUri}=require(root+'/shared/profile');
const profile=defaultRouterProfile();profile.tunnels=[parseProxyUri('socks5://127.0.0.1:'+ports[2])];
profile.routing.activeTunnelId=profile.tunnels[0].id;profile.routing.dnsResolverEnabled=true;
profile.routing.localLists=[{id:'test',name:'Test',enabled:true,domains:['selected.example'],cidrs:[]}];
const options={dnsPoolMode:'parallel',dnsUpstreams:['udp://127.0.0.1:'+ports[0],'tcp://127.0.0.1:'+ports[1]],dnsBootstrapServers:['192.0.2.53'],...JSON.parse(process.argv[3]||'{}')};
const config=generateRouterConfig(profile,options);
config.inbounds=config.inbounds.filter(i=>i.type!=='tun'&&i.type!=='mixed');
console.log(JSON.stringify({version:1,profile,options,config}));'''
            ports=[s.server_address[1] for s in servers]
            def generate(options={}):return json.loads(subprocess.check_output(['node','-e',js,str(ROOT),json.dumps(ports),json.dumps(options)]))
            settings = generate()
            settings_path = lab/'etc/obhod/settings.json'; settings_path.write_text(json.dumps(settings))
            (lab/'var/run/obhod/controller-secret').write_text('11111111-2222-4333-8444-555555555555')
            def inside(*args):
                result=subprocess.run(['chroot',lab,*args],capture_output=True,text=True)
                assert result.returncode==0,result.stderr or result.stdout
                return result
            pool_log=open(lab/'tmp/pool.log','w+')
            shutil.copyfile(native_core or TOOLS/'sing-box-linux',lab/'usr/bin/sing-box'); (lab/'usr/bin/sing-box').chmod(0o755)
            core_log = open(lab/'tmp/core.log','w+')
            def start():
                inside('/usr/bin/ucode','/usr/libexec/obhod/prepare.uc')
                if native_core:
                    inside('/usr/bin/ucode','/usr/libexec/obhod/native-dns.uc')
                    path=lab/'var/run/obhod/config.json'; runtime=json.loads(path.read_text())
                    # Test-only loopback entry points exercise each pool directly.
                    for group,port in [('direct',1153),('proxy',1154),('bootstrap',1155)]:
                        tag='bootstrap-dns' if group=='bootstrap' else group+'-dns'
                        runtime['inbounds'].append({'type':'direct','tag':'test-'+group,'listen':'127.0.0.1','listen_port':port})
                        runtime['route']['rules'].insert(0,{'inbound':['test-'+group],'action':'hijack-dns'})
                        runtime['dns']['rules'].insert(0,{'inbound':['test-'+group],'action':'route','server':tag,'disable_cache':True})
                    path.write_text(json.dumps(runtime))
                inside('/usr/bin/ucode','/usr/libexec/obhod/dns-pool-config.uc')
                listening=[1053,1153,1154,1155] if native_core else [1053]
                for group,port in [('direct',1153),('proxy',1154),('bootstrap',1155)]:
                    config=f'/var/run/obhod/dns-pool-{group}.json'
                    if not (lab/config.lstrip('/')).exists():continue
                    inside('/usr/bin/ucode','/usr/libexec/obhod/dns-pool.uc',config,'--check')
                    processes.append(subprocess.Popen(['chroot',str(lab),'/usr/bin/ucode','/usr/libexec/obhod/dns-pool.uc',config],stdout=pool_log,stderr=pool_log))
                    listening.append(port)
                processes.append(subprocess.Popen(['chroot',str(lab),'/usr/bin/sing-box','run','-c','/var/run/obhod/config.json'],stdout=core_log,stderr=core_log))
                deadline=time.monotonic()+4
                for port in listening:
                    while True:
                        try:
                            with socket.create_connection(('127.0.0.1',port),0.1):break
                        except OSError:
                            if time.monotonic()>deadline:
                                core_log.seek(0);pool_log.seek(0);raise AssertionError(core_log.read()+pool_log.read())
                            time.sleep(0.03)
            def stop():
                for p in processes:p.terminate()
                for p in processes:p.wait(timeout=5)
                processes.clear()
            start()
            started=time.monotonic()
            assert query(1153,'parallel.example')=='203.0.113.42'
            elapsed=time.monotonic()-started
            assert elapsed<1, elapsed
            assert drop.count>0 and healthy.count>0
            print(f'PASS: parallel first healthy answer with one silent upstream ({elapsed:.3f}s)')
            assert query(1153,'servfail.example')=='203.0.113.42'
            print('PASS: a fast SERVFAIL does not hide a slower successful answer')
            assert query(1153,'refused.example',rcode=True)==5
            assert query(1053,'refused.example',kind=65,rcode=True)==5
            assert query(1153,'all-servfail.example',rcode=True)==2
            core_log.flush();core_log.seek(0)
            assert not any('refused.example' in line and 'ERROR' in line for line in core_log.read().splitlines())
            print('PASS: provider REFUSED/SERVFAIL reach clients as DNS replies, not transport errors')
            assert query(1153,'selected.example')=='203.0.113.42'
            assert query(1053,'selected.example').startswith('198.18.')
            print('PASS: real upstream replies bypass FakeIP; LAN clients keep FakeIP')
            assert query(1154,'proxy.example')=='203.0.113.42' and socks.count>0
            before=socks.count
            query(1053,'selected.example',kind=16)
            assert socks.count>before
            assert query(1053,'ordinary.example',tcp=True)=='203.0.113.42'
            print('PASS: proxy DNS and selected-domain TXT travel through SOCKS; TCP client DNS works')
            assert query(1153,'large-pool.example',tcp=True)=='203.0.113.42'
            assert query(1053,'large-client.example',tcp=True)=='203.0.113.42'
            print('PASS: large DNS replies survive TCP forwarding and UDP-to-TCP fallback')
            with ThreadPoolExecutor(max_workers=16) as workers:
                assert all(value=='203.0.113.42' for value in workers.map(lambda i:query(1153,f'race{i}.example'),range(32)))
            print('PASS: simultaneous queries with identical client IDs stay isolated')
            before=healthy.count
            socks.shutdown();socks.close_clients();socks.server_close()
            try: answer=query(1154,'no-leak.example',timeout=2)
            except (TimeoutError,OSError):answer=None
            assert answer is None and healthy.count==before
            print('PASS: proxy DNS fails closed without falling back to direct upstreams')
            stop()
            saved=json.loads(settings_path.read_text()); saved['options']['dnsPoolMode']='balanced'
            settings_path.write_text(json.dumps(saved))
            start();began=time.monotonic()
            assert query(1153,'balanced.example')=='203.0.113.42' and time.monotonic()-began<1.5
            before=drop.count
            assert query(1153,'balanced-warm.example')=='203.0.113.42' and drop.count==before
            print('PASS: economical mode moves past a silent resolver and prefers the healthy one')
            stop()
            bootstrap=UDP(address='127.0.0.1');servers.append(bootstrap)
            threading.Thread(target=bootstrap.serve_forever,daemon=True).start()
            fetched=[]
            class Rules(BaseHTTPRequestHandler):
                def do_GET(self):
                    fetched.append(self.path)
                    body=b'{"version":3,"rules":[{"domain_suffix":["cold-selected.example"]}]}'
                    self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
                def log_message(self,*args):pass
            http=ThreadingHTTPServer(('127.0.0.1',0),Rules);servers.append(http)
            threading.Thread(target=http.serve_forever,daemon=True).start()
            saved=generate({'dnsUpstreams':[f'tcp://selected.example:{ports[1]}',f'tcp://127.0.0.1:{ports[1]}'],'dnsBootstrapServers':['192.0.2.53','198.51.100.53']})
            for server in saved['config']['dns']['servers']:
                if server['tag'].startswith('dns-upstream-bootstrap-'):
                    server['server']='127.0.0.1';server['server_port']=drop.server_address[1] if server['tag'].endswith('-0') else bootstrap.server_address[1]
            # Real initial HTTP list download must finish before main DNS inbounds
            # exist. HTTPS path selection is checked by the shared generator test.
            saved['config']['route']['rule_set'].append({'type':'remote','tag':'cold-start','format':'source','url':f'http://startup.example:{http.server_port}/rules.json','download_detour':'dns-infrastructure'})
            settings_path.write_text(json.dumps(saved));start()
            assert fetched==['/rules.json']
            print('PASS: cold rule-set download completes before main DNS listeners start')
            assert query(1153 if native_core else 12053,'hostname-resolved.example')=='203.0.113.42'
            assert query(1155,'bootstrap-answer.example')=='127.0.0.1' and bootstrap.count>0
            assert query(1053,'selected.example').startswith('198.18.')
            print('PASS: bootstrap has its own parallel failover and cannot recurse through FakeIP')
            rss=[]
            for p in processes[:-1]:
                rss.append(next(line.split()[1] for line in Path(f'/proc/{p.pid}/status').read_text().splitlines() if line.startswith('VmRSS:')))
            print('DNS helper RSS (x86_64 KiB):',','.join(rss))
            stop()
            saved['options']['dnsPoolMode']='single';settings_path.write_text(json.dumps(saved))
            inside('/usr/bin/ucode','/usr/libexec/obhod/dns-pool-config.uc')
            assert not list((lab/'var/run/obhod').glob('dns-pool-*.json'))
            print('PASS: automatic selection and cleanup when returning to single DNS')
            core_log.close();pool_log.close()
    finally:
        for process in processes:
            if process.poll() is None:process.terminate()
        for process in processes:
            try:process.wait(timeout=5)
            except subprocess.TimeoutExpired:process.kill();process.wait()
        if native_core and 'core_log' in locals() and not core_log.closed:
            core_log.seek(0)
            print('Native core failure log:',core_log.read())
            core_log.close()
        for server in servers:
            server.shutdown()
            if isinstance(server,TCP):server.close_clients()
            server.server_close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--native-core',type=Path)
    main(parser.parse_args().native_core)
