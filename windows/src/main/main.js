const { app, BrowserWindow, ipcMain, safeStorage, Tray, Menu, nativeImage, clipboard, dialog, powerMonitor, net } = require('electron');
const fs = require('node:fs');
const { autoUpdater } = require('electron-updater');
const { redactSensitive } = require('./redact');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ProfileStore } = require('./profile-store');
const { SingBoxService } = require('./sing-box-service');
const { RecoveryController } = require('./recovery-controller');
const { MAX_BYTES, encodeBackup, decodeBackup, inspectBackup, prepareImport, importSummary } = require('./backup');
const { applyImport } = require('./import-transaction');
const { testDnsLatency } = require('./dns-latency');
const { parseWireGuardConfig, parseProxyUri, PODKOP_PRESETS } = require('../../../shared/profile');
const { loadSubscription, mergeSubscription } = require('../../../shared/subscription');
const { listInstalledApplications, listRunningApplications } = require('./application-catalog');

let mainWindow;
let store;
let service;
let backupBusy = false;
let pendingBackup = null;
const assertBackupIdle = () => { if (backupBusy) throw new Error('Дождитесь завершения переноса настроек.'); };
let recovery;
let tray;
let isQuitting = false;
let stoppingForQuit = false;
let trayHintShown = false;
let updateReady = false;
let availableUpdateVersion = '';
let updateState = { type: 'idle', message: 'Обновления ещё не проверялись.', version: '', checkedAt: null };
let publicIpCache = { value: '', checkedAt: 0 };

