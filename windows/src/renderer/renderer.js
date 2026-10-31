const $ = (id) => document.getElementById(id);
let config;
let presetCatalog = {};
let running = false;
let applyingRules = false;
let editingTunnelId = null;
let creatingTunnel = false;
let serviceStartedAt = null;
let latencyUpdating = false;
let ruleStatus = null;
let engineVersion = 'sing-box: версия не определена';
let publicIp = '';
let publicIpUpdating = false;
let onboardingStep = 1;
let onboardingActive = false;
let onboardingWaitingForRules = false;
let routingSaveDirty = false;
let toastTimer;
let proxyImportVersion = 0;
let installedApplicationCandidates = [];
let runningApplicationCandidates = [];
let fileApplicationCandidates = [];
let selectedApplicationPaths = new Set();
let installedApplicationsLoaded = false;
let runningApplicationsLoaded = false;
let updaterState = { type: 'idle', message: 'Обновления ещё не проверялись.', version: '', checkedAt: null };
const REGIONAL_PRESETS = ['russia_inside', 'russia_outside', 'ukraine_inside'];
const ALLOWED_WITH_RUSSIA_INSIDE = new Set([
  'russia_inside', 'meta', 'twitter', 'discord', 'telegram', 'cloudflare',
  'google_ai', 'google_play', 'hetzner', 'ovh', 'hodca', 'roblox',
  'digitalocean', 'cloudfront'
]);
const INCLUDED_IN_RUSSIA_INSIDE = new Set([
  'geoblock', 'block', 'porn', 'news', 'anime', 'youtube', 'hdrezka', 'tiktok'
]);

const DNS_PRESETS = Object.freeze({
  cloudflare: { plain: '1.1.1.1', tls: 'one.one.one.one', https: ['cloudflare-dns.com', '/dns-query'], bootstrap: '1.1.1.1' },
  google: { plain: '8.8.8.8', tls: 'dns.google', https: ['dns.google', '/dns-query'], bootstrap: '8.8.8.8' },
  quad9: { plain: '9.9.9.9', tls: 'dns.quad9.net', https: ['dns.quad9.net', '/dns-query'], bootstrap: '9.9.9.9' },
  'quad9-unfiltered': { plain: '9.9.9.10', tls: 'dns10.quad9.net', https: ['dns10.quad9.net', '/dns-query'], bootstrap: '9.9.9.10' },
  adguard: { plain: '94.140.14.14', tls: 'dns.adguard-dns.com', https: ['dns.adguard-dns.com', '/dns-query'], bootstrap: '94.140.14.14' },
  controld: { plain: '76.76.2.0', tls: 'p0.freedns.controld.com', https: ['freedns.controld.com', '/p0'], bootstrap: '76.76.2.0' },
  'controld-ads': { plain: '76.76.2.2', tls: 'p2.freedns.controld.com', https: ['freedns.controld.com', '/p2'], bootstrap: '76.76.2.2' }
});

const activeTunnelField = $('activeTunnel').closest('label');
const activeTunnelCaption = document.createElement('span');
activeTunnelCaption.className = 'field-caption';
activeTunnelCaption.textContent = 'Основное подключение';
activeTunnelField.firstChild.replaceWith(activeTunnelCaption);
const activeFailoverSummary = document.createElement('div');
activeFailoverSummary.className = 'route-source-summary';
activeFailoverSummary.hidden = true;
const activeFailoverCopy = document.createElement('span');
const activeFailoverTitle = document.createElement('b');
activeFailoverTitle.id = 'activeFailoverTitle';
const activeFailoverDetail = document.createElement('small');
activeFailoverDetail.id = 'activeFailoverDetail';
activeFailoverCopy.append(activeFailoverTitle, activeFailoverDetail);
const openFailoverSettings = document.createElement('button');
openFailoverSettings.type = 'button';
openFailoverSettings.className = 'route-source-action';
openFailoverSettings.textContent = 'Изменить группу';
activeFailoverSummary.append(activeFailoverCopy, openFailoverSettings);
activeTunnelField.append(activeFailoverSummary);
document.querySelector('.routing-general .panel-title h2').textContent = 'Основные параметры';
document.querySelector('#settings-routing > header p:last-child').textContent = 'Как направлять трафик через подключение или группу';

