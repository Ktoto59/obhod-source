// Run with Electron; deliberately named check-* to avoid Node's test discovery.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { buildCore } = require('./build-openwrt-core');
const { defaultRouterProfile } = require('../openwrt/lib/config');
const { parseProxyUri } = require('../shared/profile');
const root = path.resolve(__dirname, '..');
const loaderFlag = process.argv.indexOf('--luci-loader');
const luciRuntime = loaderFlag === -1 ? '' : fs.readFileSync(process.argv[loaderFlag + 1], 'utf8');
const css = fs.readFileSync(path.join(root, 'openwrt/luci-app-obhod/htdocs/luci-static/resources/obhod/overview.css'), 'utf8');
const themeFlag = process.argv.indexOf('--luci-theme');
const themeCSS = themeFlag === -1 ? '' : fs.readFileSync(process.argv[themeFlag + 1], 'utf8');
app.disableHardwareAcceleration();
app.setPath('userData', path.join(root, '.tmp', 'openwrt-ui-test'));

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1180, height: 720, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
  const timeout = setTimeout(() => { console.error('OpenWrt UI test timed out'); app.exit(1); }, 20000);
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><style>'+themeCSS+'</style><style>html{background:#222}body{font:14px sans-serif;margin:28px;padding:0;min-height:0;background:#222;color:#eee}#page{width:100%;max-width:1120px;margin:0 auto}</style><main id="page"></main>'));
    const profile = defaultRouterProfile();
    profile.tunnels = Array.from({ length: 50 }, (_, index) => parseProxyUri(`socks5://192.0.2.10:${1080 + index}#${encodeURIComponent('Сервер ' + index + ' с очень длинным названием '.repeat(5))}`));
    profile.routing.activeTunnelId = profile.tunnels[0].id;
    profile.routing.failoverEnabled = true;
    profile.routing.failoverTunnelIds = profile.tunnels.slice(0, 2).map((tunnel) => tunnel.id);
    const saved = { version: 1, profile, options: { interfaces: ['br-lan'], manageDns: true, ipv6: false } };
    const source = fs.readFileSync(path.join(root, 'openwrt/luci-app-obhod/htdocs/luci-static/resources/view/obhod/overview.js'), 'utf8');
    const result = await window.webContents.executeJavaScript(`(async () => {
      const assert = (value, message) => { if (!value) throw new Error(message); };
      let core, nativeLoader = false, nativeDOM = null;
      const pageL = {resource:()=> 'data:text/css;base64,${Buffer.from(css).toString('base64')}'};
      const coreSource = ${JSON.stringify(buildCore())};
      const luciRuntime = ${JSON.stringify(luciRuntime)};
      if (luciRuntime) {
        // Use the unmodified loader from a verified OpenWrt rootfs. Only the
        // HTTP transport and unrelated page bootstrap are replaced for this test.
        new Function(luciRuntime)();
        window.L = window.LuCI.prototype;
        String.prototype.format = function(...args) { let i = 0; return this.replace(/%[sd]/g, () => String(args[i++])); };
        L.env.base_url = '/luci-static/resources';
        L.error = L.raise;
        L.Request.get = async (url) => ({ok:true,url,text:()=>url.includes('invalid') ? 'return {};' : coreSource});
        let rejected = false;
        try { await L.require('obhod.invalid'); } catch (error) { rejected = error instanceof TypeError && error.message.includes('factory yields invalid constructor'); }
        assert(rejected, 'Native LuCI loader reproduces the reported object-export failure');
        core = await L.require('obhod.core');
        assert(await L.require('obhod.core') === core, 'LuCI caches the module instance');
        assert(core instanceof (await L.require('baseclass')), 'Native LuCI loader accepts the core class');
        nativeDOM = await L.require('dom');
        nativeLoader = true;
      } else {
        class BaseClass {}
        BaseClass.extend = methods => { class Derived extends BaseClass {} Object.assign(Derived.prototype, methods); return Derived; };
        const Core = new Function('baseclass', coreSource)(BaseClass);
        assert(typeof Core === 'function' && Core.prototype instanceof BaseClass, 'Core exports a LuCI class constructor');
        core = new Core();
      }
      let running = false, applied = null, saves = 0, dnsPoolReady = false;
      let coreBusy = false, coreFlavor = 'sing-box-tiny', wireguard = false;
      let updateBusy = false, updateAvailable = false, updateState = '', appVersion = '0.1.5', failStatus = false, poller;
      const updateRequests = [];
      const coreRequests = [];
      let jobBusy=false, jobState='', logBody='WARN: тестовая запись\\n';
      const serviceRequests=[], diagnosticRequests=[];
      const notifications = [];
      function E(tag, attrs, children) {
        if (nativeDOM) return nativeDOM.create(tag, attrs, children);
        const node = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([key, value]) => {
          if (value == null) return;
          if (typeof value === 'function') node.addEventListener(key, value);
          else node.setAttribute(key, String(value));
        });
        const append = (child) => {
          if (Array.isArray(child)) child.forEach(append);
          else if (child instanceof Node) node.appendChild(child);
          else if (child != null) node.appendChild(document.createTextNode(String(child)));
        };
        append(children); return node;
      }
      const view = { extend: value => value };
      let staged=[], uploadChunks=0, handlerWork, logRequests=0;
      const rpc = { declare: spec => async (...args) => {
        if (spec.object === 'obhod') assert(spec.nobatch === true, 'Obhod RPC calls must not share a batch');
        assert(new TextEncoder().encode(JSON.stringify(args)).length<60000,'Every RPC request stays below the device parser limit');
        if(spec.method==='upload') {
          if(args[0]==='begin') {staged=[];return {ok:true,upload:'test-upload'};}
          if(args[0]==='chunk') {assert(args[3]===staged.length,'Sequential chunks');staged.push(atob(args[2]));uploadChunks++;return {ok:true};}
          return {ok:true};
        }
        if (spec.method === 'status') {
          if (failStatus) throw new Error('No related RPC reply');
          return { dnsPoolReady, running, configured: true, version: 'sing-box version 1.12.22', coreFlavor, coreBusy, wireguard,
            obhodVersion:appVersion, updateBusy, updateAvailable, updateState, availableVersion:'0.1.7',jobBusy,jobState,
            routeName:'Сервер из работающего ядра',routeDelay:'83',routeOk:true,routeCheckedAt:Math.floor(Date.now()/1000) };
        }
        if(spec.method==='interfaces') return {devices:[{name:'br-lan',label:'lan · br-lan · 192.0.2.1',up:true},{name:'br-guest',label:'guest · br-guest',up:true}]};
        if(spec.method==='coreSizes') return {lite:{downloadBytes:11010846,installedBytes:31160083},full:{downloadBytes:15601977,installedBytes:44487113}};
        if(spec.method==='service') {serviceRequests.push(args[0]);if(args[0]==='dns-prepare')dnsPoolReady=true;else running=args[0]==='start';return {ok:true};}
        if(spec.method==='diagnose') {diagnosticRequests.push(true);jobBusy=true;jobState='running';return {ok:true};}
        if(spec.method==='diagnostics') return {checks:[{name:'HTTPS через подключение',ok:true,message:'83 мс'}],note:'Проверьте шлюз клиента.'};
        if(spec.method==='logs') {logRequests++;return {text:logBody};}
        if(spec.method==='clearLogs') {logBody='';return {ok:true};}
        if (spec.method === 'update') { updateRequests.push(args[0]); if(args[0]==='check') {updateAvailable=true; updateState='available';} else {updateBusy=true; updateState='running';} return {ok:true}; }
        if (spec.method === 'installCore') { coreRequests.push(args[0]); coreBusy = true; return { ok: true }; }
        if (spec.method === 'apply') { assert(args[0]==='' && args[2]==='test-upload','Apply references the staged profile'); applied = JSON.parse(new TextDecoder().decode(Uint8Array.from(staged.join(''),c=>c.charCodeAt(0)))); running = args[1]; saves++; return { ok: true }; }
        if (spec.method === 'stop') { running = false; return { ok: true }; }
        if (spec.method === 'subscription') return { ok: true, base64: btoa(btoa('socks5://192.0.2.10:1080#Duplicate\\nsocks5://192.0.2.55:1080#New')) };
        return { ok: true };
      } };
      const fs = { read: async () => JSON.stringify(${JSON.stringify(saved)}) };
      const ui = { createHandlerFn: (owner, fn) => (...args) => {
        const target=args[0]?.currentTarget;
        if(target) target.disabled=true;
        handlerWork=Promise.resolve(fn.apply(owner,args)).finally(()=>{if(target)target.disabled=false;});
        return handlerWork;
      }, showModal: () => {}, hideModal: () => {},
        addNotification: (_, node) => notifications.push(node.textContent) };
      const page = new Function('view','rpc','fs','ui','poll','core','E','L', ${JSON.stringify(source)})(view,rpc,fs,ui,{add:callback=>{poller=callback;}},core,E,pageL);
      document.getElementById('page').appendChild(page.render(await page.load()));
      await new Promise(resolve => { const link=page.root.querySelector('link'); if(link.sheet) resolve(); else link.onload=resolve; });
      window.obhodPage = page;
      assert(page.activeTab === 'overview' && page.panels.connections.hidden, 'Only overview initially visible');
      assert(!page.ipv6.checked && page.manageDns.checked, 'Native LuCI preserves false checkbox values');
      assert(!page.dnsMode && !page.root.textContent.includes('прежний режим'), 'FakeIP is the only DNS mode');
      assert(page.protocolHelp.textContent.includes('29,7') && page.protocolHelp.textContent.includes('10,5'), 'Package sizes come from router metadata');
      page.selectTab('rules');
      page.domainText.value=Array.from({length:1000},(_,i)=>'site'+i+'.example').join('\\n');
      page.markDirty();page.renderDomains();
      assert(page.domainRows.querySelectorAll('.ob-domain-row').length===50,'Large lists render only one page');
      page.domainNext.click();assert(page.domainPager.textContent.includes('2 из 20'),'Domain pagination');
      page.domainSearch.value='site999.';page.domainSearch.dispatchEvent(new Event('input',{bubbles:true}));
      assert(page.domainRows.querySelectorAll('.ob-domain-row').length===1,'Domain search');
      page.domainRows.querySelector('button').click();assert(!page.domainText.value.includes('site999.'),'Delete matching domain');
      page.domainEntry.value='https://Added.example/path';page.addDomain();assert(page.domainText.value.includes('added.example'),'Add normalized URL');
      page.domainView.value='text';page.domainView.dispatchEvent(new Event('change',{bubbles:true}));assert(!page.domainBulk.hidden,'Bulk editor available');
      page.tunnelRows[0].input.click();page.testUrl.value='https://test.example/check';page.presetInputs.discord.click();
      page.cancelButton.click();await handlerWork;
      assert(!page.dirty && page.domainText.value==='' && page.tunnelRows[0].input.checked && !page.presetInputs.discord.checked,'Cancel restores fields, group and presets');
      assert(saves===0 && serviceRequests.length===0,'Cancel does not save or toggle the service');
      page.domainView.value='list';page.domainView.dispatchEvent(new Event('change',{bubbles:true}));
      page.selectTab('network');
      assert(page.dnsServer.disabled, 'Custom DNS controls disabled initially');
      assert(page.dnsSettings.hidden, 'Disabled DNS settings do not occupy the page');
      page.dnsEnabled.click();page.dnsPreset.value='google';page.dnsPreset.dispatchEvent(new Event('change',{bubbles:true}));
      page.dnsProtocol.value='https';page.dnsProtocol.dispatchEvent(new Event('change',{bubbles:true}));page.dnsTtl.value='120';
      assert(!page.dnsSettings.hidden,'DNS settings can be expanded without losing their values');
      assert(page.dnsServer.value==='dns.google' && !page.dnsPathField.hidden, 'Desktop DNS provider and protocol settings');
      page.interfaceSelect.value='br-guest';page.interfaceSelect.dispatchEvent(new Event('change',{bubbles:true}));
      assert(page.interfaces.value==='br-lan, br-guest', 'Discovered interface added to selection');
      page.interfaceSelect.value='__manual__';page.interfaceSelect.dispatchEvent(new Event('change',{bubbles:true}));
      assert(document.activeElement===page.interfaces, 'Manual interface entry available');page.interfaces.value='br-lan';
      page.verboseLogs.click();
      page.domainText.value = 'draft.example';
      page.selectTab('connections'); page.selectTab('network'); page.selectTab('rules');
      assert(page.domainText.value === 'draft.example' && !page.panels.rules.hidden, 'Tab switches preserve drafts');
      assert(Object.values(page.panels).filter(panel=>!panel.hidden).length === 1, 'Only one tab panel visible');
      page.presetInputs.russia_inside.click();
      assert(page.presetInputs.youtube.disabled && !page.presetInputs.youtube.checked, 'Incompatible presets disabled immediately: '+JSON.stringify({region:page.presetInputs.russia_inside.checked,youtube:page.presetInputs.youtube.checked,disabled:page.presetInputs.youtube.disabled,connected:page.presetInputs.russia_inside.isConnected,html:page.panels.rules.innerHTML.slice(0,500)}));
      page.presetInputs.russia_outside.click();
      assert(!page.presetInputs.russia_inside.checked && !page.presetInputs.youtube.disabled, 'Region switch replaces prior region');
      page.serverSearch.value = '192.0.2.10:1080'; page.filterTunnels();
      assert(page.tunnelRows.filter(row=>!row.element.hidden).length === 1, 'Server search filters rows');
      page.serverSearch.value = ''; page.filterTunnels(); page.selectTab('connections');
      page.tabs.network.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));
      assert(page.activeTab === 'overview' && page.tabs.overview.tabIndex === 0, 'Keyboard navigation selects accessible tabs');
      page.selectTab('connections');
      assert(!page.root.textContent.includes('[object HTML'), 'Native LuCI receives flat child arrays');
      assert(page.all.indeterminate, 'Partial group selection');
      page.all.click();
      assert(page.tunnelRows.every(row => row.input.checked) && page.all.checked, 'Select all');
      page.all.click();
      assert(page.tunnelRows.every(row => !row.input.checked), 'Clear all');
      page.all.click(); page.tunnelRows[0].input.click();
      assert(page.all.indeterminate, 'Individual change updates master checkbox');
      page.all.click();
      page.importText.value = 'https://provider.example/subscription';
      await page.importConnections();
      assert(page.profile.tunnels.length === 51 && page.importText.value === '', 'Subscription import and duplicates');
      assert(page.all.indeterminate, 'New server starts outside existing group');
      page.all.click();
      page.domainText.value = 'https://Example.org/path';
      page.cidrText.value = '203.0.113.0/24';
      page.ipv6.checked = true;
      page.disableQuic.checked=true;page.downloadLists.checked=true;
      page.testUrl.value='https://test.example/check';page.interval.value='5m';page.listInterval.value='6h';
      await page.save(true);
      assert(applied && running && applied.profile.tunnels.length === 51, 'Save and start');
      assert(uploadChunks>3,'Large Unicode profile is transferred in small chunks');
      assert(applied.profile.routing.failoverTunnelIds.length === 51, 'Group saved');
      assert(applied.profile.routing.localLists[0].domains[0] === 'example.org', 'URL converted to domain');
      assert(applied.config.inbounds.find(i=>i.type==='tun').auto_redirect, 'Linux route generated');
      assert(applied.config.inbounds.find(i=>i.type==='tun').address.length === 2, 'IPv6 interception');
      assert(applied.profile.routing.dnsTtl===120 && applied.config.dns.servers.find(s=>s.tag==='proxy-dns').type==='https', 'DNS settings saved through shared generator');
      assert(applied.profile.routing.enableDiagnostics===true, 'Detailed log mode saved');
      assert(!('dnsMode' in applied.options) && applied.options.disableQuic && applied.options.downloadListsViaProxy,'Shared router options persisted');
      assert(applied.profile.routing.failoverInterval==='5m' && applied.profile.routing.updateInterval==='6h' && applied.profile.routing.testUrl==='https://test.example/check','Route check and list settings persisted');
      assert(page.saveButton.textContent==='Применить изменения' && page.applyButton.hidden && page.cancelButton.hidden,'Running service has a single apply action');
      page.serviceButton.click();await handlerWork;assert(!running && page.serviceButton.textContent==='Включить','Actual click stops service even when LuCI disables the button');
      page.serviceButton.click();await handlerWork;assert(running && serviceRequests.at(-1)==='start' && saves===1,'Separate start uses saved configuration');
      assert(page.liveRoute.textContent==='Сервер из работающего ядра' && page.liveDelay.textContent==='83 мс','Header displays actual selected route and delay');
      await page.runDiagnostics();assert(diagnosticRequests.length===1 && page.diagnosticButton.disabled,'Background diagnostics starts');
      jobBusy=false;jobState='done';page.updateStatus(await rpc.declare({method:'status'})());await page.refreshDiagnostics();
      assert(page.diagnosticRows.textContent.includes('83 мс') && logRequests===0,'Diagnostics does not fetch a collapsed journal');
      page.selectTab('diagnostics');await poller();assert(logRequests===0,'Polling skips a collapsed journal');
      var logOpened=new Promise(resolve=>page.logDetails.addEventListener('toggle',resolve,{once:true}));
      page.logDetails.querySelector('summary').click();await logOpened;await page.logsPromise;
      assert(page.logText.textContent.includes('WARN') && logRequests>0,'Opening the journal loads its contents');
      page.logDetails.open=false;var beforeLogRequests=logRequests;await poller();assert(logRequests===beforeLogRequests,'Closed journal stays idle');
      await page.refreshLogs();assert(logRequests===beforeLogRequests+1,'Explicit refresh loads the journal');
      page.tunnelRows.forEach((row, i) => { row.input.checked = i === 0; });
      await page.save(false);
      assert(saves === 1 && notifications.at(-1).includes('минимум два'), 'Incomplete group is not saved');
      assert(page.coreButton.disabled, 'Core switch disabled while routing runs');
      await page.installProtocols();
      assert(coreRequests.length === 0, 'Running service cannot switch core');
      await page.operation(rpc.declare({method:'stop'}));
      page.protocols.value = 'wireguard';
      await page.installProtocols();
      assert(coreRequests[0] === 'full' && page.coreButton.disabled, 'WireGuard installs full core asynchronously');
      page.selectTab('rules');page.domainText.value='during-install.example';page.markDirty();
      assert(!page.operationNotice.hidden && page.operationTitle.textContent.includes('протоколов') && !page.cancelButton.disabled,'Installation progress is visible on every tab and cancel remains available');
      page.cancelButton.click();await handlerWork;
      assert(page.domainText.value==='https://Example.org/path' && !page.dirty && coreBusy,'Cancel restores the draft without interrupting package installation');
      await page.save(false);
      assert(saves === 1 && notifications.at(-1).includes('окончания установки'), 'Save blocked during package operation');
      coreBusy = false; coreFlavor = 'sing-box'; wireguard = true;
      page.updateStatus(await rpc.declare({method:'status'})());
      page.protocols.value = 'proxy';
      await page.installProtocols();
      assert(coreRequests[1] === 'lite', 'Proxy selection installs tiny');
      coreBusy = false; page.updateStatus(await rpc.declare({method:'status'})()); page.markDirty();
      await page.updateObhod('check');
      assert(updateRequests[0]==='check' && !page.updateInstall.hidden && page.updateInstall.disabled, 'Update check shows release and protects unsaved drafts');
      assert(page.updateDetails.open && page.updateBadge.textContent==='Новая версия','An available update opens the panel and remains visible in its summary');
      page.updateDetails.open=false;page.updateControls();assert(!page.updateDetails.open,'Polling respects a manually collapsed update panel');
      await page.updateObhod('install');
      assert(updateRequests.length===1, 'Unsaved draft cannot start self-update');
      page.markDirty(true); await page.updateObhod('install');
      assert(updateRequests[1]==='install' && page.updateCheck.disabled, 'Self-update starts asynchronously');
      assert(page.updateDetails.open && page.updateBadge.textContent==='Обновляется','Installation is visible and opens the update panel');
      await page.save(false);
      assert(saves===1 && notifications.at(-1).includes('обновления Обхода'), 'Save blocked during app update');
      const beforeNotifications = notifications.length;
      failStatus=true; await poller(); failStatus=false;
      assert(notifications.length===beforeNotifications && page.statusDetail.textContent.includes('Переподключаемся'), 'Temporary RPC loss during reload does not flood notifications');
      updateBusy=false;updateState='done';appVersion='0.1.6';page.updateStatus(await rpc.declare({method:'status'})());
      assert(!page.updateReload.hidden, 'Completed update offers page reload');
      var completedState=page.lastStatus;page.updateDetails.open=false;page.updateStatus(Object.assign({},completedState,{updateState:'error',updateMessage:'Проверочная ошибка'}));
      assert(page.updateDetails.open && page.updateBadge.textContent==='Ошибка' && page.updateSummaryMessage.textContent==='Проверочная ошибка','Update errors stay visible in the summary');
      page.updateStatus(completedState);
      assert(document.documentElement.scrollWidth <= window.innerWidth, 'Long names stay inside page');
      const unreadable = new Function('view','rpc','fs','ui','poll','core','E','L', ${JSON.stringify(source)})(view,rpc,{read:async()=>{throw new Error('Denied');}},ui,{add:()=>{}},core,E,pageL);
      let rejected = false;
      try { await unreadable.load(); } catch (_) { rejected = true; }
      assert(rejected, 'Unreadable saved profile must not silently become empty');
      const initial = new Function('view','rpc','fs','ui','poll','core','E','L', ${JSON.stringify(source)})(view,rpc,fs,ui,{add:()=>{}},core,E,pageL);
      initial.render([{ configured: false }, '', JSON.stringify({version:1,presetIds:['discord','telegram']})]);
      assert(initial.profile.tunnels.length === 0 && initial.presetInputs.discord.checked && initial.presetInputs.telegram.checked, 'Installer defaults appear without bundled tunnels');
      assert(!initial.group.checked && !initial.ipv6.checked && !initial.presetInputs.youtube.checked, 'Fresh settings do not check every false boolean');
      assert(!initial.dnsMode,'New installations do not offer legacy DNS');
      page.tunnelRows.forEach((row,index)=>{row.input.checked=index<2;}); page.updateAll();
      page.updateStatus({running:false,version:'sing-box version 1.13.21',coreFlavor:'sing-box-tiny',wireguard:false});
      page.presetInputs.russia_inside.click();
      page.presetInputs.discord.checked=true; page.presetInputs.telegram.checked=true; page.presetInputs.google_ai.checked=true; page.updatePresets();
      page.dnsEnabled.checked=true;page.dnsPoolMode.value='parallel';
      page.dnsUpstreams.value='https://1.1.1.1/dns-query\\nhttps://1.0.0.1/dns-query';
      page.dnsBootstrapServers.value='1.1.1.1\\n8.8.8.8';page.updateDnsFields();page.markDirty();
      assert(!page.dnsPoolFields.hidden && page.dnsSingleFields.hidden,'DNS group editor replaces single-server fields');
      var beforePoolSaves=saves;
      await page.save(false);
      assert(saves===beforePoolSaves && notifications.at(-1).includes('Подготовить DNS-группы'),'Missing optional DNS component is explained before save');
      page.dnsPrepareButton.click();await handlerWork;
      assert(serviceRequests.at(-1)==='dns-prepare' && !running,'DNS preparation uses the asynchronous service operation without starting a tunnel');
      await page.save(false);
      assert(saves===beforePoolSaves+1 && applied.options.dnsPoolMode==='parallel','DNS group mode and servers saved');
      assert(applied.options.dnsUpstreams.length===2 && applied.config.dns.servers.find(s=>s.tag==='proxy-dns').server_port===1154,'DNS group has the proxy gateway');
      assert(page.dnsPrepareButton.hidden,'Prepared DNS component no longer offers installation');
      page.updateStatus({...page.lastStatus,dnsPoolNative:true,dnsPoolReady:true});
      assert(page.dnsPrepareButton.hidden && page.dnsPrepareHint.textContent.includes('внутри сетевого ядра'),'Native DNS needs no optional component');
      page.dnsUpstreams.value='invalid endpoint';page.markDirty();await page.save(false);
      assert(saves===beforePoolSaves+1,'Invalid DNS group does not overwrite saved settings');
      page.cancelChanges();assert(page.dnsUpstreams.value.includes('1.0.0.1') && !page.dirty,'Cancel restores DNS group editor');
      return { nativeLoader, nativeDOM: !!nativeDOM, dnsSettings: true, dnsPool: true, interfaceDiscovery: true, serviceToggle: true, diagnostics: true, logs: true, routeLatency: true, selfUpdate: true, standaloneRPC: true, pollingRecovery: true, tabs: true, checkboxDefaults: true, presetCompatibility: true, serverSearch: true, selectAll: true, subscriptionImport: true, duplicates: true, routerConfig: true, validation: true, longNames: true, profileReadFailure: true, installerDefaults: true, protocolInstallation: true };
    })()`);
    console.log(`OPENWRT_UI_TEST ${JSON.stringify(result)}`);
    const screenshots = path.join(root, '.tmp', 'openwrt-ui-preview');
    const paint = async () => { await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await new Promise(resolve=>setTimeout(resolve,150)); };
    fs.mkdirSync(screenshots, {recursive:true});
    window.setContentSize(1180, 1000);
    for (const tab of ['overview','connections','rules','protocols','network','diagnostics']) {
      await window.webContents.executeJavaScript(`obhodPage.selectTab(${JSON.stringify(tab)}); scrollTo(0,0);`);
      await paint();
      const clip = tab === 'overview' ? {x:0,y:0,width:1180,height:Math.min(1000,Math.ceil(await window.webContents.executeJavaScript('obhodPage.root.getBoundingClientRect().bottom+28')))} : undefined;
      fs.writeFileSync(path.join(screenshots, 'dark-'+tab+'.png'), (await window.webContents.capturePage(clip)).toPNG());
    }
    for (const viewport of [320,390]) {
      window.setContentSize(viewport, 900);
      for (const tab of ['overview','connections','rules','protocols','network','diagnostics']) {
        const width = await window.webContents.executeJavaScript(`obhodPage.selectTab(${JSON.stringify(tab)}); scrollTo(0,0); document.documentElement.scrollWidth <= innerWidth;`);
        if (!width) throw new Error('Mobile overflow '+viewport+': '+tab);
      }
    }
    await window.webContents.executeJavaScript("obhodPage.selectTab('connections'); scrollTo(0,0);");
    await paint();
    fs.writeFileSync(path.join(screenshots, 'mobile-connections.png'), (await window.webContents.capturePage()).toPNG());
    window.setContentSize(1180, 1000);
    await window.webContents.executeJavaScript("document.body.style.background='#f5f7fa'; document.documentElement.style.background='#f5f7fa'; obhodPage.root.classList.remove('ob-dark'); obhodPage.selectTab('overview'); scrollTo(0,0);");
    await paint();
    fs.writeFileSync(path.join(screenshots, 'light-overview.png'), (await window.webContents.capturePage()).toPNG());
    clearTimeout(timeout); app.exit(0);
  } catch (error) { clearTimeout(timeout); console.error(error.stack || error); app.exit(1); }
});
