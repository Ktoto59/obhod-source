// Run: npx electron scripts/capture-doc-screenshots.js
// Renders the real interfaces with reserved example addresses and synthetic state.
// No production main process, network core, real router or user data is used.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_CONFIG, PODKOP_PRESETS, parseProxyUri } = require('../shared/profile');
const { defaultRouterProfile } = require('../openwrt/lib/config');
const { buildCore } = require('./build-openwrt-core');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs/images');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(root, '.tmp', 'docs-preview-' + process.pid));
const exampleTunnels = () => [
  parseProxyUri('socks5://192.0.2.10:1080#' + encodeURIComponent('Основное подключение')),
  parseProxyUri('socks5://198.51.100.20:1080#' + encodeURIComponent('Резервное подключение')),
  parseProxyUri('socks5://203.0.113.30:1080#' + encodeURIComponent('Дополнительное подключение'))
];
function profile(router = false) {
  const value = router ? defaultRouterProfile() : structuredClone(DEFAULT_CONFIG);
  value.tunnels = exampleTunnels();
  Object.assign(value.routing, {
    activeTunnelId: value.tunnels[0].id, failoverEnabled: true,
    failoverTunnelIds: value.tunnels.slice(0, 2).map(t => t.id), failoverInterval: '1m',
    presetIds: ['telegram', 'discord'], onboardingCompleted: true, dnsResolverEnabled: true,
    dnsProtocol: 'https', dnsServer: 'cloudflare-dns.com', dnsBootstrap: '1.1.1.1',
    localLists: [{ id: 'docs-example', name: 'Рабочие сайты', enabled: true,
      domains: ['example.com', 'docs.example.org', 'media.example.net'], cidrs: [] }],
    remoteLists: [], applicationRules: [], autoCheckUpdates: false
  });
  return value;
}
const paint = async win => {
  await win.webContents.executeJavaScript('document.fonts.ready');
  await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  await new Promise(r => setTimeout(r, 350));
};
async function shot(win, name, code) {
  if (code) await win.webContents.executeJavaScript(code);
  await win.webContents.executeJavaScript('if (document.activeElement instanceof HTMLElement) document.activeElement.blur();');
  await paint(win);
  fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG());
  console.log('Captured ' + name);
}
async function windows() {
  const demo = profile();
  const status = { running: true, startedAt: Date.now() - 12 * 60000,
    engineVersion: '1.14.0-rc.1-awgm.15',
    ruleStatus: { sourcesReady: 3, sourcesTotal: 3, knownEntries: 3, entriesComplete: false, warnings: [] } };
  ipcMain.handle('docs:fixture', (_, method) => {
    switch (method) {
      case 'loadProfile': return demo;
      case 'status': return status;
      case 'connectionInfo': return { name: demo.tunnels[0].name, type: 'socks5', latency: 84, available: true };
      case 'publicIp': return '203.0.113.50';
      case 'presets': return PODKOP_PRESETS;
      case 'appVersion': return require('../package.json').version;
      case 'updateStatus': return { type: 'idle', message: 'Обновления ещё не проверялись.', version: '' };
      case 'engineVersion': return status.engineVersion;
      case 'installedApplications': case 'runningApplications': return [];
      default: throw new Error('Documentation fixture does not support ' + method);
    }
  });
  const win = new BrowserWindow({ show: false, width: 1280, height: 960, useContentSize: true,
    webPreferences: { preload: path.join(__dirname, 'docs-preview-preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadFile(path.join(root, 'windows/src/renderer/index.html'));
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript('typeof config !== "undefined" && !!config && document.getElementById("tunnelCards").children.length === 3')) break;
    await new Promise(r => setTimeout(r, 50));
  }
  if (!await win.webContents.executeJavaScript('typeof config !== "undefined" && !!config && document.getElementById("tunnelCards").children.length === 3')) {
    throw new Error('Windows documentation fixture did not finish loading');
  }
  await win.webContents.executeJavaScript('updateLatency(); updatePublicIp();');
  await shot(win, 'windows-home', "showView('home');");
  await shot(win, 'windows-connections', "showView('settings'); showSettingsPane('tunnels');");
  await shot(win, 'windows-import', "document.getElementById('importProxy').click(); document.getElementById('proxyImportType').value='subscription'; document.getElementById('proxyImportType').dispatchEvent(new Event('change')); document.getElementById('proxyUri').value='https://subscription.example.com/example';");
  await win.webContents.executeJavaScript("document.getElementById('proxyDialog').close();");
  await shot(win, 'windows-rules', "showView('settings'); showSettingsPane('routing');");
  await shot(win, 'windows-domain-list', "document.getElementById('addLocalList').click(); document.getElementById('localListName').value='Рабочие сайты'; document.getElementById('localDomains').value='example.com\\ndocs.example.org\\nmedia.example.net';");
  await win.webContents.executeJavaScript("document.getElementById('localDialog').close();");
  await shot(win, 'windows-failover', "showSettingsPane('failover'); document.querySelector('#settings-failover details').open=true;");
  win.setContentSize(1280, 1140);
  await shot(win, 'windows-network', "showSettingsPane('dns'); document.querySelector('#settings-dns details').open=true;");
  win.setContentSize(1280, 960);
  await shot(win, 'windows-backup', "showSettingsPane('backup');");
  win.hide();
}
async function openwrt() {
  const saved = { version: 1, profile: profile(true), options: { interfaces: ['br-lan'], manageDns: true, ipv6: false,
    dnsPoolMode: 'balanced', dnsUpstreams: ['https://1.1.1.1/dns-query', 'https://1.0.0.1/dns-query'], dnsBootstrapServers: ['1.1.1.1', '1.0.0.1'] } };
  const css = fs.readFileSync(path.join(root, 'openwrt/luci-app-obhod/htdocs/luci-static/resources/obhod/overview.css'), 'utf8');
  const loader = fs.readFileSync(path.join(root, '.tmp/openwrt-tools/luci-25.12.6.js'), 'utf8');
  const theme = fs.readFileSync(path.join(root, '.tmp/openwrt-tools/luci-bootstrap-25.12.6.css'), 'utf8');
  const source = fs.readFileSync(path.join(root, 'openwrt/luci-app-obhod/htdocs/luci-static/resources/view/obhod/overview.js'), 'utf8');
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'openwrt/obhod/files/usr/share/obhod/core-catalog.json')));
  const versions = catalog.packages.filter(v => v.arch === 'aarch64_cortex-a53' && v.manager === 'apk').map(v => ({
    profile: v.profile, value: v.coreVersion, recommended: v.coreVersion === '1.13.21-obhod.3', downloadBytes: v.bytes, installedBytes: v.installedBytes
  }));
  const win = new BrowserWindow({ show: false, width: 1180, height: 1040, useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><style>' + theme + '</style><style>html,body{background:#222;color:#eee}body{font:14px sans-serif;margin:28px;padding:0;min-height:0}#page{width:100%;max-width:1120px;margin:auto}</style><main id="page"></main>'));
  await win.webContents.executeJavaScript(`(async()=>{
    new Function(${JSON.stringify(loader)})(); window.L=window.LuCI.prototype;
    String.prototype.format=function(...args){let i=0;return this.replace(/%[sd]/g,()=>String(args[i++]));};
    L.env.base_url='/luci-static/resources';L.error=L.raise;
    L.Request.get=async url=>({ok:true,url,text:()=>${JSON.stringify(buildCore())}});
    const core=await L.require('obhod.core'),dom=await L.require('dom');
    const saved=${JSON.stringify(saved)},versions=${JSON.stringify(versions)};
    const state={running:true,enabled:true,configured:true,version:'sing-box version 1.13.21-obhod.3',coreFlavor:'sing-box-tiny',
      obhodVersion:'0.1.16',dnsPoolNative:true,dnsPoolReady:true,routeName:'Основное подключение',routeDelay:'84',routeOk:true,routeCheckedAt:Math.floor(Date.now()/1000)};
    const checks=['Конфигурация','Служба','LAN-интерфейсы','Перехват трафика','DNS роутера','HTTPS через подключение','FakeIP через DNS роутера'].map(name=>({name,ok:true,message:name==='HTTPS через подключение'?'Основное подключение · 84 мс':'Проверка выполнена.'}));
    const rpc={declare:spec=>async()=>{
      if(spec.method==='status')return state;
      if(spec.method==='interfaces')return{devices:[{name:'br-lan',label:'lan · br-lan · 192.0.2.1',up:true},{name:'br-guest',label:'guest · br-guest',up:true}]};
      if(spec.method==='coreVersions')return{versions};
      if(spec.method==='coreSizes')return Object.fromEntries(versions.filter(v=>v.recommended).map(v=>[v.profile,v]));
      if(spec.method==='diagnostics')return{checks,note:'Шлюз и DNS клиентского устройства должны указывать на этот роутер.'};
      if(spec.method==='logs')return{text:'Пример журнала. Личные данные и реальные запросы не используются.'};
      throw new Error('Unsupported documentation RPC '+spec.method);
    }};
    const view={extend:v=>v},fs={read:async file=>file.endsWith('settings.json')?JSON.stringify(saved):''};
    const ui={createHandlerFn:(owner,fn)=>(...args)=>fn.apply(owner,args),addNotification:()=>{},showModal:()=>{},hideModal:()=>{}};
    const pageL={resource:()=> 'data:text/css;base64,${Buffer.from(css).toString('base64')}'};
    const page=new Function('view','rpc','fs','ui','poll','core','E','L',${JSON.stringify(source)})(view,rpc,fs,ui,{add:()=>{}},core,(...args)=>dom.create(...args),pageL);
    document.getElementById('page').appendChild(page.render(await page.load()));window.obhodPage=page;
    await new Promise(r=>{const l=page.root.querySelector('link');if(l.sheet)r();else l.onload=r;});
  })()`);
  for (const tab of ['overview', 'connections', 'rules', 'protocols', 'network', 'diagnostics']) {
    await shot(win, 'openwrt-' + tab, `obhodPage.selectTab('${tab}'); scrollTo(0,0);`);
  }
  await shot(win, 'openwrt-import', "obhodPage.selectTab('connections'); obhodPage.importDetails.open=true; obhodPage.importText.value='https://subscription.example.com/example'; scrollTo(0,0);");
  await shot(win, 'openwrt-dns', "obhodPage.selectTab('network'); obhodPage.dnsPoolMode.scrollIntoView({block:'start'}); scrollBy(0,-80);");
  win.hide();
}
app.whenReady().then(async () => {
  const timer = setTimeout(() => { console.error('Screenshot capture timed out'); app.exit(1); }, 90000);
  try {
    fs.mkdirSync(output, { recursive: true });
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_, callback) => callback({ cancel: true }));
    await windows(); await openwrt(); clearTimeout(timer); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(timer); app.exit(1); }
});