function splitValues(value) {
  return String(value || '').split(/[\r\n,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').className = error ? 'show error' : 'show';
  $('toast').setAttribute('aria-live', error ? 'assertive' : 'polite');
  toastTimer = setTimeout(() => { $('toast').className = ''; }, error ? 6500 : 3000);
}

const domainPreview = document.createElement('p');
domainPreview.id = 'domainPreview';
domainPreview.className = 'domain-preview';
domainPreview.setAttribute('aria-live', 'polite');
$('localDomains').closest('label').after(domainPreview);
$('localDomains').setAttribute('aria-describedby', 'domainPreview');
$('localDomains').placeholder = 'example.com или https://example.com/page';
function updateDomainPreview() {
  try {
    const domains = normalizeDomains($('localDomains').value);
    domainPreview.textContent = domains.length
      ? `Будут добавлены: ${domains.join(', ')}. Включая все поддомены; путь страницы не учитывается.`
      : 'Вставьте домен или ссылку на сайт. Правило распространяется и на его поддомены.';
    domainPreview.classList.remove('error');
    $('localDomains').setAttribute('aria-invalid', 'false');
    return true;
  } catch (error) {
    domainPreview.textContent = error.message;
    domainPreview.classList.add('error');
    $('localDomains').setAttribute('aria-invalid', 'true');
    return false;
  }
}
$('localDomains').addEventListener('input', updateDomainPreview);
$('openJournal').addEventListener('click', () => showView('diagnostics'));

function cleanErrorMessage(error) {
  return String(error?.message || error || 'Неизвестная ошибка')
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim();
}

function log(message, type = 'log') {
  if (config && !config.routing.enableDiagnostics && type === 'log') return;
  const line = `[${new Date().toLocaleTimeString('ru-RU')}] ${message}`;
  $('log').textContent = `${$('log').textContent}\n${line}`.trim().slice(-18000);
  $('log').scrollTop = $('log').scrollHeight;
  if (type === 'error') toast(message, true);
}

async function guarded(action) {
  try { return await action(); }
  catch (error) { log(cleanErrorMessage(error), 'error'); return null; }
}

function activeTunnel() {
  return config.tunnels.find((item) => item.id === config.routing.activeTunnelId) || null;
}

function protocolTitle(type) {
  return { wireguard: 'WireGuard', awg: 'AmneziaWG', socks5: 'SOCKS5', http: 'HTTP-прокси', vless: 'VLESS', shadowsocks: 'Shadowsocks', trojan: 'Trojan', hysteria2: 'Hysteria2', tuic: 'TUIC', anytls: 'AnyTLS' }[type] || type;
}

function resetScroll() {
  window.scrollTo(0, 0);
  if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
}

function showView(name) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  updateNavigation(name);
  document.querySelector('.app-shell').classList.toggle('home-active', name === 'home');
  resetScroll();
}

function showSettingsPane(name) {
  document.querySelectorAll('.settings-pane').forEach((pane) => pane.classList.toggle('active', pane.id === `settings-${name}`));
  document.querySelectorAll('.settings-tab').forEach((button) => button.classList.toggle('active', button.dataset.settingsPane === name));
  document.querySelector('.settings-tabs').hidden = ['tunnels', 'routing'].includes(name);
  document.querySelector('.routing-save-bar').hidden = ['tunnels', 'backup', 'app'].includes(name);
  updateNavigation('settings');
  resetScroll();
}

function updateNavigation(view) {
  const pane = document.querySelector('.settings-pane.active')?.id.replace('settings-', '');
  const navPane = ['tunnels', 'routing'].includes(pane) ? pane : 'general';
  document.querySelectorAll('.nav-item').forEach((button) => {
    const active = button.dataset.view === view && (view !== 'settings' || button.dataset.pane === navPane);
    button.classList.toggle('active', active || (view === 'diagnostics' && button.dataset.view === 'help'));
  });
}

function renderUpdateState(state = updaterState) {
  updaterState = { ...updaterState, ...state };
  $('updateStatus').textContent = updaterState.message;
  const busy = updaterState.type === 'checking' || updaterState.type === 'downloading';
  $('checkUpdates').disabled = busy;
  $('downloadUpdate').hidden = !(updaterState.version
    && (updaterState.type === 'available' || updaterState.type === 'error'));
  $('downloadUpdate').disabled = busy;
  $('installUpdate').hidden = updaterState.type !== 'ready';
  if (updaterState.checkedAt) {
    $('lastUpdateCheck').textContent = `Последняя проверка: ${new Date(updaterState.checkedAt).toLocaleString('ru-RU')}`;
  } else {
    $('lastUpdateCheck').textContent = 'Автоматическая загрузка отключена';
  }
  const hasUpdate = Boolean(updaterState.version)
    && ['available', 'downloading', 'ready', 'error'].includes(updaterState.type);
  const dismissed = config?.routing.dismissedUpdateVersion === updaterState.version;
  const showBanner = hasUpdate && !dismissed;
  $('updateBanner').hidden = !showBanner;
  $('view-home').classList.toggle('has-update-banner', showBanner);
  $('updateBannerVersion').textContent = updaterState.version ? `v${updaterState.version}` : '';
}

function setRunning(value) {
  const stateChanged = running !== value;
  running = value;
  if (!running) serviceStartedAt = null;
  const tunnel = activeTunnel();
  const homeView = $('view-home');
  const appShell = document.querySelector('.app-shell');
  homeView.classList.toggle('service-running', running);
  homeView.classList.toggle('service-stopped', !running);
  appShell.classList.toggle('service-running', running);
  appShell.classList.toggle('service-stopped', !running);
  if (stateChanged) {
    const transitionClass = running ? 'service-turning-on' : 'service-turning-off';
    homeView.classList.remove('service-turning-on', 'service-turning-off');
    appShell.classList.remove('service-turning-on', 'service-turning-off');
    void homeView.offsetWidth;
    homeView.classList.add(transitionClass);
    appShell.classList.add(transitionClass);
    setTimeout(() => {
      homeView.classList.remove(transitionClass);
      appShell.classList.remove(transitionClass);
    }, 1250);
  }
  $('tunnelVisual').classList.remove('connecting');
  $('tunnelVisual').classList.toggle('running', running);
  $('sideStatus').textContent = running ? 'Сервис работает' : 'Сервис выключен';
  $('sideTunnel').textContent = config.routing.failoverEnabled
    ? `Автовыбор · ${config.routing.failoverTunnelIds.length}` : (tunnel?.name || 'Подключение не выбрано');
  $('sideDot').parentElement.classList.toggle('online', running);
  $('powerButton').classList.toggle('running', running);
  $('powerButton').setAttribute('aria-pressed', String(running));
  $('powerButton').setAttribute('aria-label', running ? 'Выключить Обход' : 'Включить Обход');
  $('powerButton').querySelector('b').textContent = running ? 'СТОП' : 'ПУСК';
  $('serviceTitle').textContent = running ? 'Маршрутизация активна' : 'Маршрутизация выключена';
  $('homeRouteStatus').textContent = running
    ? (config.routing.failoverEnabled ? 'Автовыбор' : 'Активен') : 'Выключен';
  $('serviceText').textContent = running
    ? (config.routing.failoverEnabled
      ? `Активна группа автоматического переключения из ${config.routing.failoverTunnelIds.length} подключений.`
      : `Выбранный трафик направляется через «${tunnel?.name || 'подключение'}».`)
    : 'Настройте подключение и правила, затем включите сервис.';
  if (running) {
    setTimeout(updateLatency, 300);
    setTimeout(updatePublicIp, 500);
  }
  else {
    $('homeLatency').textContent = 'Не проверено';
    $('homeLatencyDetail').textContent = 'Запустите маршрутизацию';
    $('homeHealthCard').classList.remove('available', 'unavailable');
  }
}

function setRoutingDirty(value) {
  routingSaveDirty = value;
  $('cancelRouting').disabled = !value;
  $('saveRouting').disabled = !value;
  $('routingSaveHint').textContent = value ? 'Есть несохранённые изменения' : 'Все изменения сохранены';
  document.querySelector('.routing-save-bar').classList.toggle('dirty', value);
}

async function updatePublicIp() {
  if (!running || publicIpUpdating) return;
  publicIpUpdating = true;
  try {
    publicIp = await window.obhod.publicIp();
    $('homePublicIp').textContent = `Внешний IP системы: ${publicIp}`;
  } catch {
    $('homePublicIp').textContent = 'Внешний IP системы: недоступен';
  } finally {
    publicIpUpdating = false;
  }
}

async function updateLatency() {
  if (!running || latencyUpdating || !config) return;
  latencyUpdating = true;
  if ($('homeLatency').textContent === 'Не проверено') $('homeLatencyDetail').textContent = 'Проверяем через активный маршрут…';
  try {
    const result = await window.obhod.connectionInfo(config);
    $('homeTunnel').textContent = result.name;
    $('homeTunnel').title = result.name;
    $('homeProtocol').textContent = config.routing.failoverEnabled
      ? `${protocolTitle(result.type)} · выбран автоматически` : protocolTitle(result.type);
    $('sideTunnel').textContent = result.name;
    const available = result.available !== false && Number.isInteger(result.latency);
    $('homeLatency').textContent = available ? `${result.latency} мс` : 'Нет ответа';
    $('homeLatencyDetail').textContent = available
      ? 'Контрольный HTTPS-запрос прошёл через маршрут'
      : 'Контрольный адрес не ответил через маршрут';
    $('homeHealthCard').classList.toggle('available', available);
    $('homeHealthCard').classList.toggle('unavailable', !available);
  } catch {
    $('homeLatency').textContent = 'Нет данных';
    $('homeLatencyDetail').textContent = 'Не удалось проверить активный маршрут';
    $('homeHealthCard').classList.remove('available');
    $('homeHealthCard').classList.add('unavailable');
  } finally {
    latencyUpdating = false;
  }
}

function updateRuntimeStats() {
  if (!running || !serviceStartedAt) {
    $('homeUptime').textContent = 'не запущен';
    return;
  }
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(serviceStartedAt).getTime()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  $('homeUptime').textContent = `работает ${hours ? `${hours} ч ` : ''}${minutes} мин`;
}

function setConnecting(value) {
  $('view-home').classList.toggle('service-connecting', value);
  document.querySelector('.app-shell').classList.toggle('service-connecting', value);
  $('tunnelVisual').classList.toggle('connecting', value);
  if (value) {
    $('powerButton').querySelector('b').textContent = 'ЗАПУСК';
    $('serviceTitle').textContent = 'Подключаем туннель…';
    $('serviceText').textContent = 'Проверяем конфигурацию и поднимаем маршрут.';
  } else if (!running) {
    $('powerButton').querySelector('b').textContent = 'ПУСК';
    $('serviceTitle').textContent = 'Маршрутизация выключена';
    $('serviceText').textContent = 'Настройте подключение и правила, затем включите сервис.';
  }
}

function renderSummary() {
  const tunnel = activeTunnel();
  const tunnelTitle = config.routing.failoverEnabled
    ? `Автовыбор · ${config.routing.failoverTunnelIds.length}` : (tunnel?.name || 'Не выбран');
  $('homeTunnel').textContent = tunnelTitle;
  $('homeProtocol').textContent = config.routing.failoverEnabled ? 'Подключение выбирается автоматически' : (tunnel ? protocolTitle(tunnel.type) : '—');
  const modeTitle = { tun: 'TUN', 'system-proxy': 'Прокси Windows', 'local-proxy': 'Локальный прокси' }[config.routing.trafficMode] || 'TUN';
  $('homeMode').textContent = modeTitle;
  $('homeMode').title = modeTitle;
  $('homeTunnel').title = tunnelTitle;
  const enabledLists = [...config.routing.localLists, ...config.routing.remoteLists].filter((item) => item.enabled).length;
  const enabledApplications = (config.routing.applicationRules || []).filter((item) => item.enabled).length;
  const configuredSources = config.routing.presetIds.length + enabledLists;
  const shownStatus = running ? ruleStatus : null;
  const sourceCount = shownStatus?.sourcesReady ?? configuredSources;
  const sourceForm = sourceCount % 10 === 1 && sourceCount % 100 !== 11
    ? 'источник'
    : ([2, 3, 4].includes(sourceCount % 10) && ![12, 13, 14].includes(sourceCount % 100) ? 'источника' : 'источников');
  $('homeRules').textContent = `${sourceCount} ${sourceForm}`;
  const entriesLabel = shownStatus?.entriesComplete === false
    ? `не менее ${shownStatus.knownEntries} записей` : `${shownStatus?.knownEntries ?? 0} записей`;
  $('homeRuleDetail').textContent = shownStatus
    ? `${entriesLabel} · ${shownStatus.sourcesReady} источников`
    : `${config.routing.presetIds.length} пресетов · ${enabledLists} своих списков`;
  if (enabledApplications) $('homeRuleDetail').textContent += ` · ${enabledApplications} прилож.`;
  const hasWarnings = Boolean(shownStatus?.warnings?.length);
  $('homeRulesCard').classList.toggle('warning', hasWarnings);
  if (hasWarnings) $('homeRuleDetail').textContent = `${shownStatus.warnings.length} предупрежд. · ${entriesLabel}`;
  $('homePublicIp').textContent = publicIp ? `Внешний IP системы: ${publicIp}` : 'Внешний IP системы: —';
  $('sideTunnel').textContent = tunnelTitle;
  updateRuntimeStats();
}

function makeTunnelCard(tunnel) {
  const card = document.createElement('button');
  card.className = `tunnel-card${editingTunnelId === tunnel.id ? ' active' : ''}`;
  card.type = 'button';
  if (tunnel.id === config.routing.activeTunnelId) {
    const active = document.createElement('span'); active.className = 'active-label'; active.textContent = 'АКТИВНЫЙ'; card.append(active);
  }
  const name = document.createElement('b'); name.textContent = tunnel.name;
  const protocol = document.createElement('small'); protocol.className = 'protocol-label'; protocol.textContent = protocolTitle(tunnel.type);
  const endpoint = document.createElement('small'); endpoint.textContent = `${tunnel.endpointHost || tunnel.server}:${tunnel.endpointPort || tunnel.serverPort}`;
  card.append(name, protocol, endpoint);
  card.addEventListener('click', () => openTunnelEditor(tunnel.id));
  return card;
}

function renderTunnels() {
  const cards = config.tunnels.map(makeTunnelCard);
  if (creatingTunnel) {
    const draft = document.createElement('div');
    draft.className = 'tunnel-card draft active';
    const badge = document.createElement('span'); badge.className = 'draft-label'; badge.textContent = 'СОЗДАЁТСЯ';
    const name = document.createElement('b'); name.textContent = 'Новое подключение';
    const hint = document.createElement('small'); hint.textContent = 'Черновик ещё не сохранён';
    draft.append(badge, name, hint);
    cards.unshift(draft);
  }
  $('tunnelCards').replaceChildren(...cards);
  $('tunnelEmpty').hidden = config.tunnels.length > 0;
  $('tunnelCount').textContent = String(config.tunnels.length);
  const select = $('activeTunnel');
  select.replaceChildren();
  const failoverList = $('failoverTunnels');
  failoverList.replaceChildren();
  if (!config.tunnels.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = 'Сначала создайте туннель'; select.append(option);
  } else {
    for (const tunnel of config.tunnels) {
      const option = document.createElement('option'); option.value = tunnel.id; option.textContent = tunnel.name; select.append(option);
      const failoverOption = document.createElement('label'); failoverOption.className = 'failover-tunnel-option';
      const failoverInput = document.createElement('input'); failoverInput.type = 'checkbox'; failoverInput.value = tunnel.id;
      failoverInput.checked = config.routing.failoverTunnelIds.includes(tunnel.id);
      const copy = document.createElement('span');
      const title = document.createElement('b'); title.textContent = tunnel.name;
      const details = document.createElement('small');
      details.textContent = `${protocolTitle(tunnel.type)} · ${tunnel.endpointHost || tunnel.server}:${tunnel.endpointPort || tunnel.serverPort}`;
      copy.append(title, details); failoverOption.append(failoverInput, copy); failoverList.append(failoverOption);
      failoverInput.addEventListener('change', updateFailoverSelectionCount);
    }
    select.value = config.routing.activeTunnelId || config.tunnels[0].id;
  }
  if (!config.tunnels.length) {
    const empty = document.createElement('p'); empty.className = 'failover-tunnel-empty'; empty.textContent = 'Сначала создайте подключения.';
    failoverList.append(empty);
  }
  updateFailoverSelectionCount();
}

function updateFailoverSelectionCount() {
  const inputs = [...document.querySelectorAll('#failoverTunnels input')];
  const count = inputs.filter((input) => input.checked).length;
  $('failoverSelectedCount').textContent = `Выбрано: ${count}`;
  $('failoverSelectAll').checked = inputs.length > 0 && count === inputs.length;
  $('failoverSelectAll').indeterminate = count > 0 && count < inputs.length;
  $('failoverSelectAll').disabled = inputs.length === 0;
}

function emptyTunnel() {
  return { id: crypto.randomUUID(), type: 'wireguard', name: '', privateKey: '', addresses: [], dns: [], mtu: 1408,
    peerPublicKey: '', preSharedKey: '', endpointHost: '', endpointPort: 51820,
    allowedIps: ['0.0.0.0/0', '::/0'], keepalive: 25, networkFamily: 'ipv4',
    jc: 0, jmin: 0, jmax: 0, s1: 0, s2: 0, s3: 0, s4: 0,
    h1: '', h2: '', h3: '', h4: '', i1: '', i2: '', i3: '', i4: '', i5: '',
    server: '', serverPort: 443, username: '', uuid: '', password: '', method: 'chacha20-ietf-poly1305',
    flow: '', tlsEnabled: false, realityEnabled: false, serverName: '', insecure: false,
    fingerprint: 'chrome', realityPublicKey: '', realityShortId: '', transportType: 'none', transportPath: '', transportHost: '',
    obfsType: 'none', obfsPassword: '', upMbps: 0, downMbps: 0, congestionControl: 'cubic', udpRelayMode: 'native',
    zeroRttHandshake: false, idleSessionCheckInterval: '30s', idleSessionTimeout: '30s', minIdleSession: 0 };
}

function renderProtocolFields(type) {
  const wireguard = ['wireguard', 'awg'].includes(type);
  const shadowsocks = type === 'shadowsocks';
  const hysteria2 = type === 'hysteria2';
  const tuic = type === 'tuic';
  const anytls = type === 'anytls';
  const basicProxy = ['socks5', 'http'].includes(type);
  const socks5 = type === 'socks5';
  const modernTls = hysteria2 || tuic || anytls;
  $('wireguardFields').hidden = !wireguard;
  $('proxyFields').hidden = wireguard;
  $('awgFields').hidden = type !== 'awg';
  $('proxyUsernameLabel').hidden = !basicProxy;
  $('proxyCredentialLabel').firstChild.textContent = ['vless', 'tuic'].includes(type) ? 'UUID' : (basicProxy ? 'Пароль (необязательно)' : 'Пароль');
  $('proxySecondaryCredentialLabel').hidden = !tuic;
  $('proxyMethodLabel').hidden = type !== 'shadowsocks';
  $('proxyFlowLabel').hidden = type !== 'vless';
  $('proxyReality').closest('label').hidden = type !== 'vless';
  $('proxyRealityKey').closest('label').hidden = type !== 'vless';
  $('proxyShortId').closest('label').hidden = type !== 'vless';
  $('proxyTls').closest('label').hidden = shadowsocks || socks5;
  $('proxyTls').disabled = modernTls;
  if (modernTls) $('proxyTls').checked = true;
  $('proxySni').closest('label').hidden = shadowsocks || socks5;
  $('proxyFingerprint').closest('label').hidden = shadowsocks || hysteria2 || tuic || basicProxy;
  $('proxyInsecure').closest('label').hidden = shadowsocks || socks5;
  $('proxyTransport').closest('label').hidden = shadowsocks || modernTls || basicProxy;
  $('proxyPath').closest('label').hidden = shadowsocks || modernTls || basicProxy;
  $('proxyHost').closest('label').hidden = shadowsocks || modernTls || basicProxy;
  $('proxyObfsTypeLabel').hidden = !hysteria2;
  $('proxyObfsPasswordLabel').hidden = !hysteria2;
  $('proxyUpMbpsLabel').hidden = !hysteria2;
  $('proxyDownMbpsLabel').hidden = !hysteria2;
  $('proxyCongestionLabel').hidden = !tuic;
  $('proxyUdpRelayLabel').hidden = !tuic;
  $('proxyZeroRttLabel').hidden = !tuic;
  $('proxyIdleCheckLabel').hidden = !anytls;
  $('proxyIdleTimeoutLabel').hidden = !anytls;
  $('proxyMinIdleLabel').hidden = !anytls;
}

function openTunnelEditor(id = null, imported = null) {
  const tunnel = imported || config.tunnels.find((item) => item.id === id) || emptyTunnel();
  editingTunnelId = id;
  creatingTunnel = !id;
  $('tunnelType').value = tunnel.type || 'wireguard';
  renderProtocolFields($('tunnelType').value);
  $('tunnelEditor').classList.toggle('creating', creatingTunnel);
  $('tunnelEditor').classList.toggle('editing', !creatingTunnel);
  $('tunnelEditorEyebrow').textContent = creatingTunnel ? 'СОЗДАНИЕ' : 'РЕДАКТИРОВАНИЕ';
  $('tunnelEditorTitle').textContent = creatingTunnel ? 'Новое подключение' : tunnel.name;
  $('tunnelEditorHint').textContent = creatingTunnel
    ? 'Создаётся отдельный профиль — существующие подключения не изменятся.'
    : 'Изменения будут сохранены в этом подключении.';
  $('tunnelEditorMode').textContent = creatingTunnel ? 'НОВЫЙ' : 'СОХРАНЁН';
  $('tunnelName').value = tunnel.name;
  $('tunnelAddresses').value = (tunnel.addresses || []).join(', ');
  $('tunnelPrivateKey').value = tunnel.privateKey || '';
  $('tunnelDns').value = (tunnel.dns || []).join(', ');
  $('tunnelMtu').value = tunnel.mtu || 1408;
  $('peerPublicKey').value = tunnel.peerPublicKey || '';
  $('preSharedKey').value = tunnel.preSharedKey || '';
  $('endpointHost').value = tunnel.endpointHost || '';
  $('endpointPort').value = tunnel.endpointPort || 51820;
  $('allowedIps').value = (tunnel.allowedIps || ['0.0.0.0/0', '::/0']).join(', ');
  $('keepalive').value = tunnel.keepalive ?? 25;
  $('networkFamily').value = tunnel.networkFamily || 'ipv4';
  for (const field of ['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4', 'h1', 'h2', 'h3', 'h4', 'i1', 'i2', 'i3', 'i4', 'i5']) {
    $(`awg${field[0].toUpperCase()}${field.slice(1)}`).value = tunnel[field] ?? '';
  }
  $('proxyServer').value = tunnel.server || '';
  $('proxyPort').value = tunnel.serverPort || (tunnel.type === 'socks5' ? 1080 : (tunnel.type === 'http' ? 8080 : 443));
  $('proxyUsername').value = tunnel.username || '';
  $('proxyCredential').value = ['vless', 'tuic'].includes(tunnel.type) ? (tunnel.uuid || '') : (tunnel.password || '');
  $('proxySecondaryCredential').value = tunnel.type === 'tuic' ? (tunnel.password || '') : '';
  $('proxyMethod').value = tunnel.method || 'chacha20-ietf-poly1305';
  $('proxyFlow').value = tunnel.flow || '';
  $('proxyTls').checked = tunnel.tlsEnabled === true;
  $('proxyReality').checked = tunnel.realityEnabled === true;
  $('proxySni').value = tunnel.serverName || '';
  $('proxyFingerprint').value = tunnel.fingerprint || 'chrome';
  $('proxyRealityKey').value = tunnel.realityPublicKey || '';
  $('proxyShortId').value = tunnel.realityShortId || '';
  $('proxyTransport').value = tunnel.transportType || 'none';
  $('proxyPath').value = tunnel.transportPath || '';
  $('proxyHost').value = tunnel.transportHost || '';
  $('proxyInsecure').checked = tunnel.insecure === true;
  $('proxyObfsType').value = tunnel.obfsType || 'none';
  $('proxyObfsPassword').value = tunnel.obfsPassword || '';
  $('proxyUpMbps').value = tunnel.upMbps || 0;
  $('proxyDownMbps').value = tunnel.downMbps || 0;
  $('proxyCongestion').value = tunnel.congestionControl || 'cubic';
  $('proxyUdpRelay').value = tunnel.udpRelayMode || 'native';
  $('proxyZeroRtt').checked = tunnel.zeroRttHandshake === true;
  $('proxyIdleCheck').value = tunnel.idleSessionCheckInterval || '30s';
  $('proxyIdleTimeout').value = tunnel.idleSessionTimeout || '30s';
  $('proxyMinIdle').value = tunnel.minIdleSession || 0;
  $('deleteTunnel').hidden = !id;
  $('tunnelTestResult').hidden = true;
  renderTunnels();
}

function diagnosticsReport() {
  const safeLog = $('log').textContent
    .replace(/(?:vless|trojan|ss|hysteria2|hy2|tuic|anytls|socks5|socks|https?):\/\/\S+/gi, '[ссылка подключения скрыта]')
    .replace(/(private[_ -]?key|password|username|uuid)\s*[:=]\s*\S+/gi, '$1: [скрыто]');
  const tunnel = activeTunnel();
  return [
    'Диагностический отчёт Обхода',
    `Версия: ${$('appVersion').textContent}`,
    `Ядро: ${engineVersion}`,
    `Система: ${navigator.userAgent}`,
    `Внешний IP системы: ${publicIp || 'не определён'}`,
    `Сервис: ${running ? 'работает' : 'выключен'}`,
    `Режим: ${config.routing.trafficMode}`,
    `Подключение: ${tunnel ? `${tunnel.name} (${protocolTitle(tunnel.type)})` : 'не выбрано'}`,
    `Пресеты: ${config.routing.presetIds.length}`,
    `Списки: ${config.routing.localLists.length + config.routing.remoteLists.length}`,
    `Приложения: ${(config.routing.applicationRules || []).filter((item) => item.enabled).map((item) => item.path.split(/[\\/]/).pop()).join(', ') || 'нет'}`,
    `Подготовлено записей: ${ruleStatus?.knownEntries ?? 'сервис не запускался'}`,
    `Предупреждения списков: ${ruleStatus?.warnings?.join(' | ') || 'нет'}`,
    '', 'Журнал:', safeLog
  ].join('\n');
}

function clearTunnelFieldErrors() {
  document.querySelectorAll('#tunnelEditor .field-error').forEach((label) => {
    label.classList.remove('field-error');
    label.removeAttribute('data-error');
  });
}

function markTunnelFieldError(id, message = 'Обязательное поле') {
  const label = $(id)?.closest('label');
  if (!label) return;
  label.classList.add('field-error');
  label.dataset.error = message;
}

function validateTunnelRequiredFields(tunnel) {
  const missing = [];
  const requireField = (valid, id, title) => {
    if (valid) return;
    markTunnelFieldError(id);
    missing.push({ id, title });
  };
  const wireguard = ['wireguard', 'awg'].includes(tunnel.type);
  requireField(Boolean(tunnel.name.trim()), 'tunnelName', 'название');
  if (wireguard) {
    requireField(tunnel.addresses.length > 0, 'tunnelAddresses', 'адрес интерфейса');
    requireField(Boolean(tunnel.privateKey), 'tunnelPrivateKey', 'приватный ключ');
    requireField(Boolean(tunnel.peerPublicKey), 'peerPublicKey', 'публичный ключ сервера');
    requireField(Boolean(tunnel.endpointHost), 'endpointHost', 'Endpoint');
  } else {
    requireField(Boolean(tunnel.server), 'proxyServer', 'сервер');
    if (['vless', 'tuic'].includes(tunnel.type)) requireField(Boolean(tunnel.uuid), 'proxyCredential', 'UUID');
    if (['trojan', 'shadowsocks', 'hysteria2', 'tuic', 'anytls'].includes(tunnel.type)) {
      requireField(Boolean(tunnel.password), tunnel.type === 'tuic' ? 'proxySecondaryCredential' : 'proxyCredential', 'пароль');
    }
    if (tunnel.type === 'hysteria2' && tunnel.obfsType !== 'none') {
      requireField(Boolean(tunnel.obfsPassword), 'proxyObfsPassword', 'пароль обфускации');
    }
    if (tunnel.realityEnabled) requireField(Boolean(tunnel.realityPublicKey), 'proxyRealityKey', 'ключ Reality');
  }
  if (!missing.length) return tunnel;
  $(missing[0].id)?.focus();
  throw new Error(`Заполните обязательные поля: ${missing.map((item) => item.title).join(', ')}.`);
}

function showTunnelFieldError(message) {
  message = cleanErrorMessage(message);
  const type = $('tunnelType').value;
  const wireguard = ['wireguard', 'awg'].includes(type);
  const mappings = [
    [/назван/i, 'tunnelName'], [/адрес сервера|IP-адрес сервера/i, wireguard ? 'endpointHost' : 'proxyServer'],
    [/порт/i, wireguard ? 'endpointPort' : 'proxyPort'], [/UUID/i, 'proxyCredential'],
    [/имя пользов|логин/i, 'proxyUsername'], [/парол/i, type === 'tuic' ? 'proxySecondaryCredential' : 'proxyCredential'], [/публичн.*ключ|Reality/i, $('proxyReality').checked ? 'proxyRealityKey' : 'peerPublicKey'],
    [/приватн.*ключ/i, 'tunnelPrivateKey'], [/адрес интерфейса|IPv4-адрес/i, 'tunnelAddresses'], [/Allowed IP/i, 'allowedIps']
  ];
  const match = mappings.find(([pattern]) => pattern.test(message));
  if (!match) return;
  const input = $(match[1]);
  const label = input?.closest('label');
  if (!label) return;
  label.classList.add('field-error');
  label.dataset.error = message;
  input.focus();
}

function tunnelFromEditor() {
  const type = $('tunnelType').value;
  return {
    id: editingTunnelId || crypto.randomUUID(), type, name: $('tunnelName').value,
    addresses: splitValues($('tunnelAddresses').value), privateKey: $('tunnelPrivateKey').value,
    dns: splitValues($('tunnelDns').value), mtu: Number($('tunnelMtu').value),
    peerPublicKey: $('peerPublicKey').value, preSharedKey: $('preSharedKey').value,
    endpointHost: $('endpointHost').value, endpointPort: Number($('endpointPort').value),
    allowedIps: splitValues($('allowedIps').value), keepalive: Number($('keepalive').value),
    networkFamily: $('networkFamily').value,
    ...Object.fromEntries(['jc', 'jmin', 'jmax', 's1', 's2', 's3', 's4'].map((field) =>
      [field, Number($(`awg${field[0].toUpperCase()}${field.slice(1)}`).value)])),
    ...Object.fromEntries(['h1', 'h2', 'h3', 'h4', 'i1', 'i2', 'i3', 'i4', 'i5'].map((field) =>
      [field, $(`awg${field[0].toUpperCase()}${field.slice(1)}`).value])),
    server: $('proxyServer').value, serverPort: Number($('proxyPort').value), username: $('proxyUsername').value,
    uuid: ['vless', 'tuic'].includes(type) ? $('proxyCredential').value : '',
    password: type === 'tuic' ? $('proxySecondaryCredential').value : (type === 'vless' ? '' : $('proxyCredential').value),
    method: $('proxyMethod').value, flow: $('proxyFlow').value,
    tlsEnabled: $('proxyTls').checked || $('proxyReality').checked, realityEnabled: $('proxyReality').checked,
    serverName: $('proxySni').value, fingerprint: $('proxyFingerprint').value,
    realityPublicKey: $('proxyRealityKey').value, realityShortId: $('proxyShortId').value,
    transportType: $('proxyTransport').value, transportPath: $('proxyPath').value,
    transportHost: $('proxyHost').value, insecure: $('proxyInsecure').checked,
    obfsType: $('proxyObfsType').value, obfsPassword: $('proxyObfsPassword').value,
    upMbps: Number($('proxyUpMbps').value), downMbps: Number($('proxyDownMbps').value),
    congestionControl: $('proxyCongestion').value, udpRelayMode: $('proxyUdpRelay').value,
    zeroRttHandshake: $('proxyZeroRtt').checked, idleSessionCheckInterval: $('proxyIdleCheck').value,
    idleSessionTimeout: $('proxyIdleTimeout').value, minIdleSession: Number($('proxyMinIdle').value)
  };
}

function makePreset(id, title) {
  const russiaInside = config.routing.presetIds.includes('russia_inside');
  const incompatible = russiaInside && id !== 'russia_inside' && !ALLOWED_WITH_RUSSIA_INSIDE.has(id);
  const label = document.createElement('label');
  label.className = `preset${config.routing.presetIds.includes(id) ? ' selected' : ''}${incompatible ? ' disabled' : ''}`;
  const input = document.createElement('input'); input.type = 'checkbox'; input.checked = config.routing.presetIds.includes(id); input.disabled = incompatible;
  const name = document.createElement('b'); name.textContent = title;
  const file = document.createElement('small');
  file.textContent = incompatible
    ? (INCLUDED_IN_RUSSIA_INSIDE.has(id) ? 'Уже входит в Russia inside' : 'Несовместимо с Russia inside')
    : `${id}.srs`;
  input.addEventListener('change', () => {
    if (input.checked) {
      if (id === 'russia_inside') {
        const removed = config.routing.presetIds.filter((item) => !ALLOWED_WITH_RUSSIA_INSIDE.has(item));
        config.routing.presetIds = config.routing.presetIds.filter((item) => ALLOWED_WITH_RUSSIA_INSIDE.has(item));
        if (removed.length) toast(`Russia inside заменяет: ${removed.map((item) => presetCatalog[item] || item).join(', ')}`);
      } else if (REGIONAL_PRESETS.includes(id)) {
        config.routing.presetIds = config.routing.presetIds.filter((item) => !REGIONAL_PRESETS.includes(item));
      } else if (config.routing.presetIds.includes('russia_inside') && !ALLOWED_WITH_RUSSIA_INSIDE.has(id)) {
        toast('Сначала отключите Russia inside.', true);
        renderPresets();
        return;
      }
      config.routing.presetIds = [...new Set([...config.routing.presetIds, id])];
    }
    else config.routing.presetIds = config.routing.presetIds.filter((item) => item !== id);
    renderPresets(); renderSummary(); setRoutingDirty(true);
  });
  label.append(input, name, file); return label;
}

function renderPresets() {
  $('presetNotice').hidden = !config.routing.presetIds.includes('russia_inside');
  $('presetGrid').replaceChildren(...Object.entries(presetCatalog).map(([id, title]) => makePreset(id, title)));
  $('presetCount').textContent = String(config.routing.presetIds.length);
}

function listCard(list, type) {
  const card = document.createElement('article'); card.className = 'list-card';
  const head = document.createElement('div'); head.className = 'list-card-head';
  const name = document.createElement('b'); name.textContent = list.name;
  const toggle = document.createElement('i'); toggle.className = `switch${list.enabled ? ' on' : ''}`;
  toggle.addEventListener('click', () => { list.enabled = !list.enabled; renderLists(); setRoutingDirty(true); });
  head.append(name, toggle);
  const info = document.createElement('p');
  info.textContent = type === 'local' ? `${list.domains.length} доменов · ${list.cidrs.length} подсетей` : list.url;
  const actions = document.createElement('div'); actions.className = 'list-card-actions';
  const kind = document.createElement('small'); kind.textContent = type === 'local' ? 'Локальное хранение' : (list.kind === 'cidrs' ? 'Подсети' : 'Домены');
  const buttons = document.createElement('span');
  const edit = document.createElement('button'); edit.textContent = 'Изменить';
  const remove = document.createElement('button'); remove.textContent = 'Удалить';
  edit.addEventListener('click', () => type === 'local' ? openLocalDialog(list) : openRemoteDialog(list));
  remove.addEventListener('click', () => {
    const collection = type === 'local' ? config.routing.localLists : config.routing.remoteLists;
    const index = collection.findIndex((item) => item.id === list.id); if (index >= 0) collection.splice(index, 1); renderLists(); renderSummary(); setRoutingDirty(true);
  });
  buttons.append(edit, remove); actions.append(kind, buttons); card.append(head, info, actions); return card;
}

function renderLists() {
  $('localListCards').replaceChildren(...config.routing.localLists.map((list) => listCard(list, 'local')));
  $('remoteListCards').replaceChildren(...config.routing.remoteLists.map((list) => listCard(list, 'remote')));
}

function applicationRuleCard(rule) {
  const card = document.createElement('article');
  card.className = `application-rule-card${rule.enabled ? '' : ' disabled'}`;
  const copy = document.createElement('div'); copy.className = 'application-rule-copy';
  const name = document.createElement('b'); name.textContent = rule.name;
  const applicationPath = document.createElement('small');
  applicationPath.textContent = rule.path; applicationPath.title = rule.path;
  copy.append(name, applicationPath);
  if (rule.needsReview) {
    const notice = document.createElement('span'); notice.className = 'review-required';
    notice.textContent = 'После импорта: проверьте путь к программе перед включением.'; copy.append(notice);
  }

  const controls = document.createElement('div'); controls.className = 'application-rule-controls';
  const action = document.createElement('select'); action.setAttribute('aria-label', `Маршрут для ${rule.name}`);
  action.append(new Option('Через туннель', 'proxy'), new Option('Напрямую', 'direct'));
  action.value = rule.action;
  action.addEventListener('change', () => {
    rule.action = action.value; renderSummary(); setRoutingDirty(true);
  });
  const enabledLabel = document.createElement('label'); enabledLabel.className = 'application-rule-enabled';
  const enabled = document.createElement('input'); enabled.type = 'checkbox'; enabled.checked = rule.enabled;
  const enabledText = document.createElement('span'); enabledText.textContent = 'Включено';
  enabled.addEventListener('change', () => {
    if (enabled.checked) delete rule.needsReview;
    rule.enabled = enabled.checked; card.classList.toggle('disabled', !rule.enabled);
    renderSummary(); setRoutingDirty(true);
  });
  enabledLabel.append(enabled, enabledText);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'ghost'; remove.textContent = 'Удалить';
  remove.addEventListener('click', () => {
    const index = config.routing.applicationRules.findIndex((item) => item.id === rule.id);
    if (index >= 0) config.routing.applicationRules.splice(index, 1);
    renderApplicationRules(); renderSummary(); setRoutingDirty(true);
  });
  controls.append(action, enabledLabel, remove);
  card.append(copy, controls);
  return card;
}

function renderApplicationRules() {
  const rules = config.routing.applicationRules || [];
  $('applicationRuleCards').replaceChildren(...rules.map(applicationRuleCard));
  $('applicationRuleEmpty').hidden = rules.length > 0;
  $('applicationRuleCount').textContent = String(rules.length);
  const tunEnabled = $('trafficMode').value === 'tun';
  $('applicationModeNotice').hidden = tunEnabled;
  $('applicationRuleCards').classList.toggle('inactive', !tunEnabled);
}

function applicationPathKey(value) { return String(value || '').toLowerCase(); }

function displayApplicationPath(value) {
  return String(value || '').replace(/^([a-z]:\\Users\\)[^\\]+\\/i, '$1…\\');
}

function renderApplicationPickerList(container, applications, query = '') {
  const existing = new Set((config.routing.applicationRules || []).map((item) => applicationPathKey(item.path)));
  const normalizedQuery = String(query).trim().toLowerCase();
  const filtered = applications.filter((application) => !normalizedQuery
    || `${application.name} ${application.path}`.toLowerCase().includes(normalizedQuery));
  const rows = filtered.map((application) => {
    const key = applicationPathKey(application.path);
    const alreadyAdded = existing.has(key);
    const row = document.createElement('label'); row.className = `application-picker-item${alreadyAdded ? ' added' : ''}`;
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
    checkbox.checked = selectedApplicationPaths.has(key); checkbox.disabled = alreadyAdded;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedApplicationPaths.add(key); else selectedApplicationPaths.delete(key);
      updateApplicationPickerSelection();
    });
    const copy = document.createElement('span');
    const name = document.createElement('b'); name.textContent = application.name;
    const details = document.createElement('small'); details.textContent = displayApplicationPath(application.path);
    details.title = displayApplicationPath(application.path);
    copy.append(name, details);
    const state = document.createElement('em');
    state.textContent = alreadyAdded ? 'Уже добавлено'
      : (application.source === 'file' ? 'Выбран файл'
        : (application.source === 'installed' ? 'Установлено'
          : (application.processCount > 1 ? `${application.processCount} процессов` : 'Запущено')));
    row.append(checkbox, copy, state);
    return row;
  });
  container.replaceChildren(...rows);
  if (!rows.length) {
    const empty = document.createElement('p'); empty.className = 'application-picker-empty';
    empty.textContent = normalizedQuery ? 'Ничего не найдено.' : 'Подходящие приложения не найдены.';
    container.append(empty);
  }
}

