#!/usr/bin/env python3
"""Exercise experimental rule-set startup with local HTTP tunnel fixtures."""
import argparse
import copy
import json
from pathlib import Path
import queue
import socketserver
import subprocess
import tempfile
import threading


class Tunnel(socketserver.StreamRequestHandler):
    def read_request(self):
        request = self.rfile.readline().decode('ascii').split()
        while self.rfile.readline().strip():
            pass
        return request

    def handle(self):
        self.connection.settimeout(8)
        request = self.read_request()
        if request[:2] == ['CONNECT', 'lists.invalid:81']:
            self.wfile.write(b'HTTP/1.1 503 Service Unavailable\r\n\r\n')
            return
        assert request[:2] == ['CONNECT', 'lists.invalid:80'], request
        self.server.connections += 1
        if self.server.mode == 'offline':
            self.rfile.read(1)
            return
        self.wfile.write(b'HTTP/1.1 200 Connection Established\r\n\r\n')
        request = self.read_request()
        if request:
            assert request[:2] == ['GET', '/routes.json'], request
            content = (b'{"version":4,"rules":[{"domain":["routed.invalid"]}]}'
                       if self.server.mode == 'healthy' else b'not a rule set')
            self.wfile.write(
                f'HTTP/1.1 200 OK\r\nContent-Length: {len(content)}\r\n'
                'Connection: close\r\n\r\n'.encode() + content)


def start(core, config_path, config):
    config_path.write_text(json.dumps(config))
    with subprocess.Popen([core, 'run', '-c', str(config_path)],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True) as process:
        lines = queue.Queue()

        def collect():
            for line in process.stdout:
                lines.put(line)
            lines.put('')

        reader = threading.Thread(target=collect, daemon=True)
        reader.start()
        try:
            while line := lines.get(timeout=22):
                if 'sing-box started' in line:
                    process.terminate()
                    assert process.wait(timeout=5) == 0
                    return True, line
                if 'FATAL' in line:
                    assert process.wait(timeout=5) != 0
                    return False, line
            raise AssertionError('sing-box stopped before publishing startup status')
        finally:
            if process.poll() is None:
                process.kill()
            reader.join(timeout=5)


def check(core):
    with tempfile.TemporaryDirectory(prefix='obhod-rule-start-') as temporary:
        directory = Path(temporary)
        runtime = directory / 'runtime.db'
        persisted = directory / 'persistent.db'
        path = directory / 'config.json'
        config = {
            'log': {'level': 'info'},
            'outbounds': [],
            'route': {
                'final': 'auto',
                'rule_set': [{'tag': 'routes', 'type': 'remote', 'format': 'source',
                              'url': 'http://lists.invalid/routes.json',
                              'http_client': {'detour': 'auto'}, 'obhod_try_group': True}],
                'rules': [{'rule_set': ['routes'], 'action': 'route', 'outbound': 'auto'}],
            },
            'experimental': {'cache_file': {'enabled': True, 'path': str(runtime),
                                            'obhod_rule_set_path': str(persisted)}},
        }
        servers = []
        try:
            for tag in ['offline', 'malformed', 'healthy']:
                server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Tunnel)
                server.daemon_threads = True
                server.mode = tag
                server.connections = 0
                threading.Thread(target=server.serve_forever, daemon=True).start()
                servers.append(server)
                config['outbounds'].append({'type': 'http', 'tag': tag, 'server': '127.0.0.1',
                                            'server_port': server.server_address[1]})
            config['outbounds'].append({'type': 'urltest', 'tag': 'auto',
                                        'url': 'http://lists.invalid:81/health',
                                        'outbounds': [o['tag'] for o in config['outbounds']]})
            with_no_valid_list = copy.deepcopy(config)
            with_no_valid_list['outbounds'][-1]['outbounds'].remove('healthy')
            ready, reason = start(core, path, with_no_valid_list)
            assert not ready and 'no URLTest member returned a valid rule set' in reason, reason

            ready, reason = start(core, path, config)
            assert ready and servers[-1].connections > 0, reason
            assert persisted.stat().st_size > 0
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()

        # Corrupt just the volatile rule value, preserving the binary cache
        # framing and configured URL. The good persistent entry must survive.
        content = runtime.read_bytes()
        assert b'"version":4,' in content
        runtime.write_bytes(content.replace(b'"version":4,', b'"version":9,'))
        ready, reason = start(core, path, config)
        assert ready, reason

        # Simulate loss of /var/run while every configured tunnel is down.
        runtime.unlink()
        ready, reason = start(core, path, config)
        assert ready, reason

        config['route']['rule_set'][0]['url'] = 'http://lists.invalid/changed.json'
        ready, reason = start(core, path, config)
        assert not ready and 'no URLTest member returned a valid rule set' in reason, reason
        print('PASS: cold failover, malformed lists, corrupt RAM cache, offline startup and URL invalidation')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('core')
    check(parser.parse_args().core)
