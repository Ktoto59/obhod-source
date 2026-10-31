const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const dns = require('node:dns').promises;
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { generateConfig, stringifyConfig, tunnelTag } = require('../../../shared/config-generator');
const { DEFAULT_CONFIG, validateConnection } = require('../../../shared/profile');
const { SystemProxy } = require('./system-proxy');
const { RuleSetService } = require('./rule-set-service');

const execFileAsync = promisify(execFile);

class SingBoxService {
  constructor({ userDataPath, appPath, resourcesPath, onEvent }) {
    this.userDataPath = userDataPath;
    this.appPath = appPath;
    this.resourcesPath = resourcesPath;
    this.onEvent = onEvent;
    this.process = null;
    this.proxy = new SystemProxy(userDataPath);
    this.ruleSets = new RuleSetService(userDataPath, (type, message) => this.emit(type, message));
    this.configPath = path.join(userDataPath, 'sing-box.json');
    this.lastError = null;
    this.startedAt = null;
    this.controllerPort = null;
    this.ruleStatus = null;
    this.engineVersion = '';
    this.stopping = false;
  }

  isRunning() { return Boolean(this.process && !this.process.killed); }
  status() {
    return {
      running: this.isRunning(), error: this.lastError, startedAt: this.startedAt,
      ruleStatus: this.ruleStatus, engineVersion: this.engineVersion
    };
  }