function updateApplicationPickerSelection() {
  const count = selectedApplicationPaths.size;
  $('addSelectedApplications').disabled = count === 0;
  $('addSelectedApplications').textContent = count ? `Добавить выбранные · ${count}` : 'Добавить выбранные';
}

function renderApplicationPicker() {
  renderApplicationPickerList($('installedApplicationList'), installedApplicationCandidates, $('installedApplicationSearch').value);
  renderApplicationPickerList($('runningApplicationList'), runningApplicationCandidates, $('runningApplicationSearch').value);
  renderApplicationPickerList($('fileApplicationList'), fileApplicationCandidates);
  updateApplicationPickerSelection();
}

async function refreshInstalledApplicationPicker() {
  $('refreshInstalledApplications').disabled = true;
  $('installedApplicationStatus').textContent = 'Собираем установленные приложения…';
  try {
    installedApplicationCandidates = await window.obhod.installedApplications();
    installedApplicationsLoaded = true;
    $('installedApplicationStatus').textContent = installedApplicationCandidates.length
      ? `Найдено приложений: ${installedApplicationCandidates.length}`
      : 'Установленные приложения с доступным исполняемым файлом не найдены.';
    renderApplicationPicker();
  } catch (error) {
    $('installedApplicationStatus').textContent = `Не удалось получить список: ${error.message}`;
    toast(error.message, true);
  } finally {
    $('refreshInstalledApplications').disabled = false;
  }
}