async function getPublicIp() {
  if (publicIpCache.value && Date.now() - publicIpCache.checkedAt < 10 * 60 * 1000) return publicIpCache.value;
  const response = await fetch('https://api.ipify.org?format=json', {
    signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Сервис внешнего IP ответил с кодом ${response.status}.`);
  const value = String((await response.json()).ip || '').trim();
  if (!value) throw new Error('Сервис внешнего IP вернул пустой адрес.');
  publicIpCache = { value, checkedAt: Date.now() };
  return value;
}
const smokeTest = process.argv.includes('--smoke-test');
const uiTest = process.argv.includes('--ui-test');
const startHidden = process.argv.includes('--hidden');
if (smokeTest || uiTest) app.disableHardwareAcceleration();
if (uiTest) app.setPath('userData', path.join(app.getPath('temp'), `obhod-ui-test-${process.pid}`));
const hasSingleInstanceLock = (smokeTest || uiTest) ? true : app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on('second-instance', showWindow);

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  mainWindow.focus();
}

function applyLoginSettings(profile) {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const taskName = 'Obhod Autostart';
  try {
    app.setLoginItemSettings({ name: 'Обход', openAtLogin: false, path: process.execPath, args: ['--hidden'] });
    if (profile.routing.launchAtLogin === true) {
      execFileSync('schtasks.exe', [
        '/Create', '/TN', taskName, '/TR', `"${process.execPath}" --hidden`,
        '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F'
      ], { windowsHide: true, stdio: 'ignore' });
    } else {
      execFileSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], {
        windowsHide: true, stdio: 'ignore'
      });
    }
  } catch (error) {
    if (profile.routing.launchAtLogin === true) {
      tray?.displayBalloon({
        title: 'Обход', content: 'Не удалось настроить автозапуск через Планировщик Windows.', iconType: 'error'
      });
    }
  }
}

async function toggleServiceFromTray() {
  try {
    assertBackupIdle();
    if (service.isRunning()) await recovery.stop();
    else await recovery.start(store.load());
  } catch (error) {
    tray?.displayBalloon({ title: 'Обход', content: error.message, iconType: 'error' });
  } finally {
    updateTrayMenu();
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const running = service?.isRunning() === true;
  tray.setToolTip(running ? 'Обход — включён' : 'Обход — выключен');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть Обход', click: showWindow },
    { label: running ? 'Сервис включён' : 'Сервис выключен', enabled: false },
    { label: running ? 'Выключить' : 'Включить', click: toggleServiceFromTray },
    { type: 'separator' },
    ...(updateReady ? [{ label: 'Установить обновление', click: installDownloadedUpdate }]
      : availableUpdateVersion ? [{ label: `Скачать обновление ${availableUpdateVersion}`, click: downloadUpdate }]
        : [{ label: 'Проверить обновления', click: () => checkForUpdates(true) }]),
    { type: 'separator' },
    { label: 'Выход', click: () => { isQuitting = true; app.quit(); } }
  ]));
}

function sendUpdateEvent(type, message, extra = {}) {
  updateState = { ...updateState, type, message, ...extra };
  mainWindow?.webContents.send('updater:event', updateState);
}

function friendlyUpdaterError(error, action = 'проверить') {
  const details = String(error?.message || error || '');
  if (/ENOENT|update\.ya?ml/i.test(details)) {
    return 'Автоматическая проверка недоступна в portable-версии. Новую сборку можно установить вручную или через установщик.';
  }
  return `Не удалось ${action} обновление. Проверьте подключение и повторите попытку позже.`;
}

async function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    const result = { supported: false, message: 'Проверка обновлений доступна в установленной версии.' };
    if (manual) sendUpdateEvent('disabled', result.message, { supported: false });
    return result;
  }
  try {
    await autoUpdater.checkForUpdates();
    return { supported: true };
  } catch (error) {
    const message = friendlyUpdaterError(error);
    sendUpdateEvent('error', message);
    return { supported: true, error: message };
  }
}

async function downloadUpdate() {
  if (!app.isPackaged || !availableUpdateVersion || updateReady) return { downloaded: false };
  sendUpdateEvent('downloading', `Загружаем версию ${availableUpdateVersion}: 0%`, {
    version: availableUpdateVersion, percent: 0
  });
  try {
    await autoUpdater.downloadUpdate();
    return { downloaded: true };
  } catch (error) {
    const message = friendlyUpdaterError(error, 'загрузить');
    sendUpdateEvent('error', message, { version: availableUpdateVersion });
    return { downloaded: false, error: message };
  }
}

async function installDownloadedUpdate() {
  assertBackupIdle();
  if (!updateReady) return { installed: false };
  isQuitting = true;
  if (service?.isRunning()) await recovery.stop();
  autoUpdater.quitAndInstall(false, true);
  return { installed: true };
}

function setupUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => sendUpdateEvent('checking', 'Проверяем обновления…'));
  autoUpdater.on('update-available', (info) => {
    availableUpdateVersion = info.version;
    updateTrayMenu();
    sendUpdateEvent('available', `Доступна версия ${info.version}. Загрузка начнётся только после подтверждения.`, {
      version: info.version, checkedAt: Date.now(), supported: true
    });
  });
  autoUpdater.on('update-not-available', () => {
    availableUpdateVersion = '';
    updateReady = false;
    updateTrayMenu();
    sendUpdateEvent('current', 'Установлена актуальная версия.', {
      version: '', checkedAt: Date.now(), supported: true
    });
  });
  autoUpdater.on('download-progress', (progress) => sendUpdateEvent(
    'downloading', `Загрузка версии ${availableUpdateVersion}: ${Math.round(progress.percent)}%`,
    { version: availableUpdateVersion, percent: Math.round(progress.percent) }
  ));
  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    availableUpdateVersion = info.version;
    updateTrayMenu();
    sendUpdateEvent('ready', `Версия ${info.version} загружена и готова к установке.`, { version: info.version });
  });
  autoUpdater.on('error', (error) => sendUpdateEvent('error', friendlyUpdaterError(error)));
}

function createTray() {
  const iconPath = path.join(app.getAppPath(), 'windows', 'build', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
  updateTrayMenu();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 720,
    minWidth: 1180,
    minHeight: 720,
    maxWidth: 1180,
    maxHeight: 720,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Обход',
    icon: path.join(app.getAppPath(), 'windows', 'build', 'icon.png'),
    show: !smokeTest && !uiTest && !startHidden,
    backgroundColor: '#0d1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.on('close', (event) => {
    if (isQuitting || smokeTest || uiTest) return;
    event.preventDefault();
    mainWindow.hide();
    if (!trayHintShown) {
      trayHintShown = true;
      tray?.displayBalloon({
        title: 'Обход продолжает работать',
        content: 'Окно скрыто в системный трей. Для полного выхода используйте меню значка.',
        iconType: 'info'
      });
    }
  });
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  if (smokeTest) {
    mainWindow.webContents.once('did-finish-load', () => setTimeout(() => app.exit(0), 300));
    mainWindow.webContents.once('did-fail-load', () => app.exit(1));
  }
  if (uiTest) {
    mainWindow.webContents.once('did-finish-load', () => setTimeout(async () => {
      try {
        const result = await mainWindow.webContents.executeJavaScript(`(async () => {
          const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
          await wait(300);
          const onboarding = document.getElementById('onboardingDialog');
          const firstLaunch = onboarding.open && document.getElementById('onboardingProgress').textContent.includes('1 из 3');
          showOnboardingStep(2);
          const onboardingStepTwo = !document.querySelector('[data-onboarding-page="2"]').hidden
            && document.getElementById('onboardingPresetSummary').textContent.length > 0;
          showOnboardingStep(3);
          const onboardingFlow = onboardingStepTwo && !document.querySelector('[data-onboarding-page="3"]').hidden;
          onboarding.close();
          const homeShell = document.querySelector('.app-shell');
          document.querySelector('[data-view="help"]').click();
          if (!document.getElementById('view-help').classList.contains('active')) throw new Error('Help did not open');
          openLocalDialog();
          document.getElementById('localDomains').value = 'https://Example.com/page';
          document.getElementById('localDomains').dispatchEvent(new Event('input'));
          if (!document.getElementById('domainPreview').textContent.includes('example.com')
            || document.getElementById('domainPreview').textContent.includes('/page')) throw new Error('Incorrect domain preview');
          document.getElementById('localDialog').close();
          showView('home');
          if (document.getElementById('homeAutoDetail') || document.getElementById('openQuickHelp')) throw new Error('Home contains extra settings');
          if (document.documentElement.scrollHeight > window.innerHeight + 1) throw new Error('Home must not scroll');
          const fullWindowBackground = homeShell.classList.contains('home-active')
            && getComputedStyle(homeShell, '::before').position === 'fixed'
            && getComputedStyle(homeShell, '::after').position === 'fixed';
          document.querySelector('[data-view="settings"]').click();
          window.scrollTo(0, 500);
          document.querySelector('[data-settings-pane="app"]').click();
          await wait(30);
          const navigation = window.scrollY === 0
            && document.getElementById('settings-app').classList.contains('active')
            && document.querySelector('#settings-app h1').textContent === 'Обновления';
          const stickyTabs = getComputedStyle(document.querySelector('.settings-tabs')).position === 'sticky';
          const settingsIcons = document.querySelectorAll('.settings-tab').length === 5
            && ![...document.querySelectorAll('.settings-tab')].some((item) => /^\d/.test(item.textContent.trim()));
          const nativeFrameLayout = !document.querySelector('.app-titlebar')
            && getComputedStyle(document.getElementById('view-home')).overflow === 'hidden'
            && !document.querySelector('.app-shell').classList.contains('home-active');
          const routing = document.getElementById('settings-routing');
          const basic = document.getElementById('settings-dns').contains(document.getElementById('trafficMode'))
            && !routing.querySelector('.routing-general').contains(document.getElementById('listenPort'));
          const advanced = document.getElementById('settings-dns').contains(document.getElementById('listenPort'))
            && document.getElementById('settings-dns').contains(document.getElementById('dnsResolverEnabled'))
            && document.getElementById('settings-failover').contains(document.getElementById('failoverEnabled'));
          const protocolOptions = [...document.getElementById('tunnelType').options].map((item) => item.value);
          const visuallyHidden = (id) => getComputedStyle(document.getElementById(id)).display === 'none';
          renderProtocolFields('hysteria2');
          const hysteriaFields = !visuallyHidden('proxyObfsTypeLabel') && visuallyHidden('proxySecondaryCredentialLabel')
            && visuallyHidden('proxyMethodLabel') && visuallyHidden('proxyFlowLabel')
            && document.getElementById('proxyTls').checked && document.getElementById('proxyTls').disabled;
          renderProtocolFields('tuic');
          const tuicFields = !visuallyHidden('proxySecondaryCredentialLabel') && !visuallyHidden('proxyCongestionLabel')
            && visuallyHidden('proxyMethodLabel') && visuallyHidden('proxyFlowLabel');
          renderProtocolFields('anytls');
          const anyTlsFields = !visuallyHidden('proxyIdleCheckLabel') && visuallyHidden('proxyObfsTypeLabel')
            && visuallyHidden('proxySecondaryCredentialLabel');
          renderProtocolFields('trojan');
          const trojanFields = visuallyHidden('proxySecondaryCredentialLabel') && visuallyHidden('proxyMethodLabel')
            && visuallyHidden('proxyFlowLabel') && !visuallyHidden('proxyCredentialLabel');
          renderProtocolFields('socks5');
          const socksFields = !visuallyHidden('proxyUsernameLabel')
            && getComputedStyle(document.getElementById('proxyTls').closest('label')).display === 'none'
            && getComputedStyle(document.getElementById('proxyTransport').closest('label')).display === 'none'
            && getComputedStyle(document.getElementById('proxyFingerprint').closest('label')).display === 'none';
          renderProtocolFields('http');
          const httpFields = !visuallyHidden('proxyUsernameLabel')
            && getComputedStyle(document.getElementById('proxyTls').closest('label')).display !== 'none'
            && getComputedStyle(document.getElementById('proxyTransport').closest('label')).display === 'none'
            && getComputedStyle(document.getElementById('proxyFingerprint').closest('label')).display === 'none';
          const stageOneProtocols = ['hysteria2', 'tuic', 'anytls', 'socks5', 'http'].every((type) => protocolOptions.includes(type))
            && hysteriaFields && tuicFields && anyTlsFields && trojanFields && socksFields && httpFields;
          renderProtocolFields('awg');
          const awgFields = protocolOptions.includes('awg') && !visuallyHidden('wireguardFields')
            && !visuallyHidden('awgFields') && visuallyHidden('proxyFields');
          renderProtocolFields('wireguard');
          config.routing.applicationRules = [{
            id: 'ui-app', name: 'Тестовая игра', path: 'D:\\\\Games\\\\Example\\\\game.exe', action: 'proxy', enabled: true
          }];
          document.getElementById('trafficMode').value = 'tun';
          renderApplicationRules();
          const applicationAction = document.querySelector('.application-rule-controls select');
          applicationAction.value = 'direct';
          applicationAction.dispatchEvent(new Event('change'));
          document.getElementById('trafficMode').value = 'system-proxy';
          renderTrafficMode();
          const proxyModeFields = !visuallyHidden('listenPortLabel')
            && document.getElementById('listenPortTitle').textContent.includes('системного прокси');
          const applicationRules = document.querySelectorAll('.application-rule-card').length === 1
            && document.querySelector('.application-rule-copy small').textContent.endsWith('game.exe')
            && config.routing.applicationRules[0].action === 'direct'
            && !visuallyHidden('applicationModeNotice');
          installedApplicationCandidates = [
            { name: 'XBOX', path: 'C:\\\\Users\\\\PrivateName\\\\WindowsApps\\\\XboxPcApp.exe', source: 'installed' }
          ];
          runningApplicationCandidates = [
            { name: 'Тестовая игра', path: 'D:\\\\Games\\\\Example\\\\game.exe', processCount: 1, source: 'running' }
          ];
          fileApplicationCandidates = [];
          selectedApplicationPaths = new Set(['c:\\\\users\\\\privatename\\\\windowsapps\\\\xboxpcapp.exe']);
          document.getElementById('installedApplicationSearch').value = '';
          document.getElementById('runningApplicationSearch').value = '';
          renderApplicationPicker();
          const installedPickerRows = [...document.querySelectorAll('#installedApplicationList .application-picker-item')];
          const runningPickerRows = [...document.querySelectorAll('#runningApplicationList .application-picker-item')];
          const applicationPicker = installedPickerRows.length === 1 && runningPickerRows.length === 1
            && runningPickerRows[0].querySelector('input').disabled
            && document.querySelector('[data-application-picker-pane="installed"]').classList.contains('active')
            && installedPickerRows[0].textContent.includes('Установлено')
            && !document.getElementById('installedApplicationList').textContent.includes('PrivateName')
            && !document.getElementById('addSelectedApplications').disabled
            && document.getElementById('addSelectedApplications').textContent.includes('1');
          document.getElementById('applicationPickerDialog').showModal();
          const modalScrollLock = getComputedStyle(document.documentElement).overflow === 'hidden'
            && getComputedStyle(document.getElementById('installedApplicationList')).overscrollBehaviorY === 'contain';
          document.getElementById('applicationPickerDialog').close();
          document.getElementById('trafficMode').value = 'tun';
          renderTrafficMode();
          const tunModeFields = visuallyHidden('listenPortLabel') && !visuallyHidden('strictRouteLabel');
          showTunnelFieldError('Некорректный порт сервера.');
          const fieldErrors = document.getElementById('endpointPort').closest('label').classList.contains('field-error');
          clearTunnelFieldErrors();
          document.getElementById('tunnelType').value = 'tuic';
          renderProtocolFields('tuic');
          document.getElementById('tunnelName').value = 'Тест TUIC';
          document.getElementById('proxyServer').value = '';
          document.getElementById('proxyCredential').value = '';
          document.getElementById('proxySecondaryCredential').value = '';
          let requiredTunnelFields = false;
          try {
            validateTunnelRequiredFields(tunnelFromEditor());
          } catch (error) {
            requiredTunnelFields = document.getElementById('proxyServer').closest('label').classList.contains('field-error')
              && document.getElementById('proxyCredential').closest('label').classList.contains('field-error')
              && document.getElementById('proxySecondaryCredential').closest('label').classList.contains('field-error')
              && !document.getElementById('tunnelName').closest('label').classList.contains('field-error')
              && !cleanErrorMessage(error).includes('invoking remote method');
          }
          clearTunnelFieldErrors();
          document.getElementById('tunnelType').value = 'wireguard';
          renderProtocolFields('wireguard');
          const diagnostics = Boolean(document.getElementById('runDiagnostics'))
            && Boolean(document.getElementById('homePublicIp')) && !document.querySelector('.failure-policy .badge')
            && !document.querySelector('#view-home #diagnosticsPanel');
          document.getElementById('openJournal').click();
          await wait(30);
          const logRect = document.getElementById('log').getBoundingClientRect();
          const journalLayout = document.getElementById('view-diagnostics').classList.contains('active')
            && document.querySelector('[data-view="help"]').classList.contains('active')
            && logRect.height > 300 && logRect.bottom <= window.innerHeight
            && document.documentElement.scrollHeight <= window.innerHeight + 1;
          document.querySelector('[data-view="settings"]').click();
          showSettingsPane('routing');
          const saveBar = document.querySelector('.routing-save-bar');
          const stickySave = getComputedStyle(saveBar).position === 'fixed'
            && Boolean(document.getElementById('cancelRouting')) && Boolean(document.getElementById('saveRouting'));
          toast('Тестовая ошибка сохранения', true);
          const toastElement = document.getElementById('toast');
          const toastRect = toastElement.getBoundingClientRect();
          const saveRect = saveBar.getBoundingClientRect();
          const toastPlacement = toastRect.bottom < saveRect.top && toastRect.top >= 0
            && Number(getComputedStyle(toastElement).zIndex) > Number(getComputedStyle(saveBar).zIndex)
            && toastElement.getAttribute('aria-live') === 'assertive';
          const compactPresets = getComputedStyle(document.querySelector('.routing-presets .preset small')).display === 'none'
            && document.querySelectorAll('.routing-presets .preset').length > 4;
          config.tunnels.push({ id: 'ui-existing', name: 'Тестовое подключение', type: 'wireguard' });
          config.routing.activeTunnelId = 'ui-existing';
          openTunnelEditor();
          const creationMode = creatingTunnel
            && document.getElementById('tunnelEditor').classList.contains('creating')
            && document.getElementById('tunnelEditorMode').textContent === 'НОВЫЙ'
            && document.querySelector('.tunnel-card.draft')?.textContent.includes('СОЗДАЁТСЯ')
            && document.getElementById('tunnelEditorHint').textContent.includes('существующие подключения не изменятся');
          openTunnelEditor('ui-existing');
          const editingMode = !creatingTunnel
            && document.getElementById('tunnelEditor').classList.contains('editing')
            && document.getElementById('tunnelEditorMode').textContent === 'СОХРАНЁН'
            && !document.querySelector('.tunnel-card.draft');
          document.getElementById('openOnboarding').click();
          const existingButton = document.getElementById('onboardingUseExisting');
          existingButton.click();
          const repeatOnboarding = onboarding.open && !existingButton.hidden
            && existingButton.textContent.includes('Тестовое подключение')
            && !document.querySelector('[data-onboarding-page="2"]').hidden;
          onboarding.close();
          document.querySelector('[data-view="home"]').click();
          setRunning(true);
          const appShell = document.querySelector('.app-shell');
          const activeBackground = document.getElementById('view-home').classList.contains('service-turning-on')
            && appShell.classList.contains('service-turning-on')
            && getComputedStyle(appShell, '::before').animationName.includes('home-glow-pulse')
            && getComputedStyle(appShell, '::after').animationName.includes('grid-zoom-out');
          setRunning(false);
          const stoppedBackground = document.getElementById('view-home').classList.contains('service-turning-off')
            && appShell.classList.contains('service-turning-off')
            && getComputedStyle(appShell, '::after').animationName.includes('grid-zoom-in');
          renderUpdateState({ type: 'error', version: '99.0.0', message: 'Тестовая ошибка обновления' });
          const updateError = !document.getElementById('updateBanner').hidden
            && document.getElementById('updateStatus').textContent.includes('Тестовая ошибка');
          // Exercise subscription IPC and the import dialog without an external provider.
          const beforeSubscription = await window.obhod.loadProfile();
          config = structuredClone(beforeSubscription);
          config.tunnels = []; config.routing.failoverTunnelIds = []; renderAll();
          const emptySelectAll = document.getElementById('failoverSelectAll').disabled;
          config.tunnels = Array.from({ length: 50 }, (_, index) => ({
            id: 'group-' + index, type: 'socks5', name: 'Сервер ' + index + ' — Очень длинное название подключения '.repeat(3),
            server: '192.0.2.10', serverPort: 1080
          }));
          config.routing.activeTunnelId = config.tunnels[0].id;
          config.routing.failoverEnabled = true;
          config.routing.failoverTunnelIds = config.tunnels.slice(0, 2).map((tunnel) => tunnel.id);
          renderAll(); showView('settings'); showSettingsPane('failover'); setRoutingDirty(false);
          const selectAll = document.getElementById('failoverSelectAll');
          const partialSelection = selectAll.indeterminate && !selectAll.checked;
          selectAll.click();
          const selectedAll = document.querySelectorAll('#failoverTunnels input:checked').length === 50
            && selectAll.checked && !selectAll.indeterminate
            && document.getElementById('failoverSelectedCount').textContent === 'Выбрано: 50'
            && !document.getElementById('saveRouting').disabled;
          selectAll.click();
          const clearedAll = document.querySelectorAll('#failoverTunnels input:checked').length === 0
            && !selectAll.checked && !selectAll.indeterminate;
          document.querySelector('#failoverTunnels input').click();
          const individualSelection = selectAll.indeterminate && !selectAll.checked;
          selectAll.click();
          document.querySelector('#failoverTunnels input').click();
          const failoverSelectAll = emptySelectAll && partialSelection && selectedAll && clearedAll && individualSelection
            && selectAll.indeterminate && document.querySelectorAll('#failoverTunnels input:checked').length === 49;
          config.routing.failoverTunnelIds = config.tunnels.map((tunnel) => tunnel.id);
          renderAll(); showSettingsPane('routing');
          await wait(30);
          const summary = document.querySelector('.route-source-summary');
          const panel = document.querySelector('.routing-general');
          const detail = document.getElementById('activeFailoverDetail');
          const sourceBounds = summary.getBoundingClientRect();
          const panelBounds = panel.getBoundingClientRect();
          const actionBounds = document.querySelector('.route-source-action').getBoundingClientRect();
          const failoverSummaryLayout = sourceBounds.right <= panelBounds.right && sourceBounds.left >= panelBounds.left
            && actionBounds.right <= sourceBounds.right && actionBounds.width > 0
            && detail.scrollWidth > detail.clientWidth && getComputedStyle(detail).textOverflow === 'ellipsis'
            && detail.title.includes('Сервер 49') && document.documentElement.scrollWidth <= window.innerWidth;
          config = structuredClone(beforeSubscription); renderAll();
          const subscriptionUri = 'vless://11111111-1111-4111-8111-111111111111@192.0.2.10:443?security=tls&sni=example.com#Subscription';
          const waitForSubscription = async (condition) => { const deadline = Date.now() + 10000; while (!condition()) { if (Date.now() > deadline) throw new Error('Subscription UI timed out'); await wait(30); } };
          document.getElementById('importProxy').click();
          document.getElementById('proxyImportType').value = 'subscription';
          document.getElementById('proxyImportType').dispatchEvent(new Event('change'));
          document.getElementById('proxyUri').value = [subscriptionUri, subscriptionUri].join(String.fromCharCode(10));
          document.getElementById('saveProxyUri').click();
          await waitForSubscription(() => !document.getElementById('proxyDialog').open);
          const afterSubscription = await window.obhod.loadProfile();
          const subscriptionAdded = afterSubscription.tunnels.length === beforeSubscription.tunnels.length + 1
            && afterSubscription.tunnels.at(-1).name === 'Subscription';
          const activePreserved = !beforeSubscription.routing.activeTunnelId
            || afterSubscription.routing.activeTunnelId === beforeSubscription.routing.activeTunnelId;
          document.getElementById('importProxy').click();
          document.getElementById('proxyImportType').value = 'subscription';
          document.getElementById('proxyImportType').dispatchEvent(new Event('change'));
          document.getElementById('proxyUri').value = subscriptionUri;
          document.getElementById('saveProxyUri').click();
          await waitForSubscription(() => !document.getElementById('proxyImportError').hidden);
          const subscriptionImport = subscriptionAdded && activePreserved
            && document.getElementById('proxyImportError').textContent.includes('уже добавлены')
            && (await window.obhod.loadProfile()).tunnels.length === afterSubscription.tunnels.length;
          document.getElementById('proxyDialog').close();
          config = await window.obhod.saveProfile(beforeSubscription); renderAll();
          // Exercise the real IPC, encryption, preview and import in the isolated test profile.
          const fixture = await window.obhod.loadProfile();
          fixture.tunnels = [{ id: 'backup-test', type: 'socks5', name: 'Резервная копия', server: '127.0.0.1', serverPort: 1080, username: 'backup-user', password: 'backup-secret' }];
          fixture.routing.activeTunnelId = 'backup-test'; fixture.routing.presetIds = [];
          fixture.routing.remoteLists = []; fixture.routing.applicationRules = [];
          await window.obhod.saveProfile(fixture);
          const until = async (condition) => { const deadline = Date.now() + 10000; while (!condition()) { if (Date.now() > deadline) throw new Error('Backup UI timed out'); await wait(50); } };
          showView('settings'); showSettingsPane('backup');
          document.getElementById('openBackupExport').click();
          document.getElementById('backupPassword').value = 'test backup password';
          document.getElementById('backupPasswordRepeat').value = 'wrong password';
          document.querySelector('#exportBackupDialog form').requestSubmit();
          if (!document.getElementById('backupExportError').textContent.includes('не совпадают')) throw new Error('Missing password confirmation');
          document.getElementById('backupPasswordRepeat').value = 'test backup password';
          document.querySelector('#exportBackupDialog form').requestSubmit();
          await until(() => !document.getElementById('exportBackupDialog').open);
          if (document.getElementById('backupPassword').value) throw new Error('Password was retained');
          document.getElementById('openBackupImport').click();
          await until(() => document.getElementById('importBackupDialog').open);
          document.getElementById('importPassword').value = 'incorrect';
          document.querySelector('#importBackupDialog form').requestSubmit();
          await until(() => document.getElementById('backupImportError').textContent.includes('Неверный пароль'));
          document.getElementById('importPassword').value = 'test backup password';
          document.querySelector('#importBackupDialog form').requestSubmit();
          await until(() => !document.getElementById('backupPreview').hidden);
          if (!document.getElementById('backupSummary').textContent.includes('Подключения: 1')) throw new Error('Missing import summary');
          document.getElementById('backupImportMode').value = 'replace';
          document.querySelector('#importBackupDialog form').requestSubmit();
          await until(() => !document.getElementById('importBackupDialog').open);
          if ((await window.obhod.loadProfile()).tunnels[0].password !== 'backup-secret') throw new Error('Import did not restore credentials');
          showView('home');
          if (document.documentElement.scrollHeight > window.innerHeight + 1) throw new Error('Home scrolls after import');
          return { firstLaunch, onboardingFlow, fullWindowBackground, navigation, stickyTabs, settingsIcons, nativeFrameLayout, creationMode, editingMode, basic, advanced, proxyModeFields, tunModeFields, stageOneProtocols: stageOneProtocols && awgFields, applicationRules, applicationPicker, modalScrollLock, fieldErrors, requiredTunnelFields, diagnostics, journalLayout, stickySave, toastPlacement, compactPresets, repeatOnboarding, activeBackground, stoppedBackground, updateError, subscriptionImport, failoverSelectAll, failoverSummaryLayout };
        })().catch((error) => ({ __error: error.stack || error.message }))`);
        if (result.__error) throw new Error(result.__error);
        const failed = Object.entries(result).filter(([, value]) => !value).map(([key]) => key);
        console.log(`UI_TEST_RESULT ${JSON.stringify(result)}`);
        if (process.env.OBHOD_UI_SCREENSHOT) {
          await mainWindow.webContents.executeJavaScript("showView('home'); renderSummary(); document.getElementById('toast').className = ''; renderUpdateState({ type: 'idle', version: '', message: '' });");
          mainWindow.showInactive();
          await new Promise((resolve) => setTimeout(resolve, 500));
          fs.writeFileSync(process.env.OBHOD_UI_SCREENSHOT, (await mainWindow.webContents.capturePage()).toPNG());
        }
        if (process.env.OBHOD_UI_SCREENSHOTS) {
          const directory = process.env.OBHOD_UI_SCREENSHOTS;
          fs.mkdirSync(directory, { recursive: true }); mainWindow.showInactive();
          await mainWindow.webContents.executeJavaScript("document.getElementById('toast').className = ''; renderUpdateState({ type: 'idle', version: '', message: '' });");
          for (const view of ['home', 'general', 'dns', 'backup', 'help']) {
            await mainWindow.webContents.executeJavaScript(['home', 'help'].includes(view)
              ? `showView('${view}')` : `showView('settings'); showSettingsPane('${view}')`);
            await new Promise((resolve) => setTimeout(resolve, 300));
            fs.writeFileSync(path.join(directory, `${view}.png`), (await mainWindow.webContents.capturePage()).toPNG());
          }
        }
        app.exit(failed.length ? 1 : 0);
      } catch (error) {
        console.error(`UI_TEST_ERROR ${error.stack || error.message}`);
        app.exit(1);
      }
    }, 700));
    mainWindow.webContents.once('did-fail-load', () => app.exit(1));
  }
}

app.whenReady().then(async () => {
  app.setAppUserModelId('ru.obhod.desktop');
  store = new ProfileStore(app.getPath('userData'), safeStorage);
  const startupProfile = store.load();
  service = new SingBoxService({
    userDataPath: app.getPath('userData'),
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    onEvent: (event) => {
      mainWindow?.webContents.send('engine:event', event);
      if (event.type !== 'log') updateTrayMenu();
    }
  });
  recovery = new RecoveryController({
    service,
    loadProfile: () => store.load(),
    onEvent: (event) => {
      mainWindow?.webContents.send('engine:event', event);
      if (event.type !== 'log') updateTrayMenu();
    }
  });
  const originalOnEvent = service.onEvent;
  service.onEvent = (event) => {
    originalOnEvent(event);
    if (event.unexpectedExit) recovery.handleUnexpectedExit();
  };
  await service.recoverStaleProxy();

  if (uiTest) {
    // Native pickers are replaced only in the isolated --ui-test process.
    const file = path.join(app.getPath('userData'), 'round-trip.obhod');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }

  ipcMain.handle('profile:load', () => store.load());
  ipcMain.handle('profile:save', (_event, profile) => {
    assertBackupIdle();
    const saved = store.save(profile);
    applyLoginSettings(saved);
    return saved;
  });
  ipcMain.handle('engine:status', () => service.status());
  ipcMain.handle('engine:start', async (_event, profile) => {
    assertBackupIdle();
    const saved = store.save(profile);
    applyLoginSettings(saved);
    return recovery.start(saved);
  });
  ipcMain.handle('engine:apply', async (_event, profile) => {
    assertBackupIdle();
    const saved = store.save(profile);
    applyLoginSettings(saved);
    const result = await recovery.apply(saved);
    return { profile: saved, ...result };
  });
  ipcMain.handle('engine:stop', () => { assertBackupIdle(); return recovery.stop(); });
  ipcMain.handle('backup:export', async (_event, options = {}) => {
    assertBackupIdle(); backupBusy = true;
    try {
      const data = await encodeBackup(store.load(), options.kind, options.password);
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Сохранить конфигурацию Обхода', defaultPath: options.kind === 'full' ? 'Обход.obhod' : 'Правила-Обхода.obhod',
        filters: [{ name: 'Конфигурация Обхода', extensions: ['obhod'] }]
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      // Sibling temporary file avoids a partially written export.
      const temporary = `${result.filePath}.${require('node:crypto').randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, data, { mode: 0o600 }); fs.renameSync(temporary, result.filePath); }
      finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return { canceled: false };
    } finally { backupBusy = false; }
  });
  ipcMain.handle('backup:choose', async () => {
    assertBackupIdle(); backupBusy = true; pendingBackup = null;
    try {
      const result = await dialog.showOpenDialog(mainWindow, { title: 'Открыть конфигурацию Обхода', properties: ['openFile'],
        filters: [{ name: 'Конфигурация Обхода', extensions: ['obhod'] }] });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      const file = result.filePaths[0];
      if (fs.statSync(file).size > MAX_BYTES) throw new Error('Файл слишком большой (максимум 16 МБ).');
      const text = fs.readFileSync(file, 'utf8');
      const header = inspectBackup(text);
      pendingBackup = { text, expires: Date.now() + 10 * 60 * 1000 };
      return { canceled: false, encrypted: header.kind === 'full', name: path.basename(file) };
    } finally { backupBusy = false; }
  });
  ipcMain.handle('backup:preview', async (_event, password) => {
    assertBackupIdle();
    if (!pendingBackup || pendingBackup.expires < Date.now()) { pendingBackup = null; throw new Error('Выберите файл ещё раз.'); }
    backupBusy = true;
    try {
      pendingBackup.decoded = await decodeBackup(pendingBackup.text, password);
      return importSummary(store.load(), pendingBackup.decoded);
    } finally { backupBusy = false; }
  });
  ipcMain.handle('backup:cancel', () => { assertBackupIdle(); pendingBackup = null; });
  ipcMain.handle('backup:import', async (_event, mode) => {
    assertBackupIdle();
    if (!pendingBackup?.decoded || pendingBackup.expires < Date.now()) { pendingBackup = null; throw new Error('Сначала откройте файл и проверьте его содержимое.'); }
    backupBusy = true;
    try {
      const candidate = prepareImport(store.load(), pendingBackup.decoded, mode);
      return await applyImport({ store, recovery, service, candidate });
    } finally { pendingBackup = null; backupBusy = false; }
  });
  ipcMain.on('network:status-changed', (_event, online) => recovery.handleNetworkChange(online));
  ipcMain.handle('engine:connection-info', (_event, profile) => service.connectionInfo(profile));
  ipcMain.handle('network:public-ip', () => getPublicIp());
  ipcMain.handle('diagnostics:engine-version', () => service.versionInfo());
  ipcMain.handle('dns:test', (_event, settings) => testDnsLatency(settings));
  ipcMain.handle('tunnel:parse', (_event, text, name) => parseWireGuardConfig(text, name));
  ipcMain.handle('proxy:parse', (_event, text, name) => parseProxyUri(text, name));
  ipcMain.handle('subscription:import', async (_event, text, existing = []) =>
    mergeSubscription(existing, await loadSubscription(text)));
  ipcMain.handle('tunnel:test', (_event, tunnel) => service.testTunnel(tunnel));
  ipcMain.handle('catalog:presets', () => PODKOP_PRESETS);
  ipcMain.handle('applications:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите приложения',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Приложения Windows', extensions: ['exe'] }]
    });
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => ({
      name: path.win32.basename(filePath, path.win32.extname(filePath)), path: filePath
    }));
  });
  ipcMain.handle('applications:installed', () => listInstalledApplications());
  ipcMain.handle('applications:running', () => listRunningApplications());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('updater:check', () => checkForUpdates(true));
  ipcMain.handle('updater:download', () => downloadUpdate());
  ipcMain.handle('updater:install', () => installDownloadedUpdate());
  ipcMain.handle('updater:status', () => ({ ...updateState, supported: app.isPackaged }));
  ipcMain.handle('diagnostics:copy', (_event, text) => {
    clipboard.writeText(redactSensitive(text).slice(0, 100000));
    return { copied: true };
  });
  ipcMain.handle('diagnostics:export', async (_event, text) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Экспорт диагностического отчёта',
      defaultPath: `obhod-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: 'Текстовый отчёт', extensions: ['txt'] }]
    });
    if (result.canceled || !result.filePath) return { exported: false };
    fs.writeFileSync(result.filePath, redactSensitive(text).slice(0, 100000), 'utf8');
    return { exported: true };
  });

  applyLoginSettings(startupProfile);
  recovery.handleNetworkChange(net.isOnline());
  powerMonitor.on('resume', () => recovery.handleResume());
  if (!uiTest) createTray();
  createWindow();
  setupUpdater();
  if (!smokeTest && !uiTest && app.isPackaged) {
    if (startupProfile.routing.autoCheckUpdates) {
      setTimeout(() => {
        if (store.load().routing.autoCheckUpdates) checkForUpdates(false);
      }, 5000);
    }
    setInterval(() => {
      if (store.load().routing.autoCheckUpdates) checkForUpdates(false);
    }, 6 * 60 * 60 * 1000);
  }
  if (!smokeTest && !uiTest && startupProfile.routing.startOnLaunch && startupProfile.tunnels.length) {
    recovery.start(startupProfile).catch((error) => {
      tray?.displayBalloon({ title: 'Не удалось включить Обход', content: error.message, iconType: 'error' });
    });
  }
  app.on('activate', showWindow);
});

app.on('before-quit', (event) => {
  if (backupBusy) { event.preventDefault(); isQuitting = false; return; }
  isQuitting = true;
  if (service?.isRunning() && !stoppingForQuit) {
    event.preventDefault();
    stoppingForQuit = true;
    recovery.stop().finally(() => app.quit());
  }
});

app.on('window-all-closed', () => {});
