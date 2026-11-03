#!/usr/bin/env python3
"""Measure real ucode pool admission, FDs, cancellation, NXDOMAIN and RSS locally."""
import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import stat
import struct
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('test-openwrt-audit.py'))
audit = importlib.util.module_from_spec(spec); spec.loader.exec_module(audit)
spec = importlib.util.spec_from_file_location('pool', Path(__file__).with_name('test-openwrt-dns-pool.py'))
pool = importlib.util.module_from_spec(spec); spec.loader.exec_module(pool)


def packet(name):
    q = b''.join(bytes([len(p)]) + p.encode() for p in name.split('.')) + b'\0\0\1\0\1'
    return b'\x42\x42\x01\x00\x00\x01' + b'\0'*6 + q


class Upstreams:
    """Record admission under a condition; replies are released explicitly."""
    def __init__(self, count):
        self.udp = []; self.tcp = []; self.clients = []; self.held = []
        self.count = 0; self.tcp_count = 0; self.buffers = {}
        self.condition = threading.Condition(); self.stopped = False
        for port in range(12053, 12053 + count):
            udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); udp.bind(('127.0.0.1', port))
            tcp = socket.socket(); tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            tcp.bind(('127.0.0.1', port)); tcp.listen(128)
            self.udp.append(udp); self.tcp.append(tcp)
        self.thread = threading.Thread(target=self.run, daemon=True); self.thread.start()

    def run(self):
        while not self.stopped:
            for fd in select.select(self.udp + self.tcp + self.clients, [], [], .05)[0]:
                if fd in self.udp:
                    data, address = fd.recvfrom(4096)
                    with self.condition:
                        self.count += 1
                        if b'nx' in data:
                            # One negative with silent losers exercises the 200ms window.
                            if fd == self.udp[0]: fd.sendto(pool.response(data, rcode=3), address)
                        else: self.held.append((fd, data, address))
                        self.condition.notify_all()
                elif fd in self.tcp:
                    client, _ = fd.accept(); self.clients.append(client); self.buffers[client] = b''
                else:
                    data = fd.recv(65536)
                    if not data: self.clients.remove(fd); self.buffers.pop(fd); fd.close()
                    else:
                        self.buffers[fd] += data
                        with self.condition:
                            while len(self.buffers[fd]) >= 2:
                                size = struct.unpack('!H',self.buffers[fd][:2])[0]
                                if len(self.buffers[fd]) < size+2: break
                                self.buffers[fd] = self.buffers[fd][size+2:]
                                self.tcp_count += 1; self.condition.notify_all()
                    # TCP upstreams intentionally stay silent until client cancellation.

    def wait_count(self, target):
        with self.condition:
            assert self.condition.wait_for(lambda: self.count >= target, 5), (self.count, target)

    def release_winners(self):
        with self.condition:
            for fd, data, address in self.held:
                if fd == self.udp[0]: fd.sendto(pool.response(data), address)
            self.held.clear()

    def close(self):
        self.stopped = True; self.thread.join(2)
        for fd in self.udp + self.tcp + self.clients: fd.close()