async function refreshRunningApplicationPicker() {
  $('refreshRunningApplications').disabled = true;
  $('runningApplicationStatus').textContent = 'Ищем запущенные приложения…';
  try {
    runningApplicationCandidates = await window.obhod.runningApplications();
    runningApplicationsLoaded = true;
    $('runningApplicationStatus').textContent = runningApplicationCandidates.length
      ? `Найдено приложений: ${runningApplicationCandidates.length}`
      : 'Запущенные пользовательские приложения не найдены.';
    renderApplicationPicker();
  } catch (error) {
    $('runningApplicationStatus').textContent = `Не удалось получить список: ${error.message}`;
    toast(error.message, true);
  } finally {
    $('refreshRunningApplications').disabled = false;
  }
}

function showApplicationPickerPane(name) {
  document.querySelectorAll('.application-picker-tab').forEach((button) => button.classList.toggle('active', button.dataset.applicationPickerPane === name));
  document.querySelectorAll('.application-picker-pane').forEach((pane) => pane.classList.toggle('active', pane.id === `application-picker-${name}`));
  if (name === 'installed' && !installedApplicationsLoaded) refreshInstalledApplicationPicker();
  if (name === 'running' && !runningApplicationsLoaded) refreshRunningApplicationPicker();
}

function openApplicationPicker() {
  installedApplicationCandidates = [];
  runningApplicationCandidates = [];
  fileApplicationCandidates = [];
  selectedApplicationPaths = new Set();
  installedApplicationsLoaded = false;
  runningApplicationsLoaded = false;
  $('installedApplicationSearch').value = '';
  $('runningApplicationSearch').value = '';
  $('installedApplicationStatus').textContent = 'Загрузка списка…';
  $('runningApplicationStatus').textContent = 'Список ещё не загружен.';
  showApplicationPickerPane('installed');
  renderApplicationPicker();
  $('applicationPickerDialog').showModal();
}

