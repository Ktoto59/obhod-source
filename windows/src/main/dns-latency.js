const crypto = require('node:crypto');
const dgram = require('node:dgram');
const http2 = require('node:http2');
const net = require('node:net');
const tls = require('node:tls');

function makeQuery(name = 'example.com') {
  const id = crypto.randomInt(0, 0x10000);
  const labels = String(name).split('.');
  const question = Buffer.concat([
    ...labels.map((label) => {
      const value = Buffer.from(label, 'ascii');
      return Buffer.concat([Buffer.from([value.length]), value]);
    }),
    Buffer.from([0, 0, 1, 0, 1])
  ]);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return { id, packet: Buffer.concat([header, question]) };
}

function skipName(packet, offset) {
  while (offset < packet.length) {
    const length = packet[offset];
    if ((length & 0xc0) === 0xc0) return offset + 2;
    offset += 1;
    if (length === 0) return offset;
    offset += length;
  }
  throw new Error('DNS-сервер вернул повреждённый ответ.');
}

function inspectResponse(packet, id, findAddress = false) {
  if (!Buffer.isBuffer(packet) || packet.length < 12 || packet.readUInt16BE(0) !== id) {
    throw new Error('DNS-сервер вернул некорректный ответ.');
  }
  if ((packet.readUInt16BE(2) & 0x8000) === 0) throw new Error('Полученный пакет не является DNS-ответом.');
  const rcode = packet.readUInt16BE(2) & 0x000f;
  if (rcode !== 0) throw new Error(`DNS-сервер вернул ошибку ${rcode}.`);
  let offset = 12;
  const questions = packet.readUInt16BE(4);
  const answers = packet.readUInt16BE(6);
  for (let index = 0; index < questions; index += 1) offset = skipName(packet, offset) + 4;
  for (let index = 0; index < answers; index += 1) {
    offset = skipName(packet, offset);
    if (offset + 10 > packet.length) break;
    const type = packet.readUInt16BE(offset);
    const size = packet.readUInt16BE(offset + 8);
    offset += 10;
    if (findAddress && type === 1 && size === 4 && offset + 4 <= packet.length) {
      return [...packet.subarray(offset, offset + 4)].join('.');
    }
    offset += size;
  }
  if (findAddress) throw new Error('Bootstrap DNS не вернул IPv4-адрес сервера.');
  return true;
}

function withTimeout(timeout, reject, cleanup) {
  return setTimeout(() => {
    cleanup();
    reject(new Error('DNS-сервер не ответил за 5 секунд.'));
  }, timeout);
}

function queryUdp(address, packet, id, port = 53, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(net.isIP(address) === 6 ? 'udp6' : 'udp4');
    const timer = withTimeout(timeout, reject, () => socket.close());
    socket.once('error', (error) => { clearTimeout(timer); socket.close(); reject(error); });
    socket.once('message', (response) => {
      clearTimeout(timer);
      socket.close();
      try { inspectResponse(response, id); resolve(response); } catch (error) { reject(error); }
    });
    socket.send(packet, port, address);
  });
}

function queryStream(connect, packet, id, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const socket = connect();
    const chunks = [];
    let total = 0;
    const timer = withTimeout(timeout, reject, () => socket.destroy());
    const fail = (error) => { clearTimeout(timer); socket.destroy(); reject(error); };
    socket.once('error', fail);
    socket.once('secureConnect', () => send());
    socket.once('connect', () => { if (!(socket instanceof tls.TLSSocket)) send(); });
    socket.on('data', (chunk) => {
      chunks.push(chunk); total += chunk.length;
      if (total < 2) return;
      const response = Buffer.concat(chunks, total);
      const size = response.readUInt16BE(0);
      if (response.length < size + 2) return;
      clearTimeout(timer);
      socket.destroy();
      try { inspectResponse(response.subarray(2, size + 2), id); resolve(response.subarray(2, size + 2)); } catch (error) { reject(error); }
    });
    let sent = false;
    function send() {
      if (sent) return;
      sent = true;
      const length = Buffer.alloc(2);
      length.writeUInt16BE(packet.length);
      socket.write(Buffer.concat([length, packet]));
    }
  });
}

function queryHttps(host, address, path, packet, id, timeout = 5000, port = 443) {
  return new Promise((resolve, reject) => {
    const authority = `https://${net.isIP(host) === 6 ? `[${host}]` : host}`;
    const session = http2.connect(authority, {
      createConnection: () => tls.connect({ host: address, port, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['h2'] })
    });
    const timer = withTimeout(timeout, reject, () => session.destroy());
    const chunks = [];
    let status = 0;
    const fail = (error) => { clearTimeout(timer); session.destroy(); reject(error); };
    session.once('error', fail);
    const request = session.request({
      ':method': 'POST', ':path': path || '/dns-query',
      'content-type': 'application/dns-message', accept: 'application/dns-message',
      'content-length': packet.length
    });
    request.on('response', (headers) => { status = Number(headers[':status']); });
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('error', fail);
    request.on('end', () => {
      clearTimeout(timer);
      session.close();
      if (status !== 200) return reject(new Error(`DoH-сервер вернул HTTP ${status || 'ошибку'}.`));
      try { const response = Buffer.concat(chunks); inspectResponse(response, id); resolve(response); } catch (error) { reject(error); }
    });
    request.end(packet);
  });
}

async function resolveServer(server, bootstrap, timeout) {
  if (net.isIP(server)) return server;
  if (!net.isIP(bootstrap)) throw new Error('Для проверки укажите bootstrap DNS в виде IP-адреса.');
  const query = makeQuery(server);
  const response = await queryUdp(bootstrap, query.packet, query.id, 53, timeout);
  return inspectResponse(response, query.id, true);
}

async function testDnsLatency(input = {}, options = {}) {
  const protocol = ['udp', 'tcp', 'tls', 'https'].includes(input.protocol) ? input.protocol : 'tls';
  const server = String(input.server || '').trim();
  const bootstrap = String(input.bootstrap || '').trim();
  const path = String(input.path || '/dns-query').trim();
  const timeout = Number(options.timeout || 5000);
  if (!server) throw new Error('Укажите DNS-сервер.');
  if (protocol === 'https' && !path.startsWith('/')) throw new Error('Путь DoH должен начинаться с /.');
  const address = await resolveServer(server, bootstrap, timeout);
  const query = makeQuery(options.domain || 'example.com');
  const startedAt = process.hrtime.bigint();
  if (protocol === 'udp') await queryUdp(address, query.packet, query.id, options.port || 53, timeout);
  if (protocol === 'tcp') await queryStream(() => net.connect({ host: address, port: options.port || 53 }), query.packet, query.id, timeout);
  if (protocol === 'tls') {
    await queryStream(() => tls.connect({
      host: address, port: options.port || 853,
      servername: net.isIP(server) ? undefined : server, rejectUnauthorized: options.rejectUnauthorized !== false
    }), query.packet, query.id, timeout);
  }
  if (protocol === 'https') await queryHttps(server, address, path, query.packet, query.id, timeout, options.port || 443);
  return { latency: Math.max(1, Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6)), address, protocol };
}

module.exports = { inspectResponse, makeQuery, testDnsLatency };
