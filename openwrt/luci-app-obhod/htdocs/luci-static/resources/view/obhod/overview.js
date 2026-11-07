'use strict';
'require view';
'require rpc';
'require fs';
'require ui';
'require uci';
'require poll';
'require obhod.core as core';

var status = rpc.declare({ object: 'obhod', method: 'status', nobatch: true });
var apply = rpc.declare({ object: 'obhod', method: 'apply', params: ['settings', 'start', 'upload'], nobatch: true });
var upload = rpc.declare({ object: 'obhod', method: 'upload', params: ['action', 'upload', 'data', 'index'], nobatch: true });
var stop = rpc.declare({ object: 'obhod', method: 'stop', nobatch: true });
var subscription = rpc.declare({ object: 'obhod', method: 'subscription', params: ['url'], nobatch: true });
var installCore = rpc.declare({ object: 'obhod', method: 'installCore', params: ['profile', 'version'], nobatch: true });
var removeCore = rpc.declare({ object: 'obhod', method: 'removeCore', nobatch: true });
var coreVersions = rpc.declare({ object: 'obhod', method: 'coreVersions', nobatch: true });
var coreSizes = rpc.declare({ object: 'obhod', method: 'coreSizes', nobatch: true });
var update = rpc.declare({ object: 'obhod', method: 'update', params: ['action'], nobatch: true });
var interfaces = rpc.declare({ object: 'obhod', method: 'interfaces', nobatch: true });
var service = rpc.declare({ object: 'obhod', method: 'service', params: ['action'], nobatch: true });
var logs = rpc.declare({ object: 'obhod', method: 'logs', nobatch: true });
var clearLogs = rpc.declare({ object: 'obhod', method: 'clearLogs', nobatch: true });
var diagnostics = rpc.declare({ object: 'obhod', method: 'diagnostics', nobatch: true });
var diagnose = rpc.declare({ object: 'obhod', method: 'diagnose', nobatch: true });
var DNS_PRESETS = {
  cloudflare: { title: 'Cloudflare', plain: '1.1.1.1', tls: 'one.one.one.one', https: ['cloudflare-dns.com', '/dns-query'], bootstrap: '1.1.1.1' },
  google: { title: 'Google', plain: '8.8.8.8', tls: 'dns.google', https: ['dns.google', '/dns-query'], bootstrap: '8.8.8.8' },
  quad9: { title: 'Quad9', plain: '9.9.9.9', tls: 'dns.quad9.net', https: ['dns.quad9.net', '/dns-query'], bootstrap: '9.9.9.9' },
  'quad9-unfiltered': { title: 'Quad9 без фильтрации', plain: '9.9.9.10', tls: 'dns10.quad9.net', https: ['dns10.quad9.net', '/dns-query'], bootstrap: '9.9.9.10' },
  adguard: { title: 'AdGuard', plain: '94.140.14.14', tls: 'dns.adguard-dns.com', https: ['dns.adguard-dns.com', '/dns-query'], bootstrap: '94.140.14.14' },
  controld: { title: 'Control D', plain: '76.76.2.0', tls: 'p0.freedns.controld.com', https: ['freedns.controld.com', '/p0'], bootstrap: '76.76.2.0' },
  'controld-ads': { title: 'Control D · блокировка рекламы', plain: '76.76.2.2', tls: 'p2.freedns.controld.com', https: ['freedns.controld.com', '/p2'], bootstrap: '76.76.2.2' }
};

function checked(node) { return node.checked === true; }
var fieldIndex = 0;
function checkbox(value, change) {
  var input = E('input', { type: 'checkbox', change: change || function() {} });
  // LuCI sets HTML attributes verbatim: checked="false" still means checked.
  input.checked = value === true;
  return input;
}
function field(title, input, help) {
  if (!input.id) input.id = 'obhod-field-' + (++fieldIndex);
  return E('div', { 'class': 'ob-field' }, [E('label', { 'class': 'ob-label', 'for': input.id }, title),
    input, help ? E('p', { 'class': 'ob-help' }, help) : '']);
}
function card(title, description, content, badge) {
  return E('section', { 'class': 'ob-card' }, [E('div', { 'class': 'ob-card-heading' }, [
    E('h3', {}, title), badge || '']), description ? E('p', { 'class': 'ob-section-description' }, description) : ''].concat(Array.isArray(content) ? content : [content]));
}
function switchField(title, input, help) {
  return E('label', { 'class': 'ob-switch-row' }, [E('span', {}, [E('strong', {}, title),
    help ? E('span', { 'class': 'ob-help' }, help) : '']), E('span', {'class':'ob-toggle'}, [input,E('span',{'class':'ob-track','aria-hidden':'true'})])]);
}
function routeIcon() {
  var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 32 32');svg.setAttribute('fill','none');svg.setAttribute('aria-hidden','true');
  [['circle',{cx:6.5,cy:24.5,r:2.5,fill:'currentColor'}],
    ['path',{d:'M9 24.5H14.5C20.6 24.5 23 21.4 23 16V8',stroke:'currentColor','stroke-width':2.8,'stroke-linecap':'round'}],
    ['path',{d:'M17.5 13.5L23 8L28.5 13.5',stroke:'currentColor','stroke-width':2.8,'stroke-linecap':'round','stroke-linejoin':'round'}]
  ].forEach(function(spec){var node=document.createElementNS(svg.namespaceURI,spec[0]);Object.keys(spec[1]).forEach(function(key){node.setAttribute(key,spec[1][key]);});svg.appendChild(node);});
  return svg;
}
function lines(value) { return String(value || '').split(/[\r\n,\s]+/).filter(Boolean); }
function domains(value) {
  return lines(value).map(function(entry) {
    var url = new URL(/^[a-z]+:\/\//i.test(entry) ? entry : 'https://' + entry);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) {
      throw new Error('Укажите домен или URL HTTP(S). IP-адреса добавляйте в поле подсетей.');
    }
    return url.hostname.replace(/\.$/, '');
  });
}