function renderRoutingSettings() {
  $('updateInterval').value = config.routing.updateInterval;
  $('listenPort').value = config.routing.listenPort;
  $('trafficMode').value = config.routing.trafficMode;
  $('strictRoute').checked = config.routing.strictRoute;
  renderTrafficMode();
  renderApplicationRules();
  $('enableDiagnostics').checked = config.routing.enableDiagnostics === true;
  $('launchAtLogin').checked = config.routing.launchAtLogin === true;
  $('startOnLaunch').checked = config.routing.startOnLaunch === true;
  $('failoverEnabled').checked = config.routing.failoverEnabled === true;
  const failoverNames = config.routing.failoverTunnelIds
    .map((id) => config.tunnels.find((item) => item.id === id)?.name)
    .filter(Boolean);
  activeTunnelCaption.textContent = config.routing.failoverEnabled ? 'Маршрут трафика' : 'Основное подключение';
  $('activeTunnel').hidden = config.routing.failoverEnabled;
  activeFailoverSummary.hidden = !config.routing.failoverEnabled;
  activeFailoverTitle.textContent = `Автоматический выбор · ${failoverNames.length}`;
  activeFailoverDetail.textContent = failoverNames.join(' · ') || 'Серверы группы не выбраны';
  activeFailoverDetail.title = activeFailoverDetail.textContent;
  $('failoverInterval').value = config.routing.failoverInterval || '15s';
  $('failoverTolerance').value = String(config.routing.failoverTolerance || 80);
  $('testUrl').value = config.routing.testUrl || 'https://www.gstatic.com/generate_204';
  $('dnsResolverEnabled').checked = config.routing.dnsResolverEnabled === true;
  $('dnsProtocol').value = config.routing.dnsProtocol || 'tls';
  $('dnsServer').value = config.routing.dnsServer || 'one.one.one.one';
  $('dnsBootstrap').value = config.routing.dnsBootstrap || '1.1.1.1';
  $('dnsPath').value = config.routing.dnsPath || '/dns-query';
  $('dnsTtl').value = config.routing.dnsTtl || 60;
  $('dnsPreset').value = detectDnsPreset();
  renderDnsResolverState();
  $('diagnosticsNotice').textContent = config.routing.enableDiagnostics
    ? 'Подробная запись включена: журнал содержит события подключений и работы правил.'
    : 'Подробная запись выключена — отображаются только основные события и ошибки.';
  $('diagnosticsNotice').classList.toggle('enabled', config.routing.enableDiagnostics === true);
}