  async findFreePort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close((error) => error ? reject(error) : resolve(port));
      });
    });
  }

  async activeTunnel(profile) {
    if (!profile.routing.failoverEnabled) {
      return profile.tunnels.find((item) => item.id === profile.routing.activeTunnelId) || null;
    }
    if (!this.controllerPort) return null;
    const selectedTag = (await this.requestJson(this.controllerPort, '/proxies/proxy', 3000)).now;
    return profile.tunnels.find((item) => tunnelTag(item) === selectedTag) || null;
  }

  async connectionInfo(profile) {
    if (!this.isRunning()) throw new Error('Сервис не запущен.');
    const tunnel = await this.activeTunnel(profile);
    if (!tunnel) throw new Error('Не удалось определить активный сервер.');
    const host = ['wireguard', 'awg'].includes(tunnel.type) ? tunnel.endpointHost : tunnel.server;
    const url = encodeURIComponent(profile.routing.testUrl || DEFAULT_CONFIG.routing.testUrl);
    const tag = encodeURIComponent(tunnelTag(tunnel));
    try {
      const result = await this.requestJson(this.controllerPort, `/proxies/${tag}/delay?url=${url}&timeout=8000`, 12000);
      const latency = Number(result.delay);
      if (!Number.isInteger(latency) || latency < 0) throw new Error('Некорректное время ответа.');
      return { tunnelId: tunnel.id, name: tunnel.name, type: tunnel.type, host, latency, available: true };
    } catch {
      return { tunnelId: tunnel.id, name: tunnel.name, type: tunnel.type, host, latency: null, available: false };
    }
  }

  async testTunnel(input) {
    const tunnel = validateConnection(input);
    const host = ['wireguard', 'awg'].includes(tunnel.type) ? tunnel.endpointHost : tunnel.server;
    let addresses;
    try {
      addresses = await dns.lookup(host, { all: true });
    } catch {
      throw new Error(`Не удалось найти сервер «${host}». Проверьте адрес и DNS.`);
    }
    if (!addresses.length) throw new Error('Не удалось определить IP-адрес сервера.');
    const result = await this.probeTunnel(tunnel);
    return {
      ok: true, latency: result.latency,
      message: `${tunnel.type === 'wireguard' ? 'WireGuard' : (tunnel.type === 'awg' ? 'AmneziaWG' : tunnel.type.toUpperCase())}: соединение установлено через ${addresses[0].address}.`
    };
  }

  requestJson(port, requestPath, timeout = 7000) {
    return new Promise((resolve, reject) => {
      const request = http.get({ host: '127.0.0.1', port, path: requestPath, timeout }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error(`Проверка вернула код ${response.statusCode}: ${body.slice(0, 300)}`));
          try { resolve(JSON.parse(body)); } catch { reject(new Error('Проверка вернула некорректный ответ.')); }
        });
      });
      request.once('timeout', () => request.destroy(new Error('Проверка подключения превысила время ожидания.')));
      request.once('error', reject);
    });
  }

  explainProbeFailure(error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || error)
      .replace(/(?:vless|trojan|ss|hysteria2|hy2|tuic|anytls|socks5|socks|https?):\/\/\S+/gi, '[ссылка подключения скрыта]')
      .replace(/("(?:username|password|uuid|private_key)"\s*:\s*)"[^"]*"/gi, '$1"[скрыто]"')
      .replace(/\b(username|password|uuid|private[_ -]?key)\s*[:=]\s*\S+/gi, '$1=[скрыто]')
      .trim();
    if (/authentication|unauthorized|status code 401|proxyconnect tcp.*407|status code 407/i.test(detail)) {
      return 'Прокси отклонил авторизацию. Проверьте имя пользователя и пароль.';
    }
    if (/Проверка вернула код 503.*delay test/is.test(detail)) {
      return 'Прокси не пропустил проверочный запрос. Проверьте адрес, порт, имя пользователя и пароль.';
    }
    if (/connection refused|actively refused|connectex.*refused/i.test(detail)) {
      return 'Сервер отклонил подключение. Проверьте адрес, порт и доступность прокси.';
    }
    if (/timeout|timed out|deadline exceeded|превысила время ожидания/i.test(detail)) {
      return 'Прокси не ответил вовремя. Проверьте его доступность или попробуйте позже.';
    }
    if (/certificate|x509|tls handshake/i.test(detail)) {
      return 'Не удалось проверить TLS-сертификат прокси. Проверьте адрес сервера и параметры TLS.';
    }
    return `Не удалось установить соединение: ${detail.slice(0, 700)}`;
  }

  async probeTunnel(tunnel, testUrl = 'https://www.gstatic.com/generate_204') {
    const binary = await this.findBinary();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-tunnel-test-'));
    const configPath = path.join(directory, 'probe.json');
    const controllerPort = await this.findFreePort();
    const listenPort = await this.findFreePort();
    const profile = structuredClone(DEFAULT_CONFIG);
    profile.tunnels = [tunnel];
    profile.routing.activeTunnelId = tunnel.id;
    profile.routing.trafficMode = 'local-proxy';
    profile.routing.listenPort = listenPort;
    profile.routing.presetIds = [];
    profile.routing.localLists = [];
    profile.routing.remoteLists = [];
    profile.routing.dnsResolverEnabled = false;
    profile.routing.enableDiagnostics = true;
    const configuration = generateConfig(profile);
    configuration.experimental = { clash_api: { external_controller: `127.0.0.1:${controllerPort}` } };
    configuration.route.final = tunnelTag(tunnel);
    fs.writeFileSync(configPath, JSON.stringify(configuration), { mode: 0o600 });
    let child;
    let runtimeOutput = '';
    try {
      await execFileAsync(binary, ['check', '-c', configPath], { windowsHide: true, timeout: 15000 });
      child = spawn(binary, ['run', '-c', configPath], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const capture = (data) => { runtimeOutput = `${runtimeOutput}${String(data)}`.slice(-8000); };
      child.stdout.on('data', capture);
      child.stderr.on('data', capture);
      await this.waitUntilReady(child, listenPort);
      const url = encodeURIComponent(testUrl);
      const tag = encodeURIComponent(tunnelTag(tunnel));
      const result = await this.requestJson(controllerPort, `/proxies/${tag}/delay?url=${url}&timeout=8000`, 12000);
      const latency = Number(result.delay);
      if (!Number.isInteger(latency) || latency < 0) throw new Error('Ядро не вернуло задержку подключения.');
      return { latency };
    } catch (error) {
      const combined = runtimeOutput ? new Error(`${error.message}\n${runtimeOutput}`) : error;
      throw new Error(this.explainProbeFailure(combined));
    } finally {
      if (child && !child.killed) {
        child.kill();
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 2000))
        ]);
        if (!child.killed) child.kill('SIGKILL');
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }

  async recoverStaleProxy() {
    if (this.proxy.hasBackup()) {
      await this.proxy.restore();
      this.emit('status', 'Восстановлены настройки прокси после прошлого завершения');
    }
  }

  emit(type, message, extra = {}) {
    const cleanMessage = String(message).replace(/\x1b\[[0-9;]*m/g, '').trim();
    this.onEvent({ type, message: cleanMessage.slice(0, 4000), timestamp: new Date().toISOString(), ...extra });
  }

  handleEngineOutput(data) {
    const message = String(data);
    this.emit('log', message);
    if (/requires? administrator|access is denied|operation not permitted|permission denied/i.test(message)) {
      this.lastError = 'Для TUN-режима запустите Обход с правами администратора.';
      this.emit('error', this.lastError);
    } else if (/unable to update bind|address family not supported by protocol/i.test(message)) {
      this.lastError = 'WireGuard/AmneziaWG не смог открыть сетевой сокет. Выберите режим IPv4 в настройках туннеля.';
      this.emit('error', this.lastError);
    }
  }

  waitUntilReady(child, port) {
    return new Promise((resolve, reject) => {
      let output = '';
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(probeTimer);
        child.stdout.off('data', inspect);
        child.stderr.off('data', inspect);
        child.off('exit', onExit);
        if (error) reject(error); else resolve();
      };
      const inspect = (data) => {
        output = `${output}${String(data)}`.slice(-8000);
        if (/unable to update bind|address family not supported by protocol/i.test(output)) {
          finish(new Error(this.lastError || 'WireGuard/AmneziaWG не смог открыть IPv4-сокет.'));
        } else if (/\bFATAL\b/i.test(output)) {
          finish(new Error(this.lastError || 'sing-box не смог завершить запуск. Проверьте журнал сервиса.'));
        } else if (/sing-box started/i.test(output)) {
          finish();
        }
      };
      const onExit = (code) => finish(new Error(this.lastError || `sing-box завершился при запуске с кодом ${code}.`));
      const timer = setTimeout(() => finish(new Error('sing-box не завершил запуск за 45 секунд.')), 45000);
      let probeTimer;
      const probe = () => {
        if (settled) return;
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.setTimeout(500);
        socket.once('connect', () => {
          socket.destroy();
          probeTimer = setTimeout(() => finish(), 300);
        });
        const retry = () => {
          socket.destroy();
          if (!settled) probeTimer = setTimeout(probe, 100);
        };
        socket.once('error', retry);
        socket.once('timeout', retry);
      };
      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      child.once('exit', onExit);
      probe();
    });
  }

  async findBinary() {
    const candidates = [
      path.join(this.resourcesPath, 'runtime', 'sing-box.exe'),
      path.join(this.appPath, 'windows', 'runtime', 'sing-box.exe'),
      path.join(process.cwd(), 'windows', 'runtime', 'sing-box.exe')
    ];
    for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
    try {
      const { stdout } = await execFileAsync('where.exe', ['sing-box.exe'], { windowsHide: true });
      const found = stdout.split(/\r?\n/).find(Boolean);
      if (found) return found.trim();
    } catch {}
    throw new Error('sing-box.exe не найден. Поместите его в папку windows/runtime.');
  }

  async versionInfo() {
    if (this.engineVersion) return this.engineVersion;
    const binary = await this.findBinary();
    const { stdout } = await execFileAsync(binary, ['version'], { windowsHide: true, timeout: 10000 });
    this.engineVersion = String(stdout).split(/\r?\n/).find((line) => /sing-box version/i.test(line))?.trim() || 'sing-box: версия не определена';
    return this.engineVersion;
  }

  async start(profile) {
    if (this.isRunning()) return this.status();
    this.lastError = null;
    if (this.proxy.hasBackup()) await this.proxy.restore();
    const binary = await this.findBinary();
    const preparedBase = await this.ruleSets.prepare(profile);
    const prepared = await this.ruleSets.inspectPrepared(preparedBase, binary);
    this.ruleStatus = prepared.ruleStatus;
    await this.versionInfo().catch(() => {});
    this.controllerPort = await this.findFreePort();
    const runtimeProfile = { ...prepared, routing: { ...prepared.routing, controllerPort: this.controllerPort } };
    const configuration = stringifyConfig(runtimeProfile, false);
    fs.mkdirSync(this.userDataPath, { recursive: true });
    fs.writeFileSync(this.configPath, configuration, { mode: 0o600 });

    try {
      await execFileAsync(binary, ['check', '-c', this.configPath], { windowsHide: true, timeout: 15000 });
    } catch (error) {
      const detail = error.stderr || error.stdout || error.message;
      throw new Error(`sing-box отклонил конфигурацию: ${String(detail).slice(0, 1200)}`);
    }

    const child = spawn(binary, ['run', '-c', this.configPath], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.process = child;
    child.stdout.on('data', (data) => this.handleEngineOutput(data));
    child.stderr.on('data', (data) => this.handleEngineOutput(data));
    child.on('error', (error) => {
      this.lastError = error.message;
      this.emit('error', error.message);
    });
    child.on('exit', async (code) => {
      const unexpectedExit = !this.stopping;
      this.process = null;
      this.startedAt = null;
      this.controllerPort = null;
      await this.proxy.restore().catch(() => {});
      if (code && code !== 0) this.lastError = `Ядро завершилось с кодом ${code}`;
      this.emit(code === 0 ? 'status' : 'error', this.lastError || 'Ядро остановлено', { unexpectedExit });
    });

    try {
      await this.waitUntilReady(child, profile.routing.listenPort);
    } catch (error) {
      await this.stop();
      this.lastError = error.message;
      throw error;
    }
    if (!this.isRunning()) throw new Error(this.lastError || 'sing-box не удалось запустить.');
    this.startedAt = new Date().toISOString();
    if (profile.routing.trafficMode === 'system-proxy') await this.proxy.enable(profile.routing.listenPort);
    const modeMessage = profile.routing.trafficMode === 'tun'
      ? 'TUN-режим запущен: системный трафик перехватывается'
      : `Прокси запущен на 127.0.0.1:${profile.routing.listenPort}`;
    this.emit('status', modeMessage);
    return this.status();
  }

  async restart(profile) {
    if (!this.isRunning()) return this.start(profile);
    this.emit('status', 'Применяем новые правила маршрутизации…');
    await this.stop();
    return this.start(profile);
  }

  async stop() {
    const child = this.process;
    this.stopping = true;
    try {
      if (child) {
        child.kill();
        await Promise.race([
          new Promise((resolve) => child.once('exit', resolve)),
          new Promise((resolve) => setTimeout(resolve, 3000))
        ]);
        if (this.process) child.kill('SIGKILL');
        this.process = null;
        this.startedAt = null;
      }
      await this.proxy.restore();
      this.startedAt = null;
      this.controllerPort = null;
      this.emit('status', 'Обход выключен');
      return this.status();
    } finally {
      this.stopping = false;
    }
  }

  async checkProfile(profile) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-import-check-'));
    try {
      const binary = await this.findBinary();
      const prepared = await this.ruleSets.prepare(profile);
      const file = path.join(directory, 'config.json');
      fs.writeFileSync(file, stringifyConfig(prepared, false), { mode: 0o600 });
      await execFileAsync(binary, ['check', '-c', file], { windowsHide: true, timeout: 15000 });
    } catch {
      throw new Error('Не удалось проверить импортируемые настройки. Проверьте доступность списков и совместимость подключений. Текущие настройки не изменены.');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }
}

module.exports = { SingBoxService };