return view.extend({
  load: function() {
    return status().then(function(state) {
      return fs.read('/etc/obhod/settings.json').catch(function(error) {
        if (state.configured) throw new Error('Не удалось прочитать сохранённые подключения. Проверьте доступ к настройкам; профиль не изменён.');
        return '';
      }).then(function(text) {
        return Promise.all([fs.read('/etc/obhod/defaults.json').catch(function() { return ''; }), interfaces().catch(function() { return {devices:[]}; }), coreSizes().catch(function(){return {};}), coreVersions().catch(function(){return {unavailable:true};}),
          uci.load('system').then(function(){return {zonename:uci.get('system','@system[0]','zonename') || 'UTC'};}).catch(function(){return null;})])
          .then(function(extra) { return [state, text, extra[0], extra[1], extra[2], extra[3],extra[4]]; });
      });
    });
  },

  render: function(data) {
    var self = this, saved;
    this.configureSystemTime(data[6]);
    this.loadedVersion = data[0].obhodVersion;
    this.coreSizes = data[4] || {};
    this.coreCatalog = data[5] || {unavailable:true};
    try { saved = data[1] ? JSON.parse(data[1]) : {}; }
    catch (_) { throw new Error('Не удалось прочитать профиль Обхода. Сохранённые настройки не изменены.'); }
    this.profile = saved.profile || core.defaults();
    if (!saved.profile && data[2]) {
      try {
        var defaults = JSON.parse(data[2]);
        if (defaults.version === 1 && Array.isArray(defaults.presetIds)) {
          this.profile.routing.presetIds = defaults.presetIds;
          this.profile = core.validate(this.profile);
        }
      } catch (_) { throw new Error('Не удалось прочитать выбранные установщиком списки.'); }
    }
    this.options = Object.assign({ interfaces: ['br-lan'], manageDns: true, ipv6: false, disableQuic: false, downloadListsViaProxy: false }, saved.options || {});
    delete this.options.dnsMode;
    this.state = E('span', { 'class': 'ob-status' });
    this.statusDetail = E('p', { 'class': 'ob-help ob-status-detail', 'aria-live': 'polite' });
    this.liveRoute = E('span', { 'class': 'ob-live-route-name' });
    this.liveDelay = E('span', { 'class': 'ob-live-delay' });
    this.routeDetail = E('div', { 'class': 'ob-live-route' }, [this.liveRoute, this.liveDelay]);
    this.overviewLiveRoute = E('strong', { 'class': 'ob-overview-route-name' });
    this.overviewLiveDelay = E('span', { 'class': 'ob-live-delay' });
    this.coreState = E('p', { 'class': 'ob-core-state', 'aria-live': 'polite' });
    this.protocols = E('select', { change: function() { self.updateCoreVersions(); self.updateProtocolHelp(); } }, [E('option', { value: 'proxy' }, 'Прокси · облегчённое ядро'),
      E('option', { value: 'wireguard' }, 'WireGuard · полное ядро'), E('option', { value: 'all' }, 'Все протоколы · полное ядро')]);
    this.protocols.value = data[0].coreFlavor === 'sing-box' ? 'all' : 'proxy';
    this.protocolHelp = E('p', { 'class': 'ob-note' });
    this.coreVersion = E('select', { change: function() { self.updateProtocolHelp(); } });
    this.coreVersionHelp = E('p', { 'class': 'ob-help' });
    this.coreHint = E('p', { 'class': 'ob-help' });
    this.coreButton = E('button', { type: 'button', 'class': 'cbi-button ob-button ob-primary', click: ui.createHandlerFn(this, this.installProtocols) }, 'Установить выбранное ядро');
    this.removeCoreButton = E('button', { type:'button', 'class':'cbi-button ob-button ob-danger', click:ui.createHandlerFn(this,this.confirmRemoveCore) }, 'Удалить ядро');
    this.importMode = E('select', {}, [E('option', { value: 'subscription' }, 'Подписка V2Ray'),
      E('option', { value: 'connection' }, 'Одна ссылка подключения'), E('option', { value: 'wireguard' }, 'WireGuard .conf')]);
    this.importText = E('textarea', { rows: 4, placeholder: 'Вставьте URL подписки, ссылки или Base64…', autocomplete: 'off', spellcheck: 'false' });
    this.active = E('select', { change: function() { self.updateSummary(); } });
    this.group = checkbox(this.profile.routing.failoverEnabled, function() { self.updateAll(); });
    this.all = checkbox(false, function() {
      self.tunnelRows.forEach(function(row) { row.input.checked = self.all.checked; }); self.updateAll();
    });
    this.count = E('span', { 'class': 'ob-counter' });
    this.list = E('div', { 'class': 'ob-server-list' });
    this.serverSearch = E('input', { type: 'search', placeholder: 'Найти сервер…', 'aria-label': 'Поиск подключений', input: function() { self.filterTunnels(); } });
    this.serverEmpty = E('p', { 'class': 'ob-empty' });
    this.tunnelTotal = E('span', { 'class': 'ob-counter' });
    this.serverFilter='all';
    this.serverFilterAll=E('button',{type:'button','class':'ob-chip','aria-pressed':'true',click:function(){self.setServerFilter('all');}},'Все');
    this.serverFilterSelected=E('button',{type:'button','class':'ob-chip','aria-pressed':'false',click:function(){self.setServerFilter('selected');}},'Выбранные');
    this.serverVisible=E('span',{'class':'ob-help'});
    this.presetInputs = {};
    this.interfaces = E('input', { type: 'text', value: this.options.interfaces.join(', ') });
    this.interfaceSelect = E('select', { change: function() {
      var chosen = self.interfaceSelect.value;
      if (chosen === '__manual__') self.interfaces.focus();
      else if (chosen) { self.interfaces.value = Array.from(new Set(lines(self.interfaces.value).concat(chosen))).join(', '); self.markDirty(); }
      self.interfaceSelect.value = '';
    } }, [E('option', {value:''}, 'Добавить существующий интерфейс…')].concat(((data[3] || {}).devices || []).map(function(device) {
      return E('option', {value:device.name}, device.label + (device.up ? '' : ' · неактивен'));
    })).concat([E('option',{value:'__manual__'},'Ввести вручную…')]));
    this.manageDns = checkbox(this.options.manageDns);
    this.ipv6 = checkbox(this.options.ipv6);
    this.disableQuic = checkbox(this.options.disableQuic);
    this.downloadLists = checkbox(this.options.downloadListsViaProxy);
    this.dnsHint = E('p',{'class':'ob-note'});
    this.dnsHeading = E('span');this.dnsSwitchCaption=E('span');this.dnsSwitchHelp=E('span');
    var routing = this.profile.routing;
    this.dnsEnabled = checkbox(routing.dnsResolverEnabled, function() { self.updateDnsFields(); });
    this.dnsProtocol = E('select', {change:function() { self.applyDnsPreset(); }}, [['tls','DNS over TLS'],['https','DNS over HTTPS'],['udp','UDP'],['tcp','TCP']].map(function(item) { return E('option',{value:item[0]},item[1]); }));
    this.dnsProtocol.value = routing.dnsProtocol || 'tls';
    this.dnsPreset = E('select', {change:function() { self.applyDnsPreset(); }}, Object.keys(DNS_PRESETS).map(function(id) { return E('option',{value:id},DNS_PRESETS[id].title); }).concat([E('option',{value:'custom'},'Свой сервер')]));
    this.dnsServer = E('input',{type:'text',value:routing.dnsServer || 'one.one.one.one',input:function(){self.dnsPreset.value='custom';}});
    this.dnsBootstrap = E('input',{type:'text',value:routing.dnsBootstrap || '1.1.1.1',input:function(){self.dnsPreset.value='custom';}});
    this.dnsPath = E('input',{type:'text',value:routing.dnsPath || '/dns-query',input:function(){self.dnsPreset.value='custom';}});
    this.dnsTtl = E('input',{type:'number',min:10,max:86400,value:routing.dnsTtl || 60});
    this.dnsPreset.value = 'custom';
    Object.keys(DNS_PRESETS).forEach(function(id) { var preset=DNS_PRESETS[id], protocol=self.dnsProtocol.value;
      if (self.dnsServer.value === (protocol==='https'?preset.https[0]:protocol==='tls'?preset.tls:preset.plain) && self.dnsBootstrap.value===preset.bootstrap) self.dnsPreset.value=id;
    });
    this.dnsPathField = field('Путь DNS over HTTPS', this.dnsPath, 'Обычно /dns-query.');
    this.dnsPoolMode = E('select',{change:function(){self.updateDnsFields();}},[
      E('option',{value:'single'},'Один сервер'), E('option',{value:'fallback'},'Основной и резервные · рекомендуется'),
      E('option',{value:'parallel'},'Параллельный опрос · первый ответ'),
      E('option',{value:'balanced'},'Автоматический выбор · меньше запросов')]);
    this.dnsPoolMode.value = this.options.dnsPoolMode || 'single';
    var dnsValue = routing.dnsServer || 'one.one.one.one';
    var dnsHost = dnsValue.includes(':') ? '['+dnsValue+']' : dnsValue;
    var currentDns = (routing.dnsProtocol || 'tls')+'://'+dnsHost+((routing.dnsProtocol==='https')?(routing.dnsPath||'/dns-query'):'');
    this.dnsUpstreams = E('textarea',{rows:4,spellcheck:'false',autocomplete:'off',placeholder:'https://1.1.1.1/dns-query\nhttps://1.0.0.1/dns-query'});
    this.dnsUpstreams.value = Array.isArray(this.options.dnsUpstreams) ? this.options.dnsUpstreams.join('\n') : this.options.dnsUpstreams || currentDns;
    this.dnsBootstrapServers = E('textarea',{rows:2,spellcheck:'false',placeholder:'1.1.1.1\n8.8.8.8'});
    this.dnsBootstrapServers.value = Array.isArray(this.options.dnsBootstrapServers) ? this.options.dnsBootstrapServers.join('\n') : this.options.dnsBootstrapServers || routing.dnsBootstrap || '1.1.1.1';
    this.dnsPrepareButton = E('button',{type:'button','class':'cbi-button ob-button',click:ui.createHandlerFn(this,function(){
      if(self.lastStatus.coreBusy || self.lastStatus.updateBusy || self.lastStatus.jobBusy)return Promise.resolve();
      return self.operation(function(){return service('dns-prepare');});
    })},'Подготовить DNS');
    this.dnsPrepareHint = E('p',{'class':'ob-help'});
    this.verboseLogs = checkbox(routing.enableDiagnostics);
    this.diagnosticRows = E('div',{'class':'ob-diagnostic-rows'});
    this.diagnosticSummary=E('span',{'class':'ob-counter','aria-live':'polite'},'Нет результатов');
    this.healthBadge=E('span',{'class':'ob-counter'},'Нет результатов');
    this.healthRows=E('div',{'class':'ob-health-list'});
    this.healthNote=E('span',{'class':'ob-help'},'Запустите проверку в диагностике.');
    this.diagnosticDetails=E('div',{'class':'ob-diagnostic-details'});
    this.diagnosticMessage = E('p',{'class':'ob-help','aria-live':'polite'},'Проверка использует сохранённые настройки.');
    this.diagnosticButton = E('button',{type:'button','class':'cbi-button ob-button ob-primary',click:ui.createHandlerFn(this,function(){return self.runDiagnostics();})},'Проверить работоспособность');
    this.logText = E('pre',{'class':'ob-log','aria-label':'Журнал Обхода'},'Журнал пока пуст.');
    this.interval = E('select', {}, ['10s','15s', '30s', '1m', '3m', '5m', '10m', '15m'].map(function(value) { return E('option', { value: value }, value); }));
    this.interval.value = this.profile.routing.failoverInterval || '30s';
    this.tolerance = E('select', {}, [80, 50, 20].map(function(value) { return E('option', { value: String(value) }, value + ' мс'); }));
    this.tolerance.value = String(this.profile.routing.failoverTolerance || 80);
    this.testUrl = E('input',{type:'url',value:this.profile.routing.testUrl,placeholder:'https://www.gstatic.com/generate_204'});
    this.listInterval = E('select',{},['1h','6h','12h','24h'].map(function(value){return E('option',{value:value},value);}));
    this.listInterval.value = this.profile.routing.updateInterval;
    var local = this.profile.routing.localLists.filter(function(list) { return list.enabled; });
    this.domainText = E('textarea', { rows: 5 }, local.map(function(list) { return list.domains.join('\n'); }).join('\n'));
    this.cidrText = E('textarea', { rows: 3 }, local.map(function(list) { return list.cidrs.join('\n'); }).join('\n'));
    this.remoteText = E('textarea', { rows: 3 }, this.profile.routing.remoteLists.map(function(list) { return list.url; }).join('\n'));
    var presets = E('div', { 'class': 'ob-preset-groups' });
    this.presetGroupCounters = {};
    [ ['Регион', ['russia_inside', 'russia_outside', 'ukraine_inside']],
      ['Сервисы', ['youtube', 'discord', 'meta', 'twitter', 'telegram', 'google_ai', 'google_meet', 'google_play', 'tiktok', 'hdrezka', 'roblox', 'hodca']],
      ['Категории', ['geoblock', 'block', 'anime', 'news', 'porn']],
      ['Сети', ['cloudflare', 'hetzner', 'ovh', 'digitalocean', 'cloudfront']] ].forEach(function(group) {
      var choices = E('div', { 'class': 'ob-preset-grid' });
      group[1].forEach(function(id) {
        var input = checkbox(self.profile.routing.presetIds.includes(id), function() { self.updatePresets(id); });
        self.presetInputs[id] = input;
        choices.appendChild(E('label', { 'class': 'ob-preset' }, [input, E('span', {}, core.presets[id])]));
      });
      var counter = E('span', { 'class': 'ob-group-count' });
      self.presetGroupCounters[group[0]] = { ids: group[1], node: counter };
      var section = E('details', { 'class': 'ob-preset-group' }, [E('summary', {}, [
        E('span', {}, group[0]), counter
      ]), choices]);
      presets.appendChild(section);
    });
    this.presetCount = E('span', { 'class': 'ob-counter' });
    this.autoFields = E('div', { 'class': 'ob-grid ob-auto-fields' }, [field('Частота проверки', this.interval), field('Стабильность выбора', this.tolerance)]);
    this.summaryServers = E('strong'); this.summaryRules = E('strong'); this.summaryCore = E('strong');
    this.routeSummary = E('p', { 'class': 'ob-route-name' });
    this.routeMode=E('span',{'class':'ob-counter ob-badge-green'});
    this.routeChecked=E('span',{'class':'ob-help'});
    this.installedCore=E('span');this.installedFlavor=E('span');this.installedState=E('span');
    this.coreBadge=E('span',{'class':'ob-counter'});
    this.downloadSize=E('span');this.installedSize=E('span');
    this.setup = E('div', { 'class': 'ob-setup' });
    this.dirtyState = E('span', { 'class': 'ob-help', 'aria-live': 'polite' }, 'Все изменения сохранены');
    this.dirty = false;
    this.updateVersion = E('strong');
    this.updateMessage = E('p', { 'class': 'ob-help', 'aria-live': 'polite' });
    this.updateBadge = E('span', { 'class': 'ob-update-badge' });
    this.updateSummaryMessage = E('span', { 'class': 'ob-update-summary-message', 'aria-live': 'polite' });
    this.updateCheck = E('button', { type: 'button', 'class': 'cbi-button ob-button', click: ui.createHandlerFn(this, function() { return self.updateObhod('check'); }) }, 'Проверить обновления');
    this.updateInstall = E('button', { type: 'button', 'class': 'cbi-button ob-button ob-primary', click: ui.createHandlerFn(this, function() { return self.updateObhod('install'); }) }, 'Обновить Обход');
    this.updateReload = E('button', { type: 'button', 'class': 'cbi-button ob-button ob-primary', click: function() { window.location.reload(); } }, 'Открыть новую версию');
    this.tabs = {}; this.panels = {};
    var nav = E('div', { 'class': 'ob-tabs', role: 'tablist', 'aria-label': 'Разделы Обхода' });
    var panels = E('div', { 'class': 'ob-panels' });
    var definitions = [ ['overview', 'Обзор', 'Состояние маршрутизации и быстрые действия.'], ['connections', 'Подключения', 'Маршруты, серверы и автоматическое переключение.'], ['rules', 'Правила', 'Собственные домены, готовые и внешние списки.'], ['protocols', 'Протоколы', 'Выбор и управление совместимым ядром.'], ['network', 'Сеть', 'Интерфейсы LAN, DNS и дополнительные параметры.'], ['diagnostics', 'Диагностика', 'Проверки работоспособности и журнал службы.'] ];
    this.tabDefinitions=definitions;
    definitions.forEach(function(entry, index) {
      self.tabs[entry[0]] = E('button', { type: 'button', 'class':'ob-tab', role: 'tab', id: 'obhod-tab-' + entry[0], 'aria-controls': 'obhod-panel-' + entry[0],
        click: function() { self.selectTab(entry[0]); }, keydown: function(event) {
          var next = index;
          if (event.key === 'ArrowRight') next = (index + 1) % definitions.length;
          else if (event.key === 'ArrowLeft') next = (index + definitions.length - 1) % definitions.length;
          else if (event.key === 'Home') next = 0;
          else if (event.key === 'End') next = definitions.length - 1;
          else return;
          event.preventDefault(); self.selectTab(definitions[next][0]); self.tabs[definitions[next][0]].focus();
        } }, entry[1]);
      nav.appendChild(self.tabs[entry[0]]);
      self.panels[entry[0]] = E('div', { 'class': 'ob-panel', role: 'tabpanel', id: 'obhod-panel-' + entry[0], 'aria-labelledby': 'obhod-tab-' + entry[0] });
      panels.appendChild(self.panels[entry[0]]);
    });
    function jump(tab, title) { return E('button', { type: 'button', 'class': 'cbi-button ob-button ob-button-sm', click: function() { self.selectTab(tab); } }, title + ' →'); }
    function kv(title,value){return E('div',{'class':'ob-kv'},[E('span',{},title),value]);}
    this.panels.overview.appendChild(E('div',{'class':'ob-columns'},[
      card('Активный маршрут','',[
        E('div',{'class':'ob-route-line'},[E('span',{'class':'ob-route-icon'},routeIcon()),
          E('div',{'class':'ob-route-info'},[this.overviewLiveRoute,this.routeSummary]),this.overviewLiveDelay]),
        E('div',{'class':'ob-inline-footer'},[this.routeChecked,jump('connections','Подключения')])],this.routeMode),
      card('Состояние системы','',[this.healthRows,
        E('div',{'class':'ob-inline-footer'},[this.healthNote,jump('diagnostics','Диагностика')])],this.healthBadge)]));
    var stats = E('div', { 'class': 'ob-stats' });
    [['connections', 'Серверы в группе', this.summaryServers], ['rules', 'Активные списки', this.summaryRules], ['protocols', 'Ядро sing-box', this.summaryCore]].forEach(function(item) {
      stats.appendChild(E('button', { type: 'button', 'class': 'ob-stat', click: function() { self.selectTab(item[0]); } }, [E('span', { 'class': 'ob-help' }, item[1]), item[2], E('span', { 'class': 'ob-stat-arrow', 'aria-hidden': 'true' }, '↗')]));
    });
    this.panels.overview.appendChild(stats); this.panels.overview.appendChild(this.setup);
    this.updateDetails = E('details', { 'class': 'ob-card ob-update-details' }, [
      E('summary', {}, [E('span', { 'class': 'ob-update-summary-main' }, [
        E('strong', {}, 'Обновления'), this.updateVersion, this.updateSummaryMessage
      ]), E('span', { 'class': 'ob-update-summary-meta' }, [this.updateBadge])]),
      E('div', { 'class': 'ob-update-body' }, [this.updateMessage,
        E('div', { 'class': 'ob-inline-actions' }, [this.updateCheck, this.updateInstall, this.updateReload]),
        E('p', { 'class': 'ob-help' }, 'Подключения и списки сохранятся. Во время обновления служба кратковременно перезапустится, если была включена.')])
    ]);
    this.panels.overview.appendChild(this.updateDetails);
    this.importDetails = E('details', { 'class': 'ob-import' }, [E('summary', {}, 'Добавить подключения'), card('Импорт', 'Импортируйте подписку или настройки своего сервера.', [
      field('Способ импорта', this.importMode), field('Подписка или настройки', this.importText),
      E('div', { 'class': 'ob-inline-actions' }, [E('button', { type: 'button', 'class': 'cbi-button ob-button ob-primary', click: ui.createHandlerFn(this, this.importConnections) }, 'Добавить подключения'), E('span', { 'class': 'ob-help' }, 'URL подписки не сохраняется.')]) ])]);
    this.importDetails.open = this.profile.tunnels.length === 0;
    this.importDetails.appendChild(E('p',{'class':'ob-import-hint ob-help'},'Подписка: HTTP(S)-URL, список vless://, ss:// и других ссылок или Base64. WireGuard: полный текст .conf с [Interface] и [Peer].'));
    this.importToggle=E('button',{type:'button','class':'cbi-button ob-button ob-primary','aria-expanded':String(this.importDetails.open),'aria-controls':'obhod-import',click:function(){self.importDetails.open=!self.importDetails.open;}},'+ Добавить подключение');
    this.importDetails.id='obhod-import';
    this.importDetails.addEventListener('toggle',function(){self.importToggle.setAttribute('aria-expanded',String(self.importDetails.open));});
    this.panels.connections.appendChild(E('div',{'class':'ob-section-toolbar'},[
      E('div',{},[E('h3',{},'Маршруты и серверы'),E('p',{'class':'ob-help'},'Управляйте группой автовыбора и основным подключением.')]),this.importToggle]));
    this.panels.connections.appendChild(this.importDetails);
    var connectionGrid = E('div', { 'class': 'ob-connections-grid' });
    connectionGrid.appendChild(card('Выбор маршрута', '', [field('Основное подключение', this.active),
      switchField('Автоматический выбор', this.group, 'Все выбранные туннели используют общие правила. Обход переключится на рабочее соединение.'), this.autoFields,
      field('URL проверки соединений',this.testUrl,'Обычно адрес с ответом HTTP 204. Не все сайты доступны с каждого VPN-адреса.') ]));
    connectionGrid.appendChild(card('Подключения', 'Для автоматического выбора отметьте минимум два подключения.', [
      E('div', { 'class': 'ob-list-toolbar' }, [E('div',{'class':'ob-inline-actions'},[this.serverFilterAll,this.serverFilterSelected]),E('label', { 'class': 'ob-check-label' }, [this.all, E('span', {}, 'Выбрать все')])]),
      E('div',{'class':'ob-search'},this.serverSearch), this.list, this.serverEmpty,
      E('div',{'class':'ob-inline-footer'},[this.serverVisible,E('span',{'class':'ob-help'},'Изменения применяются после сохранения')])],this.count));
    this.panels.connections.appendChild(connectionGrid);
    var domainEditor=this.buildDomainEditor();
    this.domainCard=card('Свои сайты и подсети', 'Ваши сайты и подсети, направляемые через туннель. Общие правила для всех подключений.', [domainEditor],this.domainCount);
    this.domainCard.classList.add('ob-domain-card');this.panels.rules.appendChild(this.domainCard);
    this.panels.rules.appendChild(card('Готовые списки', 'Выберите сервисы и категории для маршрутизации.', [presets,
      E('p', { 'class': 'ob-note ob-note-compact' }, 'Можно выбрать один регион. Несовместимые списки отключаются автоматически.'),
      E('div',{'class':'ob-grid ob-list-settings'},[field('Обновлять списки',this.listInterval),switchField('Скачивать списки через туннель',this.downloadLists,'Использовать выбранное соединение для загрузки внешних наборов.')]) ],this.presetCount));
    this.remoteDetails=E('details',{'class':'ob-accordion'},[E('summary',{},['Внешние списки',E('span',{'class':'ob-help'},'Дополнительные правила .srs / .json')]),
      E('div',{'class':'ob-accordion-body'},[field('Ссылки на списки', this.remoteText, 'HTTPS-ссылки на .srs или .json, по одной в строке.'),
      E('details',{'class':'ob-details'},[E('summary',{},'Примеры форматов'),E('pre',{'class':'ob-code'},'Домены: example.org\nПодсети: 203.0.113.0/24\nВнешний список: https://example.org/rules.srs\nSource JSON: {"version":3,"rules":[{"domain_suffix":["example.org"]}]}')])])]);
    this.panels.rules.appendChild(this.remoteDetails);
    var protocolGrid=E('div',{'class':'ob-columns'});
    protocolGrid.appendChild(card('Ядро протоколов', '', [
      kv('Ядро',this.installedCore),kv('Набор',this.installedFlavor),kv('Состояние',this.installedState),
      field('Набор протоколов', this.protocols), field('Версия ядра',this.coreVersion),this.coreVersionHelp,
      E('div',{'class':'ob-inline-actions'},[this.coreButton]), this.coreHint],this.coreBadge));
    protocolGrid.appendChild(card('Информация об установке','',[
      this.coreState,kv('Скачивание',this.downloadSize),kv('После распаковки',this.installedSize),
      E('details', { 'class': 'ob-details' }, [E('summary', {}, 'Технические подробности и совместимость'),this.protocolHelp, E('p', { 'class': 'ob-help' }, 'Прокси используют sing-box-tiny, WireGuard — полный sing-box. На поддерживаемых MIPS/ARM64 автоматически устанавливается совместимое ядро Обхода с исправлением таблиц маршрутизации и встроенными DNS-группами. Протоколы входят в общее ядро: выбор одного не уменьшает его дальше. Перед установкой проверяется место; малый объём ОЗУ вызывает предупреждение.')]),
      E('div',{'class':'ob-inline-footer'},[E('span',{'class':'ob-help'},'Опасное действие'),this.removeCoreButton])]));
    this.panels.protocols.appendChild(protocolGrid);
    var networkGrid=E('div',{'class':'ob-columns ob-network-grid'});
    networkGrid.appendChild(card('Локальная сеть', 'Трафик каких интерфейсов нужно обрабатывать. WAN обычно добавлять не нужно.', [field('Добавить интерфейс',this.interfaceSelect),field('Выбранные устройства / ручной ввод', this.interfaces, 'Обычно br-lan. Несколько имён укажите через запятую.')]));
    this.dnsSingleFields = E('div',{'class':'ob-grid'},[field('Провайдер',this.dnsPreset),field('Протокол',this.dnsProtocol),field('DNS-сервер',this.dnsServer),field('Bootstrap IPv4',this.dnsBootstrap),this.dnsPathField]);
    this.dnsPoolFields = E('div',{},[field('DNS-серверы группы',this.dnsUpstreams,'От двух до четырёх серверов, по одному в строке: IP, udp://, tcp://, tls:// или https:// с путём DoH. В режиме основного и резервных первый сервер — основной.'),
      E('p',{'class':'ob-note'},'Основной и резервные: каждый запрос начинается с первого сервера; следующий используется только при сетевой ошибке, тайм-ауте или повреждённом ответе. Любой корректный DNS-ответ, включая NXDOMAIN, пустой ответ, REFUSED, SERVFAIL и адрес блокировки, возвращается без опроса резервных. Резервные тоже должны поддерживать нужную фильтрацию на случай отказа основного.'),
      E('p',{'class':'ob-note'},'Параллельный и автоматический режимы могут предпочесть ответ другого сервера, включая обход блокировки NXDOMAIN или пустым ответом. Используйте в этих режимах только серверы с одинаковой политикой фильтрации.'),
      field('Bootstrap DNS',this.dnsBootstrapServers,'До четырёх IP-адресов, по одному в строке. Разрешают имена DNS-серверов, серверов туннелей и узлов загрузки списков. При нескольких адресах используется тот же режим опроса.')]);
    this.dnsSettings = E('div',{'class':'ob-dns-settings'},[field('Режим опроса DNS',this.dnsPoolMode),this.dnsSingleFields,this.dnsPoolFields,this.dnsPrepareButton,this.dnsPrepareHint]);
    this.dnsTtlField = field('TTL выбранных доменов, секунд',this.dnsTtl,'Обычно 60. После перезагрузки роутера старые служебные адреса в кэше устройств должны истечь.');
    networkGrid.appendChild(card(this.dnsHeading, 'Роутер отвечает на DNS-запросы устройств локальной сети.', [E('details',{'class':'ob-details ob-dns-explanation'},[E('summary',{},'Как работает DNS и FakeIP'),this.dnsHint]),switchField(this.dnsSwitchCaption,this.dnsEnabled,this.dnsSwitchHelp),
      this.dnsSettings,this.dnsTtlField,
      E('p',{'class':'ob-help ob-dns-hint'},'После изменения сохраните настройки. DNS и HTTPS-маршрут можно проверить в «Диагностике».')]));
    this.panels.network.appendChild(networkGrid);
    this.panels.network.appendChild(E('details',{'class':'ob-accordion'},[E('summary',{},'Дополнительные параметры сети'),E('div',{'class':'ob-accordion-body'},[
      switchField('Настраивать DNS автоматически', this.manageDns, 'При выключении Обход вернёт прежние DNS-серверы. Поддерживается один экземпляр dnsmasq.'),
      switchField('Перехватывать IPv6', this.ipv6, 'Включайте, если IPv6 используется в вашей сети.'),
      switchField('Отключить QUIC',this.disableQuic,'Отклонять UDP на порту 443, чтобы браузеры использовали TCP. На работу самого туннеля не влияет.'),
      E('details', { 'class': 'ob-details' }, [E('summary', {}, 'Ручная настройка DNS'), E('p', { 'class': 'ob-help' }, 'При выключенной автоматической настройке укажите upstream dnsmasq: 127.0.0.1#1053. Для FakeIP отключите кэш dnsmasq (cachesize=0). Устройства должны использовать DNS этого роутера.')]) ])]));
    this.panels.diagnostics.appendChild(E('div',{'class':'ob-columns'},[
      card('Проверка службы','Конфигурация, LAN, перехват, DNS и HTTPS через выбранный сервер.',[
        this.diagnosticRows,E('div',{'class':'ob-inline-footer'},[this.diagnosticMessage,this.diagnosticButton])],this.diagnosticSummary),
      card('Подробности','',[this.diagnosticDetails,E('p',{'class':'ob-note'},'Проверки используют сохранённые настройки. Ошибки показываются с пояснением; секреты скрываются.')])]));
    this.logDetails = E('details',{'class':'ob-accordion ob-log-details'},[E('summary',{},['Журнал службы',E('span',{'class':'ob-help'},'До 32 КБ в ОЗУ · без записи во flash')]),
      E('div',{'class':'ob-log-body ob-accordion-body'},[switchField('Подробный журнал',this.verboseLogs,'По умолчанию сохраняются только предупреждения и ошибки.'),E('div',{'class':'ob-inline-actions'},[E('button',{type:'button','class':'cbi-button ob-button',click:ui.createHandlerFn(this,function(){return self.refreshLogs();})},'Обновить'),E('button',{type:'button','class':'cbi-button ob-button',click:ui.createHandlerFn(this,function(){return clearLogs().then(function(){return self.refreshLogs();});})},'Очистить')]),
        E('p',{'class':'ob-help ob-log-zone'},this.systemTimeUnavailable?'Часовой пояс роутера недоступен; время показано в UTC.':'Часовой пояс роутера: '+this.systemTimeZone+'.'),this.logText])]);
    this.logDetails.addEventListener('toggle', function() { if (self.logDetails.open) self.refreshLogs(); });
    this.panels.diagnostics.appendChild(this.logDetails);
    this.serviceButton = E('button', { type: 'button', 'class': 'cbi-button ob-button ob-service-button', click: ui.createHandlerFn(this, this.toggleService) }, 'Включить');
    this.restartButton = E('button', { type:'button', 'class':'cbi-button ob-button', click:ui.createHandlerFn(this,this.restartService) }, 'Перезапустить');
    this.applyButton = E('button', { type: 'button', 'class': 'cbi-button ob-button ob-primary', click: ui.createHandlerFn(this, function() { return self.save(true); }) }, 'Сохранить и включить');
    this.saveButton = E('button',{type:'button','class':'cbi-button ob-button ob-primary',click:ui.createHandlerFn(this,function(){return self.save(false);})},'Сохранить');
    this.cancelButton = E('button',{type:'button','class':'cbi-button ob-button',click:ui.createHandlerFn(this,this.cancelChanges)},'Отменить');
    this.operationTitle=E('strong');this.operationMessage=E('p',{'class':'ob-help'});
    this.operationNotice=E('div',{'class':'ob-operation-notice',role:'status','aria-live':'polite'},[this.operationTitle,this.operationMessage]);
    this.footer = E('footer', { 'class': 'ob-footer' }, [this.dirtyState, E('div', { 'class': 'ob-footer-actions' }, [
      this.cancelButton,this.saveButton,this.applyButton])]);
    this.breadcrumb=E('span');this.pageTitle=E('h2',{'class':'ob-page-title'});this.pageIntro=E('p',{'class':'ob-page-intro'});
    this.root = E('div', { 'class': 'cbi-map obhod-app' }, [E('link', { rel: 'stylesheet', href: L.resource('obhod/overview.css') }),
      E('header', { 'class': 'ob-header' }, [E('div', { 'class': 'ob-brand' }, [E('span', { 'class': 'ob-mark', 'aria-hidden': 'true' }, routeIcon()),
        E('div', {}, [E('strong', {'class':'ob-brand-title'}, 'Обход'), E('p', { 'class': 'ob-help' }, 'OpenWrt · Панель управления')])]),
        E('div', { 'class': 'ob-header-status' }, [this.routeDetail,this.state,this.restartButton,this.serviceButton])]),
      E('div',{'class':'ob-page-top'},[E('div',{},[E('p',{'class':'ob-eyebrow'},['Обход / ',this.breadcrumb]),this.pageTitle,this.pageIntro]),this.statusDetail]),
      this.operationNotice,nav, panels, this.footer,E('p',{'class':'ob-footer-note'},'Обход · выборочная маршрутизация для OpenWrt') ]);
    function changed(event) { if (![self.serverSearch,self.domainSearch,self.domainEntry,self.domainPageSelect].includes(event.target) && !self.panels.protocols.contains(event.target)) self.markDirty(); }
    this.root.addEventListener('input',changed);this.root.addEventListener('change',changed);
    this.renderTunnels();
    this.updatePresets(); this.updateCoreVersions(); this.updateProtocolHelp(); this.updateDnsFields(); this.selectTab('overview');
    this.updateStatus(data[0]);
    this.captureDraft();
    poll.add(function() { return status().then(function(value) { self.updateStatus(value); if(self.activeTab==='diagnostics') return self.refreshDiagnostics(); }).catch(function() {
      self.statusDetail.textContent = self.lastStatus.updateBusy ? 'Переподключаемся после обновления…' : 'Не удалось получить состояние. Повторяем запрос…';
    }); }, 5);
    return this.root;
  },

  updateStatus: function(value) {
    this.lastStatus = value;
    this.state.textContent = value.running ? 'Обход включён' : 'Обход выключен';
    this.state.classList.toggle('is-running', !!value.running);
    this.serviceButton.textContent = value.running || value.enabled ? 'Выключить' : 'Включить';
    this.serviceButton.disabled = !!(value.coreBusy || value.updateBusy || value.jobBusy || (!value.running && !value.enabled && (!value.configured || !value.version)));
    this.serviceButton.title = !value.configured ? 'Сначала сохраните подключение.' : 'Включение использует сохранённые настройки.';
    this.statusDetail.textContent = value.error || (value.jobBusy ? value.jobMessage : '') || value.version || 'Сначала установите ядро протоколов';
    this.statusDetail.classList.toggle('is-error',!!value.error);
    var telemetry = this.routeTelemetry(value, Date.now()/1000);
    this.liveRoute.textContent = !value.running ? 'Маршрут неактивен' : value.routeName || 'Проверяем маршрут…';
    this.liveDelay.textContent = value.running ? telemetry.label : '';
    this.overviewLiveRoute.textContent = this.liveRoute.textContent;
    this.overviewLiveDelay.textContent = this.liveDelay.textContent;
    this.routeDetail.title = telemetry.title;
    this.routeChecked.textContent=value.running?telemetry.title:'Маршрут неактивен';
    this.coreState.textContent = (value.coreFlavor || (value.version ? 'Своё ядро sing-box' : 'Ядро не установлено')) + (value.version?' · '+value.version.replace(/^sing-box version /,''):'')
      + (value.coreMessage ? ' · ' + value.coreMessage : '');
    this.installedCore.textContent=value.version || 'Не установлено';
    this.installedFlavor.textContent=value.coreFlavor==='sing-box-tiny'?'Облегчённый · прокси':value.coreFlavor==='sing-box'?'Полный · прокси и WireGuard':value.coreFlavor || 'Своё ядро';
    this.installedState.textContent=value.coreBusy?value.coreMessage || 'Установка…':value.version?'Установлено':'Требуется установка';
    this.coreBadge.textContent=value.coreBusy?'Операция…':value.version?'Установлено':'Не установлено';
    this.coreBadge.classList.toggle('ob-badge-green',!!value.version && !value.coreBusy);
    var busy=!!(value.coreBusy || value.updateBusy || value.jobBusy);
    this.coreButton.disabled = !!(value.running || value.enabled || busy || this.coreCatalog.unavailable);
    this.removeCoreButton.disabled=!!(value.running || value.enabled || busy || !value.coreFlavor);
    this.removeCoreButton.title=value.running || value.enabled?'Сначала выключите Обход.':'Подключения и списки сохранятся.';
    this.protocols.disabled = busy;this.coreVersion.disabled=busy || !!this.coreCatalog.unavailable;
    this.restartButton.hidden=!value.running;
    this.restartButton.disabled=busy || !value.running;
    this.restartButton.title='Перезапуск с сохранёнными настройками. Несохранённые изменения не применяются.';
    this.coreHint.textContent = value.coreBusy ? 'Идёт установка. Состояние обновляется автоматически.' : value.running
      ? 'Перед сменой ядра выключите Обход кнопкой вверху.' : 'После установки сохраните настройки и включите Обход.';
    this.updateSummary();
    this.updateControls();
    this.diagnosticButton.disabled = !!(value.coreBusy || value.updateBusy || value.jobBusy);
    this.diagnosticMessage.textContent = value.jobMessage || 'Проверка использует сохранённые настройки.';
    this.renderHealth();
  },

  routeTelemetry: function(value, now) {
    var measured = Number(value.routeCheckedAt), received = Number(value.routeReceivedAt);
    var age = now - measured, readAge = now - received;
    var known = value.routeKnown === true && measured > 0;
    var fresh = known && age >= -5 && age <= Number(value.routeMaxAge) && received > 0 && readAge >= -5 && readAge < 90;
    var label = !known ? 'нет замера' : !fresh ? 'замер устарел' : value.routeOk ? (value.routeDelay !== '' ? value.routeDelay + ' мс' : 'нет замера') : 'нет ответа';
    var title = known ? 'Замер: ' + this.formatSystemTime(measured,false) : 'Ожидаем замер ядра.';
    if (received > 0) title += ' Получено: ' + this.formatSystemTime(received,false) + '.';
    if (Number(value.routeDiagnosedAt) > 0) title += ' Явная диагностика.';
    if (!fresh) title += ' Активная HTTPS-проверка доступна в диагностике.';
    return { label: label, title: title };
  },

  updateControls: function() {
    if (!this.lastStatus) return;
    var state = this.lastStatus, busy = !!(state.updateBusy || state.coreBusy || state.jobBusy);
    this.dnsPrepareButton.hidden = state.dnsPoolReady === true;
    this.dnsPrepareButton.disabled = busy;
    this.dnsPrepareHint.textContent = state.dnsPoolReady ? 'Компонент DNS готов.' : 'Для DNS один раз установите небольшой дополнительный компонент из репозитория OpenWrt.';
    this.operationNotice.hidden=!busy;
    this.operationTitle.textContent=state.coreBusy?(state.coreAction==='remove'?'Удаление ядра':'Установка ядра протоколов'):state.updateBusy?'Обновление Обхода':state.jobAction==='restart'?'Перезапуск службы':'Операция службы';
    this.operationMessage.textContent=((state.coreBusy?state.coreMessage:state.updateBusy?state.updateMessage:state.jobMessage) || 'Выполняется операция…')
      + (state.coreBusy?' Переключение разделов и редактирование доступны. Сохранить настройки и включить службу можно после установки.':'');
    var installing = !!state.updateBusy || state.updateState === 'running';
    var failed = state.updateState === 'error';
    var available = !!state.updateAvailable && state.updateState !== 'done';
    var finished = state.updateState === 'done';
    var attention = failed ? 'error' : installing ? 'running' : available ? 'available:' + (state.availableVersion || '') : '';
    this.updateVersion.textContent = 'Установлена версия ' + (state.obhodVersion || '—');
    this.updateMessage.textContent = state.updateMessage || 'Проверьте, доступна ли новая версия.';
    if (available && this.dirty && !installing && !failed) this.updateMessage.textContent = 'Доступна версия ' + state.availableVersion + '. Сначала сохраните изменения.';
    this.updateBadge.textContent = failed ? 'Ошибка' : installing ? 'Обновляется' : available ? 'Новая версия' : finished ? 'Готово' : '';
    this.updateBadge.hidden = !this.updateBadge.textContent;
    this.updateBadge.classList.toggle('is-error', failed);
    this.updateBadge.classList.toggle('is-busy', installing);
    this.updateSummaryMessage.classList.toggle('is-error', failed);
    this.updateSummaryMessage.textContent = failed ? state.updateMessage || 'Обновление завершилось с ошибкой.'
      : installing ? state.updateMessage || 'Выполняется обновление…'
      : available ? state.updateMessage || 'Доступна версия ' + (state.availableVersion || '—') + '.'
      : finished ? state.updateMessage || 'Обход обновлён.' : '';
    this.updateSummaryMessage.hidden = !this.updateSummaryMessage.textContent;
    if (attention && attention !== this.lastUpdateAttention) this.updateDetails.open = true;
    this.lastUpdateAttention = attention;
    this.updateCheck.disabled = busy;
    this.updateInstall.hidden = !state.updateAvailable || state.updateState === 'done';
    this.updateInstall.disabled = busy || this.dirty;
    this.updateReload.hidden = state.updateState !== 'done' || state.obhodVersion === this.loadedVersion;
    this.saveButton.textContent = state.running ? 'Применить изменения' : 'Сохранить';
    this.saveButton.classList.toggle('ob-primary', !!state.running);
    this.saveButton.disabled = !this.dirty || busy;
    this.saveButton.title=busy?this.busyReason():'';
    this.applyButton.hidden = !!state.running || !this.dirty;
    this.applyButton.disabled = busy;
    this.applyButton.title=busy?this.busyReason():'';
    if(busy)this.serviceButton.title=this.busyReason();
    this.cancelButton.hidden = !this.dirty;this.cancelButton.disabled=false;
    this.footer.hidden=!this.dirty;
  },

  busyReason: function() {
    var state=this.lastStatus;
    return state.coreBusy?'Дождитесь окончания установки ядра протоколов. Ход установки показан вверху страницы.'
      :state.updateBusy?'Дождитесь окончания обновления Обхода.'
      :'Дождитесь окончания текущей операции службы: '+(state.jobMessage || 'переключение или диагностика');
  },

  updateObhod: function(action) {
    if (this.lastStatus.updateBusy || this.lastStatus.coreBusy || this.lastStatus.jobBusy) return Promise.resolve();
    if (action === 'install' && this.dirty) {
      ui.addNotification(null, E('p', {}, 'Сначала сохраните изменения перед обновлением.'), 'info'); return Promise.resolve();
    }
    return this.operation(function() { return update(action); });
  },

  selectTab: function(id) {
    if (!this.tabs[id]) return;
    this.activeTab = id;
    var self = this;
    Object.keys(this.tabs).forEach(function(key) {
      self.tabs[key].setAttribute('aria-selected', String(key === id));
      self.tabs[key].tabIndex = key === id ? 0 : -1;
      self.panels[key].hidden = key !== id;
      self.panels[key].classList.toggle('active',key===id);
    });
    var definition=this.tabDefinitions.find(function(entry){return entry[0]===id;});
    this.pageTitle.textContent=definition[1];this.breadcrumb.textContent=definition[1];this.pageIntro.textContent=definition[2];
    if (id === 'diagnostics') this.refreshDiagnostics();
  },

  updateDnsFields: function() {
    var enabled = checked(this.dnsEnabled);
    this.dnsHeading.textContent='DNS и маршрутизация FakeIP';
    this.dnsSwitchCaption.textContent='Настроить общий DNS';
    this.dnsSwitchHelp.textContent=this.dnsPoolMode.value==='single'?'Этот сервер используется для обычных доменов. По умолчанию — UDP 1.1.1.1.':'Для обычных доменов используется группа DNS. DNS выбранных сайтов сохраняет маршрут через туннель.';
    this.dnsHint.textContent='Выбранные домены сначала проверяются настроенным DNS через туннель. Служебный IP выдаётся только после разрешающего ответа; блокировки DNS сохраняются. Обычные сайты получают реальные адреса и идут напрямую. Устройства должны использовать DNS роутера; соответствия хранятся в /tmp.';
    [this.dnsPreset,this.dnsProtocol,this.dnsServer,this.dnsBootstrap,this.dnsPath,this.dnsPoolMode,this.dnsUpstreams,this.dnsBootstrapServers].forEach(function(input){input.disabled=!enabled;});
    this.dnsSingleFields.hidden = this.dnsPoolMode.value !== 'single';
    this.dnsPoolFields.hidden = this.dnsPoolMode.value === 'single';
    this.dnsTtl.disabled=false;this.dnsTtlField.hidden=false;
    this.dnsSettings.hidden = !enabled;
    this.dnsPathField.hidden = this.dnsProtocol.value !== 'https';
  },

  toggleService: function() {
    if(this.lastStatus.coreBusy || this.lastStatus.updateBusy || this.lastStatus.jobBusy) return Promise.resolve();
    var action=this.lastStatus.running || this.lastStatus.enabled ? 'stop' : 'start';
    return this.operation(function(){return service(action);});
  },

  restartService: function() {
    if(!this.lastStatus.running || this.lastStatus.coreBusy || this.lastStatus.updateBusy || this.lastStatus.jobBusy) return Promise.resolve();
    return this.operation(function(){return service('restart');});
  },

  applyDnsPreset: function() {
    var preset=DNS_PRESETS[this.dnsPreset.value], protocol=this.dnsProtocol.value;
    if(preset) { this.dnsServer.value=protocol==='https'?preset.https[0]:protocol==='tls'?preset.tls:preset.plain;
      this.dnsBootstrap.value=preset.bootstrap; this.dnsPath.value=protocol==='https'?preset.https[1]:'/dns-query'; }
    this.updateDnsFields();
  },

  runDiagnostics: function() {
    var self=this;
    if(this.dirty) { ui.addNotification(null,E('p',{},'Сначала сохраните изменения: диагностика проверяет применённые настройки.'),'info'); return Promise.resolve(); }
    return this.operation(function(){return diagnose();}).then(function(){return self.refreshDiagnostics();});
  },

  refreshDiagnostics: function() {
    var self=this;
    if(this.diagnosticsLoading) return this.diagnosticsPromise;
    this.diagnosticsLoading=true;
    this.diagnosticsPromise=diagnostics().then(function(result){
      self.lastDiagnostics=result;
      self.diagnosticRows.replaceChildren();
      self.diagnosticDetails.replaceChildren();
      var checks=result.checks || [], passed=checks.filter(function(check){return check.ok;}).length;
      self.diagnosticSummary.textContent=checks.length?passed+' из '+checks.length+' пройдено':'Нет результатов';
      self.diagnosticSummary.classList.toggle('ob-badge-green',checks.length>0 && passed===checks.length);
      checks.forEach(function(check){
        var title=[E('strong',{},check.name),E('span',{'class':check.ok?'ob-check-ok':'ob-check-fail'},check.ok?'✓':'✕')];
        self.diagnosticRows.appendChild(check.ok
          ?E('details',{'class':'ob-diagnostic-row is-ok'},[E('summary',{},title),E('p',{'class':'ob-help'},check.message)])
          :E('div',{'class':'ob-diagnostic-row is-fail'},title.concat([E('p',{'class':'ob-help'},check.message)])));
        self.diagnosticDetails.appendChild(E('div',{'class':'ob-kv'},[E('span',{},check.name),E('span',{},check.message)]));
      });
      if(!checks.length)self.diagnosticRows.appendChild(E('p',{'class':'ob-help'},'Проверка ещё не выполнена.'));
      if(result.note) self.diagnosticRows.appendChild(E('p',{'class':'ob-note'},result.note));
      self.renderHealth();
    }).catch(function(){self.diagnosticMessage.textContent='Не удалось прочитать диагностику. Повторите запрос.';}).finally(function(){self.diagnosticsLoading=false;});
    return this.diagnosticsPromise;
  },

  renderHealth: function() {
    var state=this.lastStatus || {}, result=this.lastDiagnostics, checks=result && result.checks || [];
    this.healthRows.replaceChildren();
    this.healthRows.appendChild(E('div',{'class':'ob-health-item'},[
      E('span',{'class':state.running?'ob-check-ok':'ob-help'},state.running?'✓':'○'),E('span',{},state.running?'Служба активна':'Служба выключена')]));
    var relevant=checks.filter(function(check){return /DNS|Перехват|HTTPS/i.test(check.name);}).slice(0,3);
    if(!relevant.length)relevant=[{name:'DNS роутера'},{name:'Перехват трафика'},{name:'HTTPS через подключение'}];
    relevant.forEach(function(check){this.healthRows.appendChild(E('div',{'class':'ob-health-item'},[
      E('span',{'class':check.ok===true?'ob-check-ok':check.ok===false?'ob-check-fail':'ob-help'},check.ok===true?'✓':check.ok===false?'✕':'○'),E('span',{},check.name)]));},this);
    var failed=checks.some(function(check){return !check.ok;});
    this.healthBadge.textContent=!state.running?'Служба выключена':!checks.length?'Нет результатов':failed?'Требует внимания':'Проверки пройдены';
    this.healthBadge.classList.toggle('ob-badge-green',!!state.running && checks.length>0 && !failed);
    this.healthNote.textContent=checks.length?(result.checkedAt?'Последняя диагностика: '+this.formatSystemTime(result.checkedAt,true):'Результаты последней диагностики'):'DNS и HTTPS ещё не проверены. Откройте диагностику.';
  },

  configureSystemTime: function(settings) {
    var zone=String(settings && settings.zonename || 'UTC').replace(/ /g,'_');
    this.systemTimeUnavailable=!settings;
    try {
      this.logDateFormatter=new Intl.DateTimeFormat('en-GB-u-nu-latn',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
    } catch(_) {
      zone='UTC';this.systemTimeUnavailable=true;
      this.logDateFormatter=new Intl.DateTimeFormat('en-GB-u-nu-latn',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
    }
    this.systemTimeZone=zone;
  },

  formatSystemTime: function(epoch,withDate) {
    return new Intl.DateTimeFormat('ru-RU',{timeZone:this.systemTimeZone || 'UTC',dateStyle:withDate?'short':undefined,timeStyle:'medium'}).format(new Date(epoch*1000));
  },

  formatLogText: function(value) {
    var self=this;
    // Terminal colour/cursor sequences and OSC metadata are presentation, not log text.
    var text=String(value || '').replace(/\r\n?/g,'\n')
      .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)/g,'')
      .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g,'')
      .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*$/g,'')
      .replace(/\x1b[@-_]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'');
    return text.replace(/^([+-]\d{4}) (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?(?=\s)/gm,function(original,offset,date,time,fraction){
      var instant=new Date(date+'T'+time+offset.slice(0,3)+':'+offset.slice(3));
      if(!self.logDateFormatter || !Number.isFinite(instant.getTime()))return original;
      var parts={};self.logDateFormatter.formatToParts(instant).forEach(function(part){parts[part.type]=part.value;});
      var local=parts.year+'-'+parts.month+'-'+parts.day+' '+parts.hour+':'+parts.minute+':'+parts.second;
      var shift=Math.round((Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second))-instant.getTime())/60000);
      var minutes=Math.abs(shift), zone=(shift<0?'-':'+')+String(Math.floor(minutes/60)).padStart(2,'0')+String(minutes%60).padStart(2,'0');
      return zone+' '+local+(fraction || '');
    });
  },

  refreshLogs: function() {
    var self=this;
    if(this.logsLoading) return this.logsPromise;
    this.logsLoading=true;
    this.logsPromise=logs().then(function(result){
      self.logText.textContent=self.formatLogText(result.text) || 'Журнал пока пуст.';
    }).catch(function(){self.logText.textContent='Не удалось прочитать журнал. Нажмите «Обновить», чтобы повторить.';}).finally(function(){self.logsLoading=false;});
    return this.logsPromise;
  },

  markDirty: function(clean) {
    this.dirty = !clean;
    this.dirtyState.textContent = clean ? 'Все изменения сохранены' : 'Есть несохранённые изменения';
    this.dirtyState.classList.toggle('is-dirty', !clean);
    this.footer.classList.toggle('has-changes', !clean);
    this.updateControls();
  },

  buildDomainEditor: function() {
    var self=this;
    this.domainPage=0;
    this.domainCollator=new Intl.Collator('ru',{numeric:true,sensitivity:'base'});
    this.domainCount=E('span',{'class':'ob-counter','aria-live':'polite'});
    this.domainResults=E('span',{'aria-live':'polite'});
    this.domainSearch=E('input',{type:'search',placeholder:'Поиск среди всех доменов…','aria-label':'Поиск своих доменов',input:function(){self.domainPage=0;self.renderDomains();}});
    this.domainClear=E('button',{type:'button','class':'ob-search-clear','aria-label':'Очистить поиск доменов',title:'Очистить поиск',click:function(){self.domainSearch.value='';self.domainPage=0;self.renderDomains();self.domainSearch.focus();}},'×');
    this.domainEntry=E('input',{type:'text',placeholder:'example.org или https://example.org','aria-label':'Добавить домен или URL',keydown:function(event){if(event.key==='Enter'){event.preventDefault();self.addDomain();}}});
    this.domainRows=E('div',{'class':'ob-domain-rows','aria-label':'Пользовательские домены'});
    this.domainError=E('p',{'class':'ob-help ob-domain-error','aria-live':'polite'});
    this.domainNotice=E('p',{'class':'ob-help',role:'status'});
    this.domainUndo=E('button',{type:'button','class':'cbi-button ob-button ob-button-sm',click:function(){self.undoDomainDeletion();}},'Отменить удаление');
    this.domainUndoText=E('span');
    this.domainUndoBar=E('div',{'class':'ob-domain-undo',role:'status'},[this.domainUndoText,this.domainUndo]);
    this.domainPager=E('span',{'class':'ob-help'});
    function pageChanged(){self.renderDomains();if(self.domainCard)self.domainCard.scrollIntoView({block:'start'});}
    this.domainPrev=E('button',{type:'button','class':'cbi-button ob-button ob-button-sm','aria-label':'Предыдущая страница',click:function(){self.domainPage--;pageChanged();}},'← Назад');
    this.domainNext=E('button',{type:'button','class':'cbi-button ob-button ob-button-sm','aria-label':'Следующая страница',click:function(){self.domainPage++;pageChanged();}},'Далее →');
    this.domainPageSelect=E('select',{'aria-label':'Номер страницы доменов',change:function(){self.domainPage=Number(self.domainPageSelect.value);pageChanged();}});
    this.domainPageTotal=E('span',{'class':'ob-help'});
    // The full list used by save() is independent of both the viewport and the bulk draft.
    this.domainBulkText=E('textarea',{rows:7,spellcheck:'false','aria-label':'Полный список доменов',input:function(){self.updateDomainBulkState();}},this.domainText.value);
    this.domainBulkBaseline=this.domainBulkText.value;
    this.domainBulkHint=E('p',{'class':'ob-help','aria-live':'polite'});
    this.domainBulkReplace=E('button',{type:'button','class':'cbi-button ob-button ob-button-sm',click:function(){self.replaceDomainList();}},'Заменить полный список доменов');
    this.domainBulk=E('details',{'class':'ob-accordion ob-domain-accordion'},[E('summary',{},'Массовое редактирование'),
      E('div',{'class':'ob-accordion-body'},[E('p',{'class':'ob-help'},'Полный список независимо от поиска и страницы. Домены или URL, по одному в строке. Замена применяется по кнопке ниже.'),
        this.domainBulkText,this.domainBulkHint,this.domainBulkReplace])]);
    this.cidrDetails=E('details',{'class':'ob-accordion ob-domain-accordion'},[E('summary',{},'IP-адреса и подсети'),
      E('div',{'class':'ob-accordion-body'},[field('IP и подсети',this.cidrText,'Отдельные правила для IP и CIDR. Например, 203.0.113.0/24.')])]);
    this.renderDomains();
    return E('div',{'class':'ob-domain-editor'},[
      E('div',{'class':'ob-domain-controls'},[E('div',{'class':'ob-search ob-domain-toolbar'},[this.domainSearch,this.domainClear]),
        E('div',{'class':'ob-domain-add'},[this.domainEntry,E('button',{type:'button','class':'cbi-button ob-button ob-primary',click:function(){self.addDomain();}},'Добавить')])]),
      this.domainError,this.domainNotice,
      E('div',{'class':'ob-domain-results'},[this.domainResults,E('span',{},'Сортировка: А–Я')]),this.domainRows,this.domainUndoBar,
      E('div',{'class':'ob-domain-pages'},[this.domainPager,E('nav',{'class':'ob-domain-pager','aria-label':'Страницы доменов'},[
        this.domainPrev,E('span',{'class':'ob-help'},'Страница'),this.domainPageSelect,this.domainPageTotal,this.domainNext])]),
      E('div',{'class':'ob-domain-panels'},[this.domainBulk,this.cidrDetails])]);
  },

  updateDomainBulkState: function() {
    var dirty=this.domainBulkText.value!==this.domainBulkBaseline;
    this.domainBulkReplace.disabled=!dirty;
    this.domainBulkHint.textContent=dirty?'Черновик не включён в список. Нажмите «Заменить полный список доменов» перед сохранением.':'';
  },

  renderDomains: function() {
    var self=this, values;
    this.domainRows.replaceChildren();
    try {
      if(this.domainCacheText!==this.domainText.value) {
        this.domainValues=Array.from(new Set(domains(this.domainText.value)));
        this.domainSorted=this.domainValues.slice().sort(this.domainCollator.compare);
        this.domainCacheText=this.domainText.value;
      }
      values=this.domainSorted;
    }
    catch(error){this.domainError.textContent=error.message;this.domainCount.textContent='Проверьте текст списка';this.domainPrev.disabled=true;this.domainNext.disabled=true;return;}
    if(this.domainBulkText.value===this.domainBulkBaseline && this.domainBulkBaseline!==this.domainText.value) {
      this.domainBulkText.value=this.domainText.value;this.domainBulkBaseline=this.domainText.value;
    }
    this.updateDomainBulkState();
    this.domainUndo.hidden=!this.domainDeleted;
    this.domainUndoBar.hidden=!this.domainDeleted;
    if(this.domainDeleted)this.domainUndoText.textContent='Удалён '+this.domainDeleted.value;
    var query=this.domainSearch.value.trim().toLowerCase(), filtered=values.filter(function(value){return value.toLowerCase().includes(query);});
    var size=25, pages=Math.max(1,Math.ceil(filtered.length/size));this.domainPage=Math.max(0,Math.min(this.domainPage,pages-1));
    var count=values.length, mod100=count%100, mod10=count%10;
    this.domainCount.textContent=count.toLocaleString('ru-RU')+' '+(mod100>=11 && mod100<=14?'доменов':mod10===1?'домен':mod10>=2 && mod10<=4?'домена':'доменов');
    this.domainResults.textContent=query?'Найдено '+filtered.length+' из '+values.length:'Все домены · '+values.length.toLocaleString('ru-RU');
    this.domainClear.hidden=!this.domainSearch.value;
    filtered.slice(this.domainPage*size,(this.domainPage+1)*size).forEach(function(value){
      self.domainRows.appendChild(E('div',{'class':'ob-domain-row'},[E('span',{'class':'ob-domain-name',title:value},value),
        E('button',{type:'button','class':'ob-delete','aria-label':'Удалить домен '+value,title:'Удалить',click:function(){
          var current=Array.from(new Set(domains(self.domainText.value))), index=current.indexOf(value);
          if(index<0)return;
          self.domainDeleted={value:value,index:index};current.splice(index,1);
          self.domainText.value=current.join('\n');self.domainError.textContent='';self.domainNotice.textContent='';self.markDirty();self.renderDomains();
        }},'×')]));
    });
    if(!filtered.length)this.domainRows.appendChild(E('p',{'class':'ob-help ob-domain-empty'},query?'Домены не найдены':'Список пуст. Добавьте домен или раскройте «Массовое редактирование».'));
    this.domainPager.textContent=(filtered.length?(this.domainPage*size+1)+'–'+Math.min((this.domainPage+1)*size,filtered.length):'0')+' из '+filtered.length;
    if(this.domainPageSelect.options.length!==pages){
      this.domainPageSelect.replaceChildren();
      for(var page=0;page<pages;page++)this.domainPageSelect.appendChild(E('option',{value:String(page)},String(page+1)));
    }
    this.domainPageSelect.value=String(this.domainPage);this.domainPageSelect.disabled=pages===1;
    this.domainPageTotal.textContent='из '+pages;
    this.domainPrev.disabled=this.domainPage===0;this.domainNext.disabled=this.domainPage>=pages-1;
  },

  addDomain: function() {
    try {
      var added=domains(this.domainEntry.value);if(!added.length)return;
      var current=Array.from(new Set(domains(this.domainText.value))), known=new Set(current), count=0;
      added.forEach(function(value){if(!known.has(value)){known.add(value);current.push(value);count++;}});
      this.domainError.textContent='';
      if(!count){this.domainNotice.textContent='Домен уже существует.';return;}
      this.domainText.value=current.join('\n');this.domainEntry.value='';
      this.domainNotice.textContent='Добавлено доменов: '+count+'.'+(this.domainSearch.value.trim()?' Поиск остаётся активным.':'');
      this.markDirty();this.renderDomains();
    } catch(error){this.domainError.textContent=error.message;}
  },

  undoDomainDeletion: function() {
    if(!this.domainDeleted)return;
    var current=Array.from(new Set(domains(this.domainText.value))), deleted=this.domainDeleted;
    if(!current.includes(deleted.value))current.splice(Math.min(deleted.index,current.length),0,deleted.value);
    this.domainText.value=current.join('\n');this.domainDeleted=null;
    this.domainNotice.textContent='Восстановлен домен '+deleted.value+'.';this.markDirty();this.renderDomains();
  },

  replaceDomainList: function() {
    try {
      var parsed=domains(this.domainBulkText.value), unique=Array.from(new Set(parsed));
      this.domainText.value=unique.join('\n');this.domainBulkText.value=this.domainText.value;
      this.domainBulkBaseline=this.domainText.value;this.domainDeleted=null;this.domainError.textContent='';
      this.domainNotice.textContent='Полный список заменён: '+unique.length+' доменов. Удалено дублей: '+(parsed.length-unique.length)+'. Сохраните настройки.';
      this.markDirty();this.renderDomains();
    } catch(error){this.domainError.textContent=error.message;}
  },

  captureDraft: function() {
    var self=this;
    this.domainDeleted=null;this.domainUndo.hidden=true;this.domainUndoBar.hidden=true;
    this.savedDraft=JSON.parse(JSON.stringify({profile:this.profile,options:this.options}));
    this.savedFields={};
    ['active','group','interval','tolerance','testUrl','listInterval','downloadLists','dnsEnabled','dnsPreset','dnsProtocol','dnsServer','dnsBootstrap','dnsPath','dnsPoolMode','dnsUpstreams','dnsBootstrapServers','dnsTtl','verboseLogs','domainText','cidrText','remoteText','interfaces','manageDns','ipv6','disableQuic'].forEach(function(key){
      self.savedFields[key]={value:self[key].value,checked:self[key].checked};
    });
  },

  cancelChanges: function() {
    if(!this.savedDraft)return;
    var self=this, saved=JSON.parse(JSON.stringify(this.savedDraft));this.profile=saved.profile;this.options=saved.options;
    Object.keys(this.savedFields).forEach(function(key){self[key].value=self.savedFields[key].value;if(typeof self.savedFields[key].checked==='boolean')self[key].checked=self.savedFields[key].checked;});
    Object.keys(this.presetInputs).forEach(function(id){self.presetInputs[id].checked=self.profile.routing.presetIds.includes(id);});
    this.importText.value='';this.domainEntry.value='';this.domainPage=0;this.domainDeleted=null;
    this.domainBulkText.value=this.domainText.value;this.domainBulkBaseline=this.domainText.value;
    this.domainError.textContent='';this.domainNotice.textContent='';
    this.renderTunnels();this.updatePresets();this.updateDnsFields();this.renderDomains();this.markDirty(true);
  },

  updateCoreVersions: function() {
    var previous=this.coreVersion.value, profile=this.protocols.value==='proxy'?'lite':'full';
    var rows=(this.coreCatalog.versions || []).filter(function(row){return row.profile===profile;});
    this.coreVersion.replaceChildren();
    if(this.coreCatalog.unavailable) this.coreVersion.appendChild(E('option',{value:''},'Не удалось получить версии — обновите страницу'));
    else if(!rows.length) this.coreVersion.appendChild(E('option',{value:'auto'},'Из репозитория OpenWrt'+(this.coreSizes[profile]?.version?' · '+this.coreSizes[profile].version:'')));
    else rows.forEach(function(row){this.coreVersion.appendChild(E('option',{value:row.value},row.value+(row.recommended?' · рекомендуется':' · предыдущая версия')));},this);
    if(rows.some(function(row){return row.value===previous;})) this.coreVersion.value=previous;
    else if(rows.length) this.coreVersion.value=(rows.find(function(row){return row.recommended;}) || rows[0]).value;
  },

  updateProtocolHelp: function() {
    this.protocolHelp.textContent = this.protocols.value === 'proxy'
      ? 'VLESS/Reality, Shadowsocks, Trojan, Hysteria2, TUIC, AnyTLS, SOCKS и HTTP. Подходит для роутеров с небольшим объёмом памяти.'
      : this.protocols.value === 'wireguard' ? 'Поддержка WireGuard. Требуется полное ядро; прокси-протоколы также останутся доступны.'
        : 'Прокси-протоколы и WireGuard.';
    var profile=this.protocols.value==='proxy'?'lite':'full', selected=(this.coreCatalog.versions || []).find(function(row){return row.profile===profile && row.value===this.coreVersion.value;},this);
    var size=selected || this.coreSizes[profile];
    this.coreVersionHelp.textContent=this.coreCatalog.unavailable?'Установка недоступна, пока не загружен каталог версий.':selected && !selected.recommended
      ?'Для отката на эту сборку нужна прежняя версия приложения. В текущей версии Обхода требуется ядро .4; при запуске оно будет установлено автоматически. Подключения сохранятся.'
      :selected?'Совместимая сборка Обхода для вашего роутера. Скачивание проверяется по SHA-256.':'Будет установлен пакет, доступный в репозитории вашей версии OpenWrt.';
    function mb(bytes){return (bytes/1048576).toLocaleString('ru-RU',{maximumFractionDigits:1});}
    this.downloadSize.textContent=size?'≈ '+mb(size.downloadBytes)+' МБ':'Нет данных';
    this.installedSize.textContent=size?'≈ '+mb(size.installedBytes)+' МБ':'Нет данных';
    this.protocolHelp.textContent += size
      ? ' Скачивание ≈ '+mb(size.downloadBytes)+' МБ; после распаковки ≈ '+mb(size.installedBytes)+' МБ. На flash со сжатием размер может быть меньше. Зависимости учитываются при установке.'
      : ' Размер зависит от архитектуры. Обновите списки пакетов в OpenWrt и перезагрузите эту страницу, чтобы увидеть оценку; зависимости проверяются при установке.';
  },

  updatePresets: function(changed) {
    var self = this, regions = ['russia_inside', 'russia_outside', 'ukraine_inside'];
    var selected = Object.keys(this.presetInputs).filter(function(id) { return checked(self.presetInputs[id]); });
    if (regions.includes(changed) && checked(this.presetInputs[changed])) selected = [changed].concat(selected.filter(function(id) { return id !== changed; }));
    selected = core.normalizePresets(selected);
    Object.keys(this.presetInputs).forEach(function(id) {
      var input = self.presetInputs[id];
      input.checked = selected.includes(id);
      input.disabled = selected.includes('russia_inside') && !regions.includes(id) && !core.normalizePresets(['russia_inside', id]).includes(id);
      input.parentElement.classList.toggle('is-disabled', input.disabled);
      input.parentElement.title = input.disabled ? 'Включено в региональный список или несовместимо с ним' : '';
    });
    this.presetCount.textContent = 'Выбрано списков: ' + selected.length;
    Object.keys(this.presetGroupCounters).forEach(function(name) {
      var group = self.presetGroupCounters[name];
      var count = group.ids.filter(function(id) { return selected.includes(id); }).length;
      group.node.textContent = count ? count + ' выбрано' : 'Не выбрано';
      group.node.classList.toggle('has-selection', count > 0);
    });
    this.updateSummary();
  },

  updateSummary: function() {
    if (!this.summaryServers) return;
    var self = this, state = this.lastStatus || {};
    var count = Object.keys(this.presetInputs).filter(function(id) { return checked(self.presetInputs[id]); }).length;
    var selectedCount=(this.tunnelRows || []).filter(function(row){return checked(row.input);}).length;
    this.summaryServers.replaceChildren(document.createTextNode(String(selectedCount)),E('small',{},' / '+this.profile.tunnels.length));
    this.summaryRules.textContent = String(count);
    this.summaryCore.textContent = state.coreBusy ? 'Установка…' : state.coreFlavor === 'sing-box-tiny' ? 'Облегчённое' : state.coreFlavor === 'sing-box' ? 'Полное' : state.version ? 'Установлено' : 'Не установлено';
    var active = this.profile.tunnels.find(function(tunnel) { return tunnel.id === self.active.value; });
    this.routeSummary.textContent = !this.profile.tunnels.length ? 'Добавьте первое подключение'
      : checked(this.group) ? 'Автоматический выбор · серверов: ' + this.tunnelRows.filter(function(row) { return checked(row.input); }).length
        : (active ? active.name : 'Выберите основное подключение');
    this.routeMode.textContent=checked(this.group)?'Автовыбор':'Основной';
    var signature = [!!state.version, this.profile.tunnels.length > 0, count > 0].join(':');
    if (signature !== this.setupSignature) {
      this.setupSignature = signature; this.setup.replaceChildren();
      if (!state.version || !this.profile.tunnels.length) {
        this.setup.appendChild(E('h3', {}, 'Начните с трёх шагов'));
        [['protocols', 'Установите протоколы', !!state.version], ['connections', 'Добавьте подключение', this.profile.tunnels.length > 0], ['rules', 'Выберите сайты', count > 0]].forEach(function(step, index) {
          self.setup.appendChild(E('button', { type: 'button', 'class': 'ob-setup-step', click: function() { self.selectTab(step[0]); } }, [
            E('span', { 'class': step[2] ? 'ob-step-number is-done' : 'ob-step-number', 'aria-hidden': 'true' }, step[2] ? '✓' : String(index + 1)),
            E('span', {}, step[1]), E('span', { 'class': 'ob-help' }, step[2] ? 'Готово' : 'Настроить →')]));
        });
      }
    }
  },

  setServerFilter: function(mode) {
    this.serverFilter=mode;
    this.serverFilterAll.setAttribute('aria-pressed',String(mode==='all'));
    this.serverFilterSelected.setAttribute('aria-pressed',String(mode==='selected'));
    this.filterTunnels();
  },

  filterTunnels: function() {
    var query = this.serverSearch.value.trim().toLowerCase(), visible = 0;
    this.tunnelRows.forEach(function(row) { row.element.hidden = !row.search.includes(query) || (this.serverFilter==='selected' && !row.input.checked); if (!row.element.hidden) visible++; },this);
    this.serverVisible.textContent=visible+' из '+this.tunnelRows.length+' подключений';
    this.serverEmpty.hidden = visible > 0;
    this.serverEmpty.textContent = this.tunnelRows.length ? 'По этому запросу серверы не найдены.' : 'Здесь появятся ваши серверы. Добавьте подключение в блоке импорта выше.';
  },

  installProtocols: function() {
    var self = this;
    if (this.lastStatus.running || this.lastStatus.enabled || this.lastStatus.coreBusy || this.lastStatus.updateBusy || this.lastStatus.jobBusy || this.coreCatalog.unavailable) return Promise.resolve();
    var profile = this.protocols.value === 'proxy' ? 'lite' : 'full';
    return this.operation(function() {
      return installCore(profile,self.coreVersion.value).then(function(result) {
        if (result.ok) ui.addNotification(null, E('p', {}, 'Установка запущена. Состояние обновится автоматически; страницу можно оставить открытой.'), 'info');
        return result;
      });
    });
  },

  confirmRemoveCore: function() {
    var self=this;
    var state=this.lastStatus;
    if(state.running || state.enabled || state.coreBusy || state.updateBusy || state.jobBusy || !state.coreFlavor) return Promise.resolve();
    ui.showModal('Удалить ядро sing-box?',[
      E('p',{},'Обход не сможет запускаться до повторной установки ядра. Сохранённые подключения, DNS и списки останутся на роутере.'),
      E('div',{'class':'right ob-inline-actions'},[
        E('button',{type:'button','class':'cbi-button',click:function(){ui.hideModal();}},'Отмена'),
        E('button',{type:'button','class':'cbi-button ob-button ob-danger',click:ui.createHandlerFn(this,function(){
          ui.hideModal();return self.operation(function(){return removeCore();});
        })},'Удалить ядро')])]);
    return Promise.resolve();
  },

  updateAll: function() {
    var count = this.tunnelRows.filter(function(row) { return row.input.checked; }).length;
    this.all.checked = count > 0 && count === this.tunnelRows.length;
    this.all.indeterminate = count > 0 && count < this.tunnelRows.length;
    this.all.disabled = !checked(this.group) || this.tunnelRows.length === 0;
    this.tunnelRows.forEach(function(row) { row.input.disabled = !checked(this.group); }, this);
    this.autoFields.hidden = !checked(this.group);
    this.count.textContent = count+' из '+this.tunnelRows.length+' выбрано';
    this.filterTunnels();
    this.updateSummary();
  },

  renderTunnels: function() {
    var self = this;
    this.active.replaceChildren(); this.list.replaceChildren(); this.tunnelRows = [];
    this.profile.tunnels.forEach(function(tunnel) {
      self.active.appendChild(E('option', { value: tunnel.id }, tunnel.name));
      var input = checkbox(self.profile.routing.failoverTunnelIds.includes(tunnel.id), function() { self.updateAll(); });
      input.setAttribute('aria-label', 'Включить в группу: ' + tunnel.name);
      var address = (tunnel.server || tunnel.endpointHost) + ':' + (tunnel.serverPort || tunnel.endpointPort);
      var element = E('div', { 'class': 'ob-server' }, [input,
        E('div', { 'class': 'ob-server-content' }, [E('strong', { 'class': 'ob-server-name', title: tunnel.name }, tunnel.name),
          E('div', { 'class': 'ob-server-meta' }, [E('span', { 'class': 'ob-protocol-tag' }, tunnel.type.toUpperCase()), E('span', {}, address)])]),
        E('button', { type: 'button', 'class': 'ob-delete', title: 'Удалить подключение', 'aria-label': 'Удалить: ' + tunnel.name, click: function() {
          self.collectSelection(); self.profile.tunnels = self.profile.tunnels.filter(function(item) { return item.id !== tunnel.id; });
          self.renderTunnels(); self.markDirty();
        } }, '×')]);
      self.tunnelRows.push({ id: tunnel.id, input: input, element: element, search: (tunnel.name + ' ' + tunnel.type + ' ' + address).toLowerCase() });
      self.list.appendChild(element);
    });
    this.active.value = this.profile.routing.activeTunnelId || (this.profile.tunnels[0] || {}).id || '';
    if (!this.active.value && this.profile.tunnels.length) this.active.value = this.profile.tunnels[0].id;
    if (!this.profile.tunnels.length) this.active.appendChild(E('option', { value: '' }, 'Сначала добавьте подключение'));
    this.tunnelTotal.textContent = 'Всего: ' + this.profile.tunnels.length;
    this.serverSearch.disabled = this.profile.tunnels.length === 0;
    this.updateAll(); this.filterTunnels();
  },

  collectSelection: function() {
    this.profile.routing.activeTunnelId = this.active.value;
    this.profile.routing.failoverTunnelIds = this.tunnelRows.filter(function(row) { return row.input.checked; }).map(function(row) { return row.id; });
  },

  importConnections: function() {
    var self = this, text = this.importText.value.trim(), mode = this.importMode.value;
    return Promise.resolve().then(function() {
      if (mode === 'subscription' && /^https?:\/\/\S+$/i.test(text)) {
        return subscription(text).then(function(result) {
          if (!result.ok) throw new Error(result.error);
          return new TextDecoder().decode(Uint8Array.from(atob(result.base64), function(character) { return character.charCodeAt(0); }));
        });
      }
      return text;
    }).then(function(source) {
      var incoming = mode === 'wireguard' ? [core.parseWireGuard(source, 'WireGuard')]
        : (mode === 'connection' ? [core.parseUri(source)] : core.parseSubscription(source));
      if (incoming.some(function(tunnel) { return tunnel.type === 'awg'; })) throw new Error('AmneziaWG пока не поддерживается пакетом OpenWrt.');
      if (incoming.some(function(tunnel) { return tunnel.type === 'wireguard'; }) && self.lastStatus.wireguard === false) {
        throw new Error('Сначала выберите WireGuard или все протоколы в разделе «Протоколы» и установите полное ядро.');
      }
      var result = core.mergeSubscription(self.profile.tunnels, incoming);
      self.collectSelection(); self.profile.tunnels.push.apply(self.profile.tunnels, result.tunnels);
      if (!self.profile.routing.activeTunnelId && self.profile.tunnels.length) self.profile.routing.activeTunnelId = self.profile.tunnels[0].id;
      self.importText.value = ''; self.importDetails.open = false; self.renderTunnels(); self.markDirty();
      ui.addNotification(null, E('p', {}, 'Добавлено: ' + result.tunnels.length + '. Дубликатов: ' + result.duplicates + '. Сохраните настройки.'), 'info');
    }).catch(function(error) { ui.addNotification(null, E('p', {}, error.message), 'error'); });
  },

  operation: function(call) {
    var self = this;
    ui.showModal('Обход', [E('p', { 'class': 'spinning' }, 'Применяем настройки…')]);
    return call().then(function(result) {
      if (!result.ok) throw new Error(result.error || 'Операция не завершена.');
      return status().then(function(value) { self.updateStatus(value); return true; });
    }).catch(function(error) { ui.addNotification(null, E('p', {}, error.message), 'error'); return false; }).finally(function() { ui.hideModal(); });
  },

  save: function(run) {
    var self = this;
    return Promise.resolve().then(function() {
      if (self.lastStatus.coreBusy || self.lastStatus.updateBusy || self.lastStatus.jobBusy) throw new Error(self.busyReason());
      if (self.domainBulkText.value!==self.domainBulkBaseline) throw new Error('В массовом редакторе есть черновик. Нажмите «Заменить полный список доменов» или отмените изменения.');
      if (checked(self.dnsEnabled) && !self.lastStatus.dnsPoolReady) throw new Error('Сначала нажмите «Подготовить DNS» в разделе «Сеть».');
      self.collectSelection();
      self.profile.routing.failoverEnabled = checked(self.group);
      if (checked(self.group) && self.profile.routing.failoverTunnelIds.length < 2) throw new Error('Выберите минимум два подключения для группы.');
      self.profile.routing.failoverInterval = self.interval.value;
      self.profile.routing.failoverTolerance = Number(self.tolerance.value);
      var testAddress=new URL(self.testUrl.value.trim());
      if(!['http:','https:'].includes(testAddress.protocol) || testAddress.username || testAddress.password) throw new Error('Укажите URL проверки HTTP(S) без пароля.');
      self.profile.routing.testUrl=testAddress.href;
      self.profile.routing.updateInterval=self.listInterval.value;
      self.profile.routing.dnsResolverEnabled = checked(self.dnsEnabled);
      self.profile.routing.dnsProtocol = self.dnsProtocol.value;
      self.profile.routing.dnsServer = self.dnsServer.value.trim();
      self.profile.routing.dnsBootstrap = self.dnsBootstrap.value.trim();
      self.profile.routing.dnsPath = self.dnsPath.value.trim();
      self.profile.routing.dnsTtl = Number(self.dnsTtl.value);
      self.profile.routing.enableDiagnostics = checked(self.verboseLogs);
      self.profile.routing.presetIds = Object.keys(self.presetInputs).filter(function(id) { return checked(self.presetInputs[id]); });
      self.profile.routing.localLists = [{ id: 'router-local', name: 'Свои сайты', enabled: true, domains: domains(self.domainText.value), cidrs: lines(self.cidrText.value) }];
      self.profile.routing.remoteLists = lines(self.remoteText.value).map(function(url, index) {
        return { id: 'remote-' + index, name: 'Внешний список ' + (index + 1), enabled: true, kind: 'domains', url: url };
      });
      self.options = { interfaces: lines(self.interfaces.value), manageDns: checked(self.manageDns), ipv6: checked(self.ipv6),disableQuic:checked(self.disableQuic),downloadListsViaProxy:checked(self.downloadLists),
        dnsPoolMode:self.dnsPoolMode.value,dnsUpstreams:self.dnsUpstreams.value.split(/\r?\n/).map(function(v){return v.trim();}).filter(Boolean),
        dnsBootstrapServers:self.dnsBootstrapServers.value.split(/\r?\n/).map(function(v){return v.trim();}).filter(Boolean) };
      self.profile = core.validate(self.profile);
      Object.keys(self.presetInputs).forEach(function(id) { self.presetInputs[id].checked = self.profile.routing.presetIds.includes(id); });
      var config = core.generate(self.profile, self.options);
      var payload = JSON.stringify({ version: 1, profile: self.profile, options: self.options, config: config });
      if (new TextEncoder().encode(payload).length > 196608) {
        throw new Error('Профиль превышает 192 КБ. Удалите неиспользуемые подключения.');
      }
      return self.operation(function() { return self.uploadSettings(payload, !!run); }).then(function(success) { if (success) { self.markDirty(true); self.updatePresets();self.renderDomains();self.captureDraft(); } });
    }).catch(function(error) { ui.addNotification(null, E('p', {}, error.message), 'error'); });
  },

  uploadSettings: function(payload, run) {
    var bytes=new TextEncoder().encode(payload), token, index=0;
    return upload('begin','','',0).then(function(result) {
      if(!result.ok) throw new Error(result.error);
      token=result.upload;
      function next() {
        if(index*12288 >= bytes.length) return apply('',run,token);
        var block=bytes.subarray(index*12288,(index+1)*12288), text='';
        for(var i=0;i<block.length;i++) text+=String.fromCharCode(block[i]);
        return upload('chunk',token,btoa(text),index).then(function(part) {
          if(!part.ok) throw new Error(part.error);
          index++; return next();
        });
      }
      return next();
    }).finally(function(){if(token) return upload('discard',token,'',0).catch(function(){});});
  },

  handleSave: function() { return this.save(false); },
  handleSaveApply: function() { return this.save(true); },
  addFooter: function() { return E('div'); },
  handleReset: function() { window.location.reload(); }
});