function renderTrafficMode() {
  const mode = $('trafficMode').value;
  $('strictRouteLabel').hidden = mode !== 'tun';
  $('listenPortLabel').hidden = mode === 'tun';
  $('listenPortTitle').textContent = mode === 'system-proxy' ? 'Порт системного прокси Windows' : 'Порт локального прокси';
  $('listenPortHelp').textContent = mode === 'system-proxy'
    ? 'Используется приложениями, которые читают системные настройки Windows.'
    : 'Укажите этот порт в программе, которая должна подключаться к прокси вручную.';
  $('trafficModeHelp').textContent = {
    tun: 'Перехватывает TCP, UDP и DNS. Требуются права администратора.',
    'system-proxy': 'Для браузеров и программ, использующих настройки прокси Windows.',
    'local-proxy': `Ручное подключение программ к 127.0.0.1:${$('listenPort').value || 2080}.`
  }[mode];
  if (config) {
    $('applicationModeNotice').hidden = mode === 'tun';
    $('applicationRuleCards').classList.toggle('inactive', mode !== 'tun');
  }
}

function showRoutingSection(name, scroll = false) {
  showView('settings');
  showSettingsPane({ service: 'general', lists: 'routing' }[name] || name);
  if (name === 'lists' && scroll) document.querySelector('.site-lists').scrollIntoView();
}

function renderDnsResolverState() {
  const enabled = $('dnsResolverEnabled').checked;
  const isHttps = $('dnsProtocol').value === 'https';
  $('dnsResolverStatus').textContent = enabled ? 'Включён' : 'Выключен';
  $('dnsResolverStatus').classList.toggle('online', enabled);
  document.querySelector('.dns-resolver-panel').classList.toggle('enabled', enabled);
  $('dnsPathLabel').hidden = !isHttps;
  for (const id of ['dnsPreset', 'dnsProtocol', 'dnsServer', 'dnsBootstrap', 'dnsPath', 'dnsTtl', 'testDns']) $(id).disabled = !enabled;
}

function dnsPresetValues(name, protocol = $('dnsProtocol').value) {
  const preset = DNS_PRESETS[name];
  if (!preset) return null;
  if (protocol === 'https') return { server: preset.https[0], path: preset.https[1], bootstrap: preset.bootstrap };
  return { server: protocol === 'tls' ? preset.tls : preset.plain, path: '/dns-query', bootstrap: preset.bootstrap };
}

function applyDnsPreset() {
  const values = dnsPresetValues($('dnsPreset').value);
  if (!values) return;
  $('dnsServer').value = values.server;
  $('dnsBootstrap').value = values.bootstrap;
  $('dnsPath').value = values.path;
  $('dnsTestResult').textContent = 'Настройки изменены — можно проверить задержку';
  $('dnsTestResult').className = 'dns-test-result';
  renderDnsResolverState();
}

function detectDnsPreset() {
  const protocol = $('dnsProtocol').value;
  for (const name of Object.keys(DNS_PRESETS)) {
    const values = dnsPresetValues(name, protocol);
    if (values.server === $('dnsServer').value && values.bootstrap === $('dnsBootstrap').value
      && (protocol !== 'https' || values.path === $('dnsPath').value)) return name;
  }
  return 'custom';
}

function openLocalDialog(list = null) {
  $('localDialogTitle').textContent = list ? list.name : 'Новый список';
  $('localListId').value = list?.id || '';
  $('localListName').value = list?.name || '';
  $('localDomains').value = (list?.domains || []).join('\n');
  $('localCidrs').value = (list?.cidrs || []).join('\n');
  updateDomainPreview();
  $('localDialog').showModal();
}

function openRemoteDialog(list = null) {
  $('remoteDialogTitle').textContent = list ? list.name : 'Новый URL';
  $('remoteListId').value = list?.id || '';
  $('remoteListName').value = list?.name || '';
  $('remoteListUrl').value = list?.url || '';
  $('remoteListKind').value = list?.kind || 'domains';
  $('remoteDialog').showModal();
}

async function persist(message = 'Изменения сохранены') {
  const saved = await window.obhod.saveProfile(config);
  if (!saved) return;
  config = saved; renderAll(); toast(message);
}