def main():
    lab = audit.Audit(); lab.setUp()
    try:
        for name, minor in [('random',8),('urandom',9)]:
            device = lab.lab/'dev'/name; device.unlink(missing_ok=True)
            os.mknod(device, stat.S_IFCHR | 0o666, os.makedev(1,minor))
        resolver = lab.lab/'etc/resolv.conf'
        resolver.unlink(missing_ok=True); resolver.write_text(Path('/etc/resolv.conf').read_text())
        install = lab.run_in('/usr/bin/apk', '--no-cache', 'add', 'ucode-mod-socket')
        assert install.returncode == 0, install.stderr
        for count in [2, 3, 4]:
            upstreams = Upstreams(count)
            process = None
            try:
                lab.write('tmp/pool.json', json.dumps({'mode':'parallel','port':1153,'servers':list(range(12053,12053+count))}))
                process = subprocess.Popen(['chroot', str(lab.lab), 'ucode', '/usr/libexec/obhod/dns-pool.uc', '/tmp/pool.json'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                def fd_count(): return len(list(Path(f'/proc/{process.pid}/fd').iterdir()))
                def rss(): return int(next(line.split()[1] for line in Path(f'/proc/{process.pid}/status').read_text().splitlines() if line.startswith('VmRSS:')))
                deadline = time.monotonic()+5
                while True:
                    assert process.poll() is None, process.communicate()
                    try:
                        with socket.create_connection(('127.0.0.1',1153), .1): break
                    except OSError:
                        assert time.monotonic() < deadline
                        time.sleep(.005)
                # A completed DNS roundtrip is the startup barrier, including TCP accept cleanup.
                assert pool.query(1153, 'nx-ready.example', rcode=True) == 3
                baseline = fd_count(); memory = [rss()]
                with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as client:
                    client.connect(('127.0.0.1',1153)); client.settimeout(6)
                    target = upstreams.count + 64*count
                    for i in range(64): client.send(packet(f'hold{i}.example'))
                    upstreams.wait_count(target)
                    peak = fd_count()
                    assert peak == baseline + 64*count, (baseline,peak,count)
                    assert pool.query(1153, 'overflow.example',rcode=True) == 2
                    assert upstreams.count == target, '65th exchange reached upstreams'
                    upstreams.release_winners()
                    for _ in range(64): assert client.recv(4096)[3] & 15 == 0
                    # A barrier query runs after all winners; losers never replied.
                    assert pool.query(1153, 'nx-barrier.example',rcode=True) == 3
                    assert fd_count() == baseline, (baseline,fd_count())
                    target = upstreams.count + 64*count
                    for i in range(64): client.send(packet(f'timeout{i}.example'))
                    upstreams.wait_count(target)
                    for _ in range(64): assert client.recv(4096)[3] & 15 == 2
                    assert pool.query(1153, 'nx-after-timeout.example',rcode=True) == 3
                    assert fd_count() == baseline
                    upstreams.held.clear()
                    # Twenty saturated negative batches: no cache, 1280 real exchanges.
                    latencies = []
                    for batch in range(20):
                        began = time.monotonic()
                        target = upstreams.count + 64*count
                        for i in range(64): client.send(packet(f'nx{batch}-{i}.example'))
                        upstreams.wait_count(target)
                        if batch == 0:
                            negative_peak = fd_count()
                            assert negative_peak <= baseline + 64*count
                            # Admission remains bounded throughout arbitration.
                            assert pool.query(1153,'overflow-nx.example',rcode=True) == 2
                        for _ in range(64): assert client.recv(4096)[3] & 15 == 3
                        latencies.append(time.monotonic()-began); memory.append(rss())
                    assert pool.query(1153, 'nx-drained.example',rcode=True) == 3
                    assert fd_count() == baseline
                # Cancel all sixteen permitted TCP clients, four exchanges each.
                clients = [socket.create_connection(('127.0.0.1',1153),1) for _ in range(16)]
                data = packet('cancel.example'); frame = struct.pack('!H',len(data))+data
                for client in clients: client.sendall(frame*4)
                with upstreams.condition:
                    assert upstreams.condition.wait_for(lambda: upstreams.tcp_count == 64*count, 5), upstreams.tcp_count
                assert fd_count() == baseline + 16 + 64*count
                for client in clients: client.close()
                assert pool.query(1153, 'nx-canceled.example',rcode=True) == 3
                # Cancellation is asynchronous; completed query barriers drive the loop.
                deadline = time.monotonic()+3
                while fd_count() != baseline and time.monotonic() < deadline:
                    assert pool.query(1153, 'nx-cancel-barrier.example',rcode=True) == 3
                assert fd_count() == baseline, (baseline,fd_count())
                assert max(memory) < 16384 and max(memory[-5:]) <= max(memory[1:6])+2048, memory
                print(json.dumps({'upstreams':count,'exchangesLimit':64,'baseFD':baseline,'peakFD':peak,
                    'negativePeakFD':negative_peak,'finalFD':fd_count(),'negativeQueries':1280,
                    'batchSecondsMin':round(min(latencies),3),'batchSecondsMax':round(max(latencies),3),
                    'rssKiB':memory}), flush=True)
            finally:
                if process is not None:
                    process.terminate(); process.communicate(timeout=5)
                upstreams.close()
    finally:
        lab.doCleanups()


if __name__ == '__main__': main()