function renderAll() {
  renderTunnels(); renderPresets(); renderLists(); renderRoutingSettings(); renderSummary(); setRunning(running);
}

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => {
  showView(button.dataset.view);
  if (button.dataset.pane) showSettingsPane(button.dataset.pane);
}));
document.querySelectorAll('.settings-tab').forEach((button) => button.addEventListener('click', () => showSettingsPane(button.dataset.settingsPane)));
document.querySelectorAll('.routing-section-tab').forEach((button) => {
  button.addEventListener('click', () => showRoutingSection(button.dataset.routingSectionTarget));
});
openFailoverSettings.addEventListener('click', () => {
  showRoutingSection('failover', true);
});
$('failoverSelectAll').addEventListener('change', () => {
  for (const input of document.querySelectorAll('#failoverTunnels input')) input.checked = $('failoverSelectAll').checked;
  updateFailoverSelectionCount();
});
document.querySelectorAll('dialog .close[value="cancel"], dialog .dialog-actions button[value="cancel"]').forEach((button) => {
  button.addEventListener('click', (event) => {
    event.preventDefault();
    button.closest('dialog').close('cancel');
  });
});
$('runDiagnostics').addEventListener('click', () => guarded(async () => {
  const button = $('runDiagnostics');
  button.disabled = true; button.textContent = 'Проверяем…';
  try {
    const version = await window.obhod.engineVersion();
    engineVersion = version;
    log(`Ядро: ${version}`, 'status');
    const dnsResult = await window.obhod.testDns({
      protocol: config.routing.dnsProtocol, server: config.routing.dnsServer,
      bootstrap: config.routing.dnsBootstrap, path: config.routing.dnsPath
    });
    log(`DNS: ${dnsResult.latency} мс, ответ от ${dnsResult.address}`, 'status');
    if (running) {
      const route = await window.obhod.connectionInfo(config);
      log(`Маршрут: ${route.name} (${protocolTitle(route.type)}), сервер ${route.host}, задержка ${route.latency ?? 'нет ICMP'} мс`, 'status');
      await updatePublicIp();
      log(`Внешний IP системы: ${publicIp || 'не определён'}`, 'status');
    } else {
      log('Маршрут: сервис выключен, проверка активного туннеля пропущена.', 'status');
    }
  } finally {
    button.disabled = false; button.textContent = 'Проверить DNS/маршрут';
  }
}));
$('clearLog').addEventListener('click', () => { $('log').textContent = ''; });
$('copyLog').addEventListener('click', () => guarded(async () => {
  await window.obhod.copyDiagnostics(diagnosticsReport()); toast('Диагностический отчёт скопирован');
}));
$('exportLog').addEventListener('click', () => guarded(async () => {
  const result = await window.obhod.exportDiagnostics(diagnosticsReport());
  if (result?.exported) toast('Диагностический отчёт сохранён');
}));
$('newTunnel').addEventListener('click', () => openTunnelEditor());
$('tunnelEditor').addEventListener('input', (event) => {
  const label = event.target.closest('label.field-error');
  if (!label) return;
  label.classList.remove('field-error');
  label.removeAttribute('data-error');
});
$('tunnelType').addEventListener('change', () => {
  const type = $('tunnelType').value;
  if (['vless', 'trojan', 'hysteria2', 'tuic', 'anytls'].includes(type)) $('proxyTls').checked = true;
  else if (type === 'socks5') {
    $('proxyTls').checked = false;
    $('proxyPort').value = 1080;
  } else if (type === 'http') {
    $('proxyTls').checked = false;
    $('proxyPort').value = 8080;
  }
  renderProtocolFields(type);
});
$('cancelTunnel').addEventListener('click', () => {
  editingTunnelId = null; openTunnelEditor(config.tunnels[0]?.id || null);
  if (onboardingActive && onboardingStep === 1 && !config.tunnels.length) showOnboardingStep(1);
});
$('proxyDialog').addEventListener('close', () => {
  if (onboardingActive && onboardingStep === 1 && !config.tunnels.length) showOnboardingStep(1);
});
$('testTunnel').addEventListener('click', () => guarded(async () => {
  const button = $('testTunnel');
  const resultBox = $('tunnelTestResult');
  clearTunnelFieldErrors();
  button.disabled = true; button.textContent = 'Проверяем…';
  resultBox.hidden = false; resultBox.className = 'test-result pending'; resultBox.textContent = 'Проверяем конфигурацию и адрес сервера…';
  try {
    const result = await window.obhod.testTunnel(validateTunnelRequiredFields(tunnelFromEditor()));
    resultBox.className = 'test-result success';
    resultBox.textContent = `${result.message} ${result.latency} мс`;
  } catch (error) {
    const message = cleanErrorMessage(error);
    if (!document.querySelector('#tunnelEditor .field-error')) showTunnelFieldError(message);
    resultBox.className = 'test-result error'; resultBox.textContent = message; throw error;
  } finally {
    button.disabled = false; button.textContent = 'Проверить';
  }
}));
$('saveTunnel').addEventListener('click', () => guarded(async () => {
  clearTunnelFieldErrors();
  try {
    const tunnel = validateTunnelRequiredFields(tunnelFromEditor());
    const index = config.tunnels.findIndex((item) => item.id === editingTunnelId);
    if (index >= 0) config.tunnels[index] = tunnel; else config.tunnels.push(tunnel);
    if (!config.routing.activeTunnelId) config.routing.activeTunnelId = tunnel.id;
    editingTunnelId = tunnel.id;
    creatingTunnel = false;
    await persist('Туннель сохранён');
    if (onboardingActive) showOnboardingStep(2);
  } catch (error) {
    if (!document.querySelector('#tunnelEditor .field-error')) showTunnelFieldError(cleanErrorMessage(error));
    throw error;
  }
}));
$('deleteTunnel').addEventListener('click', () => guarded(async () => {
  config.tunnels = config.tunnels.filter((item) => item.id !== editingTunnelId);
  if (config.routing.activeTunnelId === editingTunnelId) config.routing.activeTunnelId = config.tunnels[0]?.id || null;
  editingTunnelId = null; await persist('Туннель удалён'); openTunnelEditor(config.tunnels[0]?.id || null);
}));
$('importTunnel').addEventListener('click', () => $('tunnelFile').click());
function renderProxyImportType() {
  const subscription = $('proxyImportType').value === 'subscription';
  $('proxyUriLabel').textContent = subscription ? 'URL подписки или список подключений' : 'Ссылка подключения';
  $('proxyUri').placeholder = subscription ? 'https://provider.example/subscription/…' : 'vless://…';
  $('proxyImportHint').textContent = subscription
    ? 'Вставьте URL V2Ray-подписки, список ссылок или Base64. Серверы будут добавлены отдельными подключениями; дубликаты будут пропущены. Для обновления списка повторите импорт.'
    : 'SOCKS5, HTTP(S), VLESS, Shadowsocks, Trojan, Hysteria2, TUIC или AnyTLS.';
  $('proxyImportError').hidden = true;
}
$('proxyImportType').addEventListener('change', renderProxyImportType);
$('importProxy').addEventListener('click', () => {
  proxyImportVersion += 1;
  $('proxyUri').value = '';
  $('proxyImportType').value = 'connection';
  $('proxyImportType').disabled = false;
  $('proxyUri').disabled = false;
  $('saveProxyUri').disabled = false;
  $('saveProxyUri').textContent = 'Импортировать';
  renderProxyImportType();
  $('proxyDialog').showModal();
});
$('proxyDialog').addEventListener('close', () => { proxyImportVersion += 1; });
$('saveProxyUri').addEventListener('click', (event) => guarded(async () => {
  event.preventDefault();
  const version = proxyImportVersion;
  const button = $('saveProxyUri');
  if (button.disabled) return;
  button.disabled = true; button.textContent = 'Загрузка…';
  $('proxyImportType').disabled = true; $('proxyUri').disabled = true;
  $('proxyImportError').hidden = true;
  try {
    const subscription = $('proxyImportType').value === 'subscription';
    const result = subscription
      ? await window.obhod.importSubscription($('proxyUri').value, config.tunnels)
      : { tunnels: [await window.obhod.parseProxy($('proxyUri').value, 'Импортированное подключение')], duplicates: 0 };
    if (version !== proxyImportVersion || !$('proxyDialog').open) return;
    if (!result.tunnels.length) {
      $('proxyImportError').textContent = 'Все подключения из подписки уже добавлены.';
      $('proxyImportError').hidden = false;
      return;
    }
    const candidate = structuredClone(config);
    candidate.tunnels.push(...result.tunnels);
    if (!candidate.routing.activeTunnelId) candidate.routing.activeTunnelId = result.tunnels[0].id;
    const saved = await window.obhod.saveProfile(candidate);
    if (!saved) return;
    config = saved;
    editingTunnelId = result.tunnels[0].id;
    renderAll(); openTunnelEditor(editingTunnelId);
    $('proxyDialog').close();
    toast(subscription ? `Добавлено подключений: ${result.tunnels.length}. Пропущено дубликатов: ${result.duplicates}.`
      : `${protocolTitle(result.tunnels[0].type)} импортирован`);
    if (onboardingActive) showOnboardingStep(2);
  } catch (error) {
    if (version === proxyImportVersion && $('proxyDialog').open) {
      $('proxyImportError').textContent = cleanErrorMessage(error);
      $('proxyImportError').hidden = false;
    }
    throw error;
  } finally {
    if (version === proxyImportVersion) {
      button.disabled = false; button.textContent = 'Импортировать';
      $('proxyImportType').disabled = false; $('proxyUri').disabled = false;
    }
  }
}));
$('tunnelFile').addEventListener('change', (event) => guarded(async () => {
  const file = event.target.files?.[0]; if (!file) return;
  if (file.size > 131072) throw new Error('Конфигурация больше 128 КБ.');
  const tunnel = await window.obhod.parseTunnel(await file.text(), file.name);
  config.tunnels.push(tunnel); if (!config.routing.activeTunnelId) config.routing.activeTunnelId = tunnel.id;
  editingTunnelId = tunnel.id; await persist(`${protocolTitle(tunnel.type)}-конфигурация импортирована`); openTunnelEditor(tunnel.id);
  if (onboardingActive) showOnboardingStep(2);
  event.target.value = '';
}));
$('addApplicationRule').addEventListener('click', openApplicationPicker);
document.querySelectorAll('.application-picker-tab').forEach((button) => {
  button.addEventListener('click', () => showApplicationPickerPane(button.dataset.applicationPickerPane));
});
$('installedApplicationSearch').addEventListener('input', renderApplicationPicker);
$('runningApplicationSearch').addEventListener('input', renderApplicationPicker);
$('refreshInstalledApplications').addEventListener('click', () => refreshInstalledApplicationPicker());
$('refreshRunningApplications').addEventListener('click', () => refreshRunningApplicationPicker());
$('browseApplicationFiles').addEventListener('click', () => guarded(async () => {
  const selected = await window.obhod.selectApplications();
  if (!selected?.length) return;
  const existing = new Set((config.routing.applicationRules || []).map((item) => applicationPathKey(item.path)));
  const files = new Map(fileApplicationCandidates.map((item) => [applicationPathKey(item.path), item]));
  for (const application of selected) {
    const key = applicationPathKey(application.path);
    files.set(key, { ...application, source: 'file' });
    if (!existing.has(key)) selectedApplicationPaths.add(key);
  }
  fileApplicationCandidates = [...files.values()];
  renderApplicationPicker();
}));
$('addSelectedApplications').addEventListener('click', (event) => {
  event.preventDefault();
  const candidates = new Map([...fileApplicationCandidates, ...runningApplicationCandidates, ...installedApplicationCandidates]
    .map((item) => [applicationPathKey(item.path), item]));
  const existing = new Set((config.routing.applicationRules || []).map((item) => applicationPathKey(item.path)));
  let added = 0;
  for (const key of selectedApplicationPaths) {
    const application = candidates.get(key);
    if (!application || existing.has(key)) continue;
    config.routing.applicationRules.push({
      id: crypto.randomUUID(), name: application.name, path: application.path,
      action: 'proxy', enabled: true
    });
    existing.add(key); added += 1;
  }
  if (!added) return;
  $('applicationPickerDialog').close();
  renderApplicationRules(); renderSummary(); setRoutingDirty(true);
  toast(added === 1 ? 'Приложение добавлено' : `Добавлено приложений: ${added}`);
});
$('saveRouting').addEventListener('click', () => guarded(async () => {
  const button = $('saveRouting');
  config.routing.activeTunnelId = $('activeTunnel').value || null;
  config.routing.updateInterval = $('updateInterval').value;
  config.routing.listenPort = Number($('listenPort').value);
  config.routing.trafficMode = $('trafficMode').value;
  config.routing.enableSystemProxy = config.routing.trafficMode === 'system-proxy';
  config.routing.strictRoute = $('strictRoute').checked;
  config.routing.enableDiagnostics = $('enableDiagnostics').checked;
  config.routing.launchAtLogin = $('launchAtLogin').checked;
  config.routing.startOnLaunch = $('startOnLaunch').checked;
  config.routing.failoverEnabled = $('failoverEnabled').checked;
  config.routing.failoverInterval = $('failoverInterval').value;
  config.routing.failoverTolerance = Number($('failoverTolerance').value);
  config.routing.failoverTunnelIds = [...document.querySelectorAll('#failoverTunnels input:checked')].map((input) => input.value);
  if (config.routing.failoverEnabled && config.routing.failoverTunnelIds.length < 2) {
    throw new Error('Для автоматического переключения выберите минимум два подключения.');
  }
  config.routing.testUrl = $('testUrl').value;
  config.routing.dnsResolverEnabled = $('dnsResolverEnabled').checked;
  config.routing.dnsProtocol = $('dnsProtocol').value;
  config.routing.dnsServer = $('dnsServer').value.trim();
  config.routing.dnsBootstrap = $('dnsBootstrap').value.trim();
  config.routing.dnsPath = $('dnsPath').value.trim();
  config.routing.dnsTtl = Number($('dnsTtl').value);
  applyingRules = running;
  button.disabled = true;
  button.textContent = applyingRules ? 'Применяем правила…' : 'Сохраняем…';
  if (applyingRules) setConnecting(true);
  try {
    const result = await window.obhod.applyProfile(config);
    config = result.profile;
    running = result.status.running;
    serviceStartedAt = result.status.startedAt || null;
    ruleStatus = result.status.ruleStatus || null;
    renderAll();
    setRoutingDirty(false);
    toast(result.restarted ? 'Новые правила применены' : 'Маршрутизация сохранена');
    if (onboardingWaitingForRules) {
      onboardingWaitingForRules = false;
      showOnboardingStep(3);
    }
  } catch (error) {
    running = false;
    setRunning(false);
    throw error;
  } finally {
    applyingRules = false;
    setConnecting(false);
    button.disabled = !routingSaveDirty;
    button.textContent = 'Сохранить';
  }
}));
$('cancelRouting').addEventListener('click', () => guarded(async () => {
  config = await window.obhod.loadProfile();
  renderAll();
  setRoutingDirty(false);
  toast('Несохранённые изменения отменены');
}));
$('view-settings').addEventListener('input', (event) => {
  if (!event.target.closest('#settings-tunnels, #settings-backup, #settings-app')) setRoutingDirty(true);
});
$('view-settings').addEventListener('change', (event) => {
  if (!event.target.closest('#settings-tunnels, #settings-backup, #settings-app')) setRoutingDirty(true);
});
$('enableDiagnostics').addEventListener('change', () => guarded(async () => {
  const profile = await window.obhod.loadProfile();
  profile.routing.enableDiagnostics = $('enableDiagnostics').checked;
  const saved = await window.obhod.saveProfile(profile);
  config.routing.enableDiagnostics = saved.routing.enableDiagnostics;
  $('diagnosticsNotice').textContent = saved.routing.enableDiagnostics
    ? 'Подробная запись включена: журнал содержит события подключений и работы правил.'
    : 'Подробная запись выключена — отображаются только основные события и ошибки.';
  toast('Настройка журнала сохранена');
}));
$('trafficMode').addEventListener('change', renderTrafficMode);
$('dnsResolverEnabled').addEventListener('change', renderDnsResolverState);
$('dnsPreset').addEventListener('change', applyDnsPreset);
$('dnsProtocol').addEventListener('change', () => {
  if ($('dnsPreset').value !== 'custom') applyDnsPreset(); else renderDnsResolverState();
});
for (const id of ['dnsServer', 'dnsBootstrap', 'dnsPath']) {
  $(id).addEventListener('input', () => {
    $('dnsPreset').value = 'custom';
    $('dnsTestResult').textContent = 'Настройки изменены — можно проверить задержку';
    $('dnsTestResult').className = 'dns-test-result';
  });
}
$('testDns').addEventListener('click', async () => {
  const button = $('testDns');
  const resultBox = $('dnsTestResult');
  button.disabled = true;
  button.textContent = 'Проверяем…';
  resultBox.className = 'dns-test-result pending';
  resultBox.textContent = 'Отправляем тестовый DNS-запрос…';
  try {
    const result = await window.obhod.testDns({
      protocol: $('dnsProtocol').value,
      server: $('dnsServer').value.trim(),
      bootstrap: $('dnsBootstrap').value.trim(),
      path: $('dnsPath').value.trim()
    });
    resultBox.className = 'dns-test-result success';
    resultBox.textContent = `${result.latency} мс · ответ от ${result.address}`;
  } catch (error) {
    resultBox.className = 'dns-test-result error';
    resultBox.textContent = error.message;
    log(`Проверка DNS: ${error.message}`, 'error');
  } finally {
    button.disabled = !$('dnsResolverEnabled').checked;
    button.textContent = 'Проверить задержку';
  }
});
$('listenPort').addEventListener('input', renderTrafficMode);
$('addLocalList').addEventListener('click', () => openLocalDialog());
$('addRemoteList').addEventListener('click', () => openRemoteDialog());
$('saveLocalList').addEventListener('click', (event) => {
  event.preventDefault();
  if (!$('localListName').reportValidity() || !updateDomainPreview()) return;
  const id = $('localListId').value || crypto.randomUUID();
  const value = { id, name: $('localListName').value, enabled: true, domains: normalizeDomains($('localDomains').value), cidrs: splitValues($('localCidrs').value) };
  const index = config.routing.localLists.findIndex((item) => item.id === id); if (index >= 0) value.enabled = config.routing.localLists[index].enabled;
  if (index >= 0) config.routing.localLists[index] = value; else config.routing.localLists.push(value);
  $('localDialog').close(); renderLists(); renderSummary(); setRoutingDirty(true);
});
$('saveRemoteList').addEventListener('click', (event) => {
  event.preventDefault();
  const id = $('remoteListId').value || crypto.randomUUID();
  const value = { id, name: $('remoteListName').value, enabled: true, url: $('remoteListUrl').value, kind: $('remoteListKind').value };
  const index = config.routing.remoteLists.findIndex((item) => item.id === id); if (index >= 0) value.enabled = config.routing.remoteLists[index].enabled;
  if (index >= 0) config.routing.remoteLists[index] = value; else config.routing.remoteLists.push(value);
  $('remoteDialog').close(); renderLists(); renderSummary(); setRoutingDirty(true);
});
$('powerButton').addEventListener('click', () => guarded(async () => {
  $('powerButton').disabled = true;
  const starting = !running;
  if (starting) setConnecting(true);
  try {
    const status = running ? await window.obhod.stop() : await window.obhod.start(config);
    serviceStartedAt = status.startedAt || null;
    ruleStatus = status.ruleStatus || null;
    setRunning(status.running);
    renderSummary();
  }
  finally { setConnecting(false); $('powerButton').disabled = false; }
}));

window.obhod.onEngineEvent((event) => {
  log(event.message, event.type);
  if (event.type === 'status' && /Прокси запущен|TUN-режим запущен/i.test(event.message)) {
    guarded(async () => {
      const status = await window.obhod.status();
      serviceStartedAt = status.startedAt || null;
      ruleStatus = status.ruleStatus || null;
      setRunning(status.running);
      renderSummary();
    });
  }
  if (event.type === 'status' && /останов|выключен/i.test(event.message) && !applyingRules) setRunning(false);
});

function showOnboardingStep(step) {
  onboardingActive = true;
  onboardingStep = step;
  const titles = { 1: 'Добавьте подключение', 2: 'Выберите правила', 3: 'Проверьте и включите' };
  $('onboardingTitle').textContent = titles[step];
  $('onboardingProgress').textContent = `Шаг ${step} из 3`;
  document.querySelectorAll('[data-onboarding-page]').forEach((page) => { page.hidden = Number(page.dataset.onboardingPage) !== step; });
  document.querySelectorAll('[data-onboarding-marker]').forEach((marker) => {
    const value = Number(marker.dataset.onboardingMarker);
    marker.classList.toggle('active', value === step);
    marker.classList.toggle('complete', value < step);
  });
  if (step === 2) {
    const names = config.routing.presetIds.map((id) => presetCatalog[id]).filter(Boolean);
    $('onboardingPresetSummary').textContent = names.length ? names.join(' · ') : 'Готовые пресеты не выбраны.';
  }
  if (step === 1) {
    const tunnel = activeTunnel() || config.tunnels[0];
    $('onboardingUseExisting').hidden = !tunnel;
    if (tunnel) $('onboardingUseExisting').textContent = `Использовать «${tunnel.name}»`;
  }
  if (!$('onboardingDialog').open) $('onboardingDialog').showModal();
}

function restartOnboarding() {
  $('onboardingStart').disabled = true;
  $('onboardingTestResult').className = 'test-result';
  $('onboardingTestResult').textContent = 'Подключение ещё не проверено.';
  showOnboardingStep(1);
}

async function completeOnboarding() {
  config.routing.onboardingCompleted = true;
  config = await window.obhod.saveProfile(config);
  onboardingActive = false;
  $('onboardingDialog').close();
}

function openOnboardingImport(action) {
  if (action === 'file') $('tunnelFile').click();
  if (action === 'link') { $('onboardingDialog').close(); $('proxyUri').value = ''; $('proxyDialog').showModal(); }
  if (action === 'manual') { $('onboardingDialog').close(); showView('settings'); showSettingsPane('tunnels'); openTunnelEditor(); }
}

$('onboardingImportFile').addEventListener('click', () => openOnboardingImport('file'));
$('onboardingImportLink').addEventListener('click', () => openOnboardingImport('link'));
$('onboardingManual').addEventListener('click', () => openOnboardingImport('manual'));
$('onboardingUseExisting').addEventListener('click', () => showOnboardingStep(2));
$('onboardingUsePresets').addEventListener('click', () => showOnboardingStep(3));
$('onboardingChoosePresets').addEventListener('click', () => {
  onboardingWaitingForRules = true;
  $('onboardingDialog').close();
  showView('settings'); showSettingsPane('routing');
  showSettingsPane('routing');
  document.querySelector('#presetGrid').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('onboardingTest').addEventListener('click', () => guarded(async () => {
  const tunnel = activeTunnel();
  if (!tunnel) throw new Error('Сначала добавьте и выберите подключение.');
  const button = $('onboardingTest');
  button.disabled = true; button.textContent = 'Проверяем…';
  $('onboardingTestResult').className = 'test-result pending';
  $('onboardingTestResult').textContent = 'Проверяем защищённое соединение…';
  try {
    const result = await window.obhod.testTunnel(tunnel);
    $('onboardingTestResult').className = 'test-result success';
    $('onboardingTestResult').textContent = `${result.message} ${result.latency} мс`;
    $('onboardingStart').disabled = false;
    $('onboardingStart').textContent = 'Включить сервис';
  } catch (error) {
    $('onboardingTestResult').className = 'test-result error';
    $('onboardingTestResult').textContent = error.message;
    throw error;
  } finally {
    button.disabled = false; button.textContent = 'Проверить подключение';
  }
}));
$('onboardingStart').addEventListener('click', () => guarded(async () => {
  await completeOnboarding();
  if (!running) $('powerButton').click();
}));
$('onboardingSkip').addEventListener('click', () => guarded(() => completeOnboarding()));
$('openOnboarding').addEventListener('click', restartOnboarding);

window.obhod.onUpdateEvent((event) => {
  renderUpdateState(event);
  if (event.type === 'error') toast(event.message, true);
});

$('openUpdate').addEventListener('click', () => {
  showView('settings');
  showSettingsPane('app');
});

$('dismissUpdate').addEventListener('click', () => guarded(async () => {
  if (!updaterState.version) return;
  config.routing.dismissedUpdateVersion = updaterState.version;
  config = await window.obhod.saveProfile(config);
  renderUpdateState();
}));

$('checkUpdates').addEventListener('click', () => guarded(async () => {
  $('checkUpdates').disabled = true;
  $('updateStatus').textContent = 'Проверяем обновления…';
  const result = await window.obhod.checkForUpdates();
  if (!result?.supported) {
    $('updateStatus').textContent = result?.message || 'Проверка доступна в установленной версии приложения.';
    $('checkUpdates').disabled = false;
  }
}));

$('downloadUpdate').addEventListener('click', () => guarded(async () => {
  $('downloadUpdate').disabled = true;
  $('updateStatus').textContent = 'Начинаем загрузку обновления…';
  await window.obhod.downloadUpdate();
}));

$('installUpdate').addEventListener('click', () => guarded(async () => {
  $('installUpdate').disabled = true;
  $('updateStatus').textContent = 'Останавливаем соединение и устанавливаем обновление…';
  await window.obhod.installUpdate();
}));

$('autoCheckUpdates').addEventListener('change', () => guarded(async () => {
  config.routing.autoCheckUpdates = $('autoCheckUpdates').checked;
  config = await window.obhod.saveProfile(config);
  toast(config.routing.autoCheckUpdates ? 'Автоматическая проверка включена' : 'Автоматическая проверка выключена');
  if (config.routing.autoCheckUpdates) await window.obhod.checkForUpdates();
}));

guarded(async () => {
  const [loadedConfig, loadedCatalog, version, loadedUpdateState] = await Promise.all([
    window.obhod.loadProfile(), window.obhod.presets(), window.obhod.appVersion(), window.obhod.updateStatus()
  ]);
  config = loadedConfig;
  presetCatalog = loadedCatalog;
  $('appVersion').textContent = `v${version}`;
  $('autoCheckUpdates').checked = config.routing.autoCheckUpdates !== false;
  renderUpdateState(loadedUpdateState);
  const status = await window.obhod.status();
  running = status.running;
  serviceStartedAt = status.startedAt || null;
  ruleStatus = status.ruleStatus || null;
  engineVersion = status.engineVersion || await window.obhod.engineVersion().catch(() => engineVersion);
  renderAll(); setRoutingDirty(false); openTunnelEditor(config.tunnels[0]?.id || null);
  if (running) updatePublicIp();
  if (!config.routing.onboardingCompleted) showOnboardingStep(config.tunnels.length ? 2 : 1);
});

setInterval(updateRuntimeStats, 1000);
setInterval(updateLatency, 10000);
setInterval(updatePublicIp, 5 * 60 * 1000);
