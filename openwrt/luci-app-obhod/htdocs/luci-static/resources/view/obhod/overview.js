'use strict';
'require view';
'require rpc';
'require fs';
'require ui';
'require poll';
'require obhod.core as core';

var status = rpc.declare({ object: 'obhod', method: 'status', nobatch: true });
var apply = rpc.declare({ object: 'obhod', method: 'apply', params: ['settings', 'start', 'upload'], nobatch: true });
var upload = rpc.declare({ object: 'obhod', method: 'upload', params: ['action', 'upload', 'data', 'index'], nobatch: true });
var stop = rpc.declare({ object: 'obhod', method: 'stop', nobatch: true });
var subscription = rpc.declare({ object: 'obhod', method: 'subscription', params: ['url'], nobatch: true });
var installCore = rpc.declare({ object: 'obhod', method: 'installCore', params: ['profile'], nobatch: true });
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
function card(title, description, content) {
  return E('section', { 'class': 'ob-card' }, [E('div', { 'class': 'ob-card-heading' }, [
    E('h3', {}, title), description ? E('p', { 'class': 'ob-help' }, description) : ''])].concat(Array.isArray(content) ? content : [content]));
}
function switchField(title, input, help) {
  return E('label', { 'class': 'ob-switch-row' }, [E('span', {}, [E('strong', {}, title),
    help ? E('span', { 'class': 'ob-help' }, help) : '']), input]);
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
        return Promise.all([fs.read('/etc/obhod/defaults.json').catch(function() { return ''; }), interfaces().catch(function() { return {devices:[]}; }), coreSizes().catch(function(){return {};})])
          .then(function(extra) { return [state, text, extra[0], extra[1], extra[2]]; });
      });
    });
  },

  render: function(data) {
    var self = this, saved;
    this.loadedVersion = data[0].obhodVersion;
    this.coreSizes = data[4] || {};
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
    this.protocols = E('select', { change: function() { self.updateProtocolHelp(); } }, [E('option', { value: 'proxy' }, 'Прокси · облегчённое ядро'),
      E('option', { value: 'wireguard' }, 'WireGuard · полное ядро'), E('option', { value: 'all' }, 'Все протоколы · полное ядро')]);
    this.protocols.value = data[0].coreFlavor === 'sing-box' ? 'all' : 'proxy';
    this.protocolHelp = E('p', { 'class': 'ob-note' });
    this.coreHint = E('p', { 'class': 'ob-help' });
    this.coreButton = E('button', { type: 'button', 'class': 'cbi-button ob-button ob-primary', click: ui.createHandlerFn(this, this.installProtocols) }, 'Установить выбранное ядро');
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
      E('option',{value:'single'},'Один сервер'), E('option',{value:'parallel'},'Параллельный опрос · первый ответ'),
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
    })},'Подготовить DNS-группы');
    this.dnsPrepareHint = E('p',{'class':'ob-help'});
    this.verboseLogs = checkbox(routing.enableDiagnostics);
    this.diagnosticRows = E('div',{'class':'ob-diagnostic-rows'});
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
      ['Сети', ['cloudflare', 'hetzner', 'ovh', 'digitalocean', 'cloudfront']] ].forEach(function(group, index) {
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
      section.open = index < 2;
      presets.appendChild(section);
    });
    this.presetCount = E('span', { 'class': 'ob-counter' });
    this.autoFields = E('div', { 'class': 'ob-grid ob-auto-fields' }, [field('Частота проверки', this.interval), field('Стабильность выбора', this.tolerance)]);
    this.summaryServers = E('strong'); this.summaryRules = E('strong'); this.summaryCore = E('strong');
    this.routeSummary = E('p', { 'class': 'ob-route-name' });
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
    var definitions = [ ['overview', 'Обзор'], ['connections', 'Подключения'], ['rules', 'Правила'], ['protocols', 'Протоколы'], ['network', 'Сеть'], ['diagnostics', 'Диагностика'] ];
    definitions.forEach(function(entry, index) {
      self.tabs[entry[0]] = E('button', { type: 'button', role: 'tab', id: 'obhod-tab-' + entry[0], 'aria-controls': 'obhod-panel-' + entry[0],
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
    function jump(tab, title) { return E('button', { type: 'button', 'class': 'ob-text-button', click: function() { self.selectTab(tab); } }, title + ' →'); }
    this.panels.overview.appendChild(card('Маршрутизация', 'Только выбранные сайты и подсети идут через Обход. Остальной трафик — напрямую.', [
      E('div', { 'class': 'ob-route-overview' }, [E('span', { 'class': 'ob-eyebrow' }, 'Активный сервер'),
        E('div', { 'class': 'ob-route-active' }, [this.overviewLiveRoute, this.overviewLiveDelay]), this.routeSummary]),
      E('div', { 'class': 'ob-inline-actions' }, [jump('connections', 'Подключения'), jump('rules', 'Правила')]) ]));
    var stats = E('div', { 'class': 'ob-stats' });
    [['connections', 'Подключения', this.summaryServers], ['rules', 'Готовые списки', this.summaryRules], ['protocols', 'Ядро протоколов', this.summaryCore]].forEach(function(item) {
      stats.appendChild(E('button', { type: 'button', 'class': 'ob-stat', click: function() { self.selectTab(item[0]); } }, [E('span', { 'class': 'ob-help' }, item[1]), item[2], E('span', { 'class': 'ob-stat-arrow', 'aria-hidden': 'true' }, '↗')]));
    });
    this.panels.overview.appendChild(stats); this.panels.overview.appendChild(this.setup);
    this.updateDetails = E('details', { 'class': 'ob-card ob-update-details' }, [
      E('summary', {}, [E('span', { 'class': 'ob-update-summary-main' }, [
        E('strong', {}, 'Обновления Обхода'), this.updateSummaryMessage
      ]), E('span', { 'class': 'ob-update-summary-meta' }, [this.updateBadge, this.updateVersion])]),
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
    this.panels.connections.appendChild(this.importDetails);
    var connectionGrid = E('div', { 'class': 'ob-connections-grid' });
    connectionGrid.appendChild(card('Выбор маршрута', '', [field('Основное подключение', this.active),
      switchField('Автоматический выбор', this.group, 'Все выбранные туннели используют общие правила. Обход переключится на рабочее соединение.'), this.autoFields,
      field('URL проверки соединений',this.testUrl,'Обычно адрес с ответом HTTP 204. Не все сайты доступны с каждого VPN-адреса.') ]));
    connectionGrid.appendChild(card('Серверы', 'Для автоматического выбора отметьте минимум два подключения.', [
      E('div', { 'class': 'ob-list-toolbar' }, [E('label', { 'class': 'ob-check-label' }, [this.all, E('span', {}, 'Выбрать все')]), this.count, this.tunnelTotal]),
      this.serverSearch, this.list, this.serverEmpty]));
    this.panels.connections.appendChild(connectionGrid);
    this.panels.rules.appendChild(card('Свои сайты и подсети', 'Общие правила для всех туннелей.', [this.buildDomainEditor(),
      E('details',{'class':'ob-details'},[E('summary',{},'IP и подсети'),field('IP и подсети',this.cidrText,'Например, 203.0.113.0/24.')])]));
    this.panels.rules.appendChild(card('Готовые списки', 'Выберите сервисы и категории для маршрутизации.', [this.presetCount, presets,
      E('p', { 'class': 'ob-note ob-note-compact' }, 'Можно выбрать один регион. Несовместимые списки отключаются автоматически.'),
      field('Обновлять списки',this.listInterval),switchField('Скачивать списки через туннель',this.downloadLists,'Использовать выбранное соединение для загрузки внешних наборов.') ]));
    this.panels.rules.appendChild(card('Внешние списки', 'Бинарный .srs или source .json в формате sing-box.', [field('Ссылки на списки', this.remoteText, 'HTTPS-ссылки на .srs или .json, по одной в строке. Домены из обычного текста вставляйте в «Домены и сайты».'),
      E('details',{'class':'ob-details'},[E('summary',{},'Примеры форматов'),E('pre',{'class':'ob-code'},'Домены: example.org\nПодсети: 203.0.113.0/24\nВнешний список: https://example.org/rules.srs\nSource JSON: {"version":3,"rules":[{"domain_suffix":["example.org"]}]}')]) ]));
    this.panels.protocols.appendChild(card('Ядро протоколов', 'Выберите, какие подключения будут доступны на роутере.', [this.coreState,
      field('Набор протоколов', this.protocols), this.protocolHelp, this.coreButton, this.coreHint,
      E('details', { 'class': 'ob-details' }, [E('summary', {}, 'О размере установки'), E('p', { 'class': 'ob-help' }, 'Прокси используют sing-box-tiny, WireGuard — полный sing-box. Протоколы входят в общее ядро: выбор одного не уменьшает его дальше. Перед установкой проверяется место; малый объём ОЗУ вызывает предупреждение.')]) ]));
    this.panels.network.appendChild(card('Локальная сеть', 'Выберите входящие LAN/guest-интерфейсы. WAN обычно добавлять не нужно.', [field('Интерфейсы роутера',this.interfaceSelect),field('Выбранные устройства / ручной ввод', this.interfaces, 'Обычно br-lan. Несколько имён укажите через запятую.')]));
    this.dnsSingleFields = E('div',{'class':'ob-grid'},[field('Провайдер',this.dnsPreset),field('Протокол',this.dnsProtocol),field('DNS-сервер',this.dnsServer),field('Bootstrap IPv4',this.dnsBootstrap),this.dnsPathField]);
    this.dnsPoolFields = E('div',{},[field('DNS-серверы группы',this.dnsUpstreams,'От двух до четырёх серверов, по одному в строке: IP, udp://, tcp://, tls:// или https:// с путём DoH.'),
      E('p',{'class':'ob-note'},'В параллельном режиме запрос получают все серверы, возвращается первый ответ. Выбирайте серверы с одинаковой фильтрацией.'),
      field('Bootstrap DNS',this.dnsBootstrapServers,'До четырёх IP-адресов, по одному в строке. Разрешают имена DNS-серверов, серверов туннелей и узлов загрузки списков. При нескольких адресах используется тот же режим опроса.'),this.dnsPrepareButton,this.dnsPrepareHint]);
    this.dnsSettings = E('div',{'class':'ob-dns-settings'},[field('Режим опроса DNS',this.dnsPoolMode),this.dnsSingleFields,this.dnsPoolFields]);
    this.dnsTtlField = field('TTL выбранных доменов, секунд',this.dnsTtl,'Обычно 60. После перезагрузки роутера старые служебные адреса в кэше устройств должны истечь.');
    this.panels.network.appendChild(card(this.dnsHeading, 'Роутер отвечает на DNS-запросы устройств локальной сети.', [this.dnsHint,switchField(this.dnsSwitchCaption,this.dnsEnabled,this.dnsSwitchHelp),
      this.dnsSettings,this.dnsTtlField,
      E('p',{'class':'ob-help ob-dns-hint'},'После изменения сохраните настройки. DNS и HTTPS-маршрут можно проверить в «Диагностике».')]));
    this.panels.network.appendChild(card('DNS и IPv6', '', [
      switchField('Настраивать DNS автоматически', this.manageDns, 'При выключении Обход вернёт прежние DNS-серверы. Поддерживается один экземпляр dnsmasq.'),
      switchField('Перехватывать IPv6', this.ipv6, 'Включайте, если IPv6 используется в вашей сети.'),
      switchField('Отключить QUIC',this.disableQuic,'Отклонять UDP на порту 443, чтобы браузеры использовали TCP. На работу самого туннеля не влияет.'),
      E('details', { 'class': 'ob-details' }, [E('summary', {}, 'Ручная настройка DNS'), E('p', { 'class': 'ob-help' }, 'При выключенной автоматической настройке укажите upstream dnsmasq: 127.0.0.1#1053. Для FakeIP отключите кэш dnsmasq (cachesize=0). Устройства должны использовать DNS этого роутера.')]) ]));
    this.panels.diagnostics.appendChild(card('Проверка службы', 'Конфигурация, LAN, перехват, DNS и реальный HTTPS-запрос через выбранный сервер.', [this.diagnosticButton,this.diagnosticMessage,this.diagnosticRows]));
    this.logDetails = E('details',{'class':'ob-log-details'},[E('summary',{},'Просмотреть журнал'),
      E('div',{'class':'ob-log-body'},[E('div',{'class':'ob-inline-actions'},[E('button',{type:'button','class':'cbi-button ob-button',click:ui.createHandlerFn(this,function(){return self.refreshLogs();})},'Обновить'),E('button',{type:'button','class':'cbi-button ob-button',click:ui.createHandlerFn(this,function(){return clearLogs().then(function(){return self.refreshLogs();});})},'Очистить')]),this.logText])]);
    this.logDetails.addEventListener('toggle', function() { if (self.logDetails.open) self.refreshLogs(); });
    this.panels.diagnostics.appendChild(card('Журнал службы', 'До 32 КБ в ОЗУ, без записи во flash, секреты скрываются. После перезагрузки журнал очищается.', [
      switchField('Подробный журнал',this.verboseLogs,'По умолчанию сохраняются только предупреждения и ошибки.'),
      this.logDetails ]));
    this.serviceButton = E('button', { type: 'button', 'class': 'cbi-button ob-button ob-service-button', click: ui.createHandlerFn(this, this.toggleService) }, 'Включить');
    this.applyButton = E('button', { type: 'button', 'class': 'cbi-button ob-button ob-primary', click: ui.createHandlerFn(this, function() { return self.save(true); }) }, 'Сохранить и включить');
    this.saveButton = E('button',{type:'button','class':'cbi-button ob-button ob-primary',click:ui.createHandlerFn(this,function(){return self.save(false);})},'Сохранить');
    this.cancelButton = E('button',{type:'button','class':'cbi-button ob-button',click:ui.createHandlerFn(this,this.cancelChanges)},'Отменить');
    this.operationTitle=E('strong');this.operationMessage=E('p',{'class':'ob-help'});
    this.operationNotice=E('div',{'class':'ob-operation-notice',role:'status','aria-live':'polite'},[this.operationTitle,this.operationMessage]);
    this.footer = E('footer', { 'class': 'ob-footer' }, [this.dirtyState, E('div', { 'class': 'ob-footer-actions' }, [
      this.cancelButton,this.saveButton,this.applyButton])]);
    this.root = E('div', { 'class': 'cbi-map obhod-app' }, [E('link', { rel: 'stylesheet', href: L.resource('obhod/overview.css') }),
      E('header', { 'class': 'ob-header' }, [E('div', { 'class': 'ob-brand' }, [E('span', { 'class': 'ob-mark', 'aria-hidden': 'true' }, '↗'),
        E('div', {}, [E('h2', {}, 'Обход'), E('p', { 'class': 'ob-help' }, 'Ваш маршрут к нужным сайтам')])]),
        E('div', { 'class': 'ob-header-status' }, [this.state, this.statusDetail, this.routeDetail, this.serviceButton])]),
      this.operationNotice,nav, panels, this.footer ]);
    function changed(event) { if (![self.serverSearch,self.domainSearch,self.domainEntry,self.domainView].includes(event.target) && !self.panels.protocols.contains(event.target)) self.markDirty(); }
    this.root.addEventListener('input',changed);this.root.addEventListener('change',changed);
    var background = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);
    if (background && Number(background[3] === undefined ? 1 : background[3]) > 0) {
      this.root.classList.toggle('ob-dark', (Number(background[0]) * 299 + Number(background[1]) * 587 + Number(background[2]) * 114) / 1000 < 128);
    } else this.root.classList.toggle('ob-dark', window.matchMedia('(prefers-color-scheme: dark)').matches);
    this.renderTunnels();
    this.updatePresets(); this.updateProtocolHelp(); this.updateDnsFields(); this.selectTab('overview');
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
    var fresh = Number(value.routeCheckedAt) > 0 && Date.now()/1000 - Number(value.routeCheckedAt) < 90;
    this.liveRoute.textContent = !value.running ? 'Маршрут неактивен' : value.routeName || 'Проверяем маршрут…';
    this.liveDelay.textContent = value.running && fresh ? (value.routeOk && value.routeDelay !== '' ? value.routeDelay + ' мс' : 'нет ответа') : '';
    this.overviewLiveRoute.textContent = this.liveRoute.textContent;
    this.overviewLiveDelay.textContent = this.liveDelay.textContent;
    this.routeDetail.title = fresh ? 'HTTPS-проверка: ' + new Date(Number(value.routeCheckedAt)*1000).toLocaleTimeString('ru-RU') : 'Проверка маршрута выполняется раз в 30 секунд.';
    this.coreState.textContent = (value.coreFlavor || (value.version ? 'Своё ядро sing-box' : 'Ядро не установлено'))
      + (value.coreMessage ? ' · ' + value.coreMessage : '');
    this.coreButton.disabled = !!(value.running || value.coreBusy || value.updateBusy || value.jobBusy);
    this.protocols.disabled = !!value.coreBusy;
    this.coreHint.textContent = value.coreBusy ? 'Идёт установка. Состояние обновляется автоматически.' : value.running
      ? 'Перед сменой ядра выключите Обход кнопкой вверху.' : 'После установки сохраните настройки и включите Обход.';
    this.updateSummary();
    this.updateControls();
    this.diagnosticButton.disabled = !!(value.coreBusy || value.updateBusy || value.jobBusy);
    this.diagnosticMessage.textContent = value.jobMessage || 'Проверка использует сохранённые настройки.';
  },

  updateControls: function() {
    if (!this.lastStatus) return;
    var state = this.lastStatus, busy = !!(state.updateBusy || state.coreBusy || state.jobBusy);
    this.dnsPrepareButton.hidden = state.dnsPoolReady === true;
    this.dnsPrepareButton.disabled = busy;
    this.dnsPrepareHint.textContent = state.dnsPoolReady ? 'DNS-группы готовы к работе.' : 'Для групп один раз установите небольшой дополнительный компонент из репозитория OpenWrt.';
    this.operationNotice.hidden=!busy;
    this.operationTitle.textContent=state.coreBusy?'Установка ядра протоколов':state.updateBusy?'Обновление Обхода':'Операция службы';
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
    });
    if (id === 'diagnostics') this.refreshDiagnostics();
  },

  updateDnsFields: function() {
    var enabled = checked(this.dnsEnabled);
    this.dnsHeading.textContent='DNS и маршрутизация FakeIP';
    this.dnsSwitchCaption.textContent='Настроить общий DNS';
    this.dnsSwitchHelp.textContent=this.dnsPoolMode.value==='single'?'Этот сервер используется для обычных доменов. По умолчанию — UDP 1.1.1.1.':'Для обычных доменов используется группа DNS. DNS выбранных сайтов сохраняет маршрут через туннель.';
    this.dnsHint.textContent='Выбранным доменам выдаются служебные IP. Обычные сайты получают реальные адреса и идут напрямую. Устройства должны использовать DNS роутера; соответствия хранятся в /tmp.';
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
      self.diagnosticRows.replaceChildren();
      (result.checks || []).forEach(function(check){ self.diagnosticRows.appendChild(E('div',{'class':'ob-diagnostic-row'},[
        E('strong',{},check.name),E('span',{'class':check.ok?'ob-check-ok':'ob-check-fail'},check.ok?'Готово':'Проверьте'),E('p',{'class':'ob-help'},check.message)])); });
      if(result.note) self.diagnosticRows.appendChild(E('p',{'class':'ob-note'},result.note));
    }).catch(function(){self.diagnosticMessage.textContent='Не удалось прочитать диагностику. Повторите запрос.';}).finally(function(){self.diagnosticsLoading=false;});
    return this.diagnosticsPromise;
  },

  refreshLogs: function() {
    var self=this;
    if(this.logsLoading) return this.logsPromise;
    this.logsLoading=true;
    this.logsPromise=logs().then(function(result){
      self.logText.textContent=result.text || 'Журнал пока пуст.';
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
    this.domainCount=E('span',{'class':'ob-counter'});
    this.domainSearch=E('input',{type:'search',placeholder:'Найти домен…','aria-label':'Поиск своих доменов',input:function(){self.domainPage=0;self.renderDomains();}});
    this.domainEntry=E('input',{type:'text',placeholder:'example.org или https://example.org',keydown:function(event){if(event.key==='Enter'){event.preventDefault();self.addDomain();}}});
    this.domainView=E('select',{'aria-label':'Вид списка доменов',change:function(){
      var text=self.domainView.value==='text';self.domainBulk.hidden=!text;self.domainListMode.hidden=text;
      if(!text)self.renderDomains();
    }},[E('option',{value:'list'},'Компактный список'),E('option',{value:'text'},'Массовое редактирование')]);
    this.domainRows=E('div',{'class':'ob-domain-rows'});
    this.domainError=E('p',{'class':'ob-help ob-domain-error','aria-live':'polite'});
    this.domainPager=E('span',{'class':'ob-help'});
    this.domainPrev=E('button',{type:'button','class':'cbi-button ob-button',click:function(){self.domainPage--;self.renderDomains();}},'Назад');
    this.domainNext=E('button',{type:'button','class':'cbi-button ob-button',click:function(){self.domainPage++;self.renderDomains();}},'Далее');
    this.domainListMode=E('div',{},[
      E('div',{'class':'ob-domain-toolbar'},[this.domainSearch,this.domainCount]),
      E('div',{'class':'ob-domain-add'},[this.domainEntry,E('button',{type:'button','class':'cbi-button ob-button',click:function(){self.addDomain();}},'Добавить')]),
      this.domainRows,this.domainError,E('div',{'class':'ob-domain-pages'},[this.domainPrev,this.domainPager,this.domainNext])]);
    this.domainBulk=field('Домены и сайты',this.domainText,'Домены или URL, по одному в строке. Можно вставить весь список сразу.');
    this.domainBulk.hidden=true;
    this.renderDomains();
    return E('div',{'class':'ob-domain-editor'},[field('Редактор доменов',this.domainView),this.domainListMode,this.domainBulk]);
  },

  renderDomains: function() {
    var self=this, values;
    this.domainRows.replaceChildren();
    try {values=Array.from(new Set(domains(this.domainText.value)));this.domainError.textContent='';}
    catch(error){this.domainError.textContent=error.message;this.domainCount.textContent='Проверьте текст списка';this.domainPrev.disabled=true;this.domainNext.disabled=true;return;}
    var query=this.domainSearch.value.trim().toLowerCase(), filtered=values.filter(function(value){return value.toLowerCase().includes(query);});
    var pages=Math.max(1,Math.ceil(filtered.length/50));this.domainPage=Math.max(0,Math.min(this.domainPage,pages-1));
    this.domainCount.textContent=query?'Найдено: '+filtered.length+' из '+values.length:'Доменов: '+values.length;
    filtered.slice(this.domainPage*50,(this.domainPage+1)*50).forEach(function(value){
      self.domainRows.appendChild(E('div',{'class':'ob-domain-row'},[E('span',{title:value},value),
        E('button',{type:'button','class':'ob-delete','aria-label':'Удалить домен '+value,title:'Удалить',click:function(){
          self.domainText.value=values.filter(function(item){return item!==value;}).join('\n');self.markDirty();self.renderDomains();
        }},'×')]));
    });
    if(!filtered.length)this.domainRows.appendChild(E('p',{'class':'ob-help ob-domain-empty'},query?'По этому запросу ничего не найдено.':'Добавьте домен или вставьте список в режиме массового редактирования.'));
    this.domainPager.textContent=filtered.length?'Страница '+(this.domainPage+1)+' из '+pages:'';
    this.domainPrev.disabled=this.domainPage===0;this.domainNext.disabled=this.domainPage>=pages-1;
  },

  addDomain: function() {
    try {
      var added=domains(this.domainEntry.value);if(!added.length)return;
      this.domainText.value=Array.from(new Set(domains(this.domainText.value).concat(added))).join('\n');
      this.domainEntry.value='';this.domainSearch.value='';this.domainPage=0;this.markDirty();this.renderDomains();
    } catch(error){this.domainError.textContent=error.message;}
  },

  captureDraft: function() {
    var self=this;
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
    this.importText.value='';this.domainEntry.value='';this.domainPage=0;
    this.renderTunnels();this.updatePresets();this.updateDnsFields();this.renderDomains();this.markDirty(true);
  },

  updateProtocolHelp: function() {
    this.protocolHelp.textContent = this.protocols.value === 'proxy'
      ? 'VLESS/Reality, Shadowsocks, Trojan, Hysteria2, TUIC, AnyTLS, SOCKS и HTTP. Подходит для роутеров с небольшим объёмом памяти.'
      : this.protocols.value === 'wireguard' ? 'Поддержка WireGuard. Требуется полное ядро; прокси-протоколы также останутся доступны.'
        : 'Прокси-протоколы и WireGuard.';
    var size=this.coreSizes[this.protocols.value==='proxy'?'lite':'full'];
    function mb(bytes){return (bytes/1048576).toLocaleString('ru-RU',{maximumFractionDigits:1});}
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
    this.summaryServers.textContent = String(this.profile.tunnels.length);
    this.summaryRules.textContent = String(count);
    this.summaryCore.textContent = state.coreBusy ? 'Установка…' : state.coreFlavor === 'sing-box-tiny' ? 'Облегчённое' : state.coreFlavor === 'sing-box' ? 'Полное' : state.version ? 'Установлено' : 'Не установлено';
    var active = this.profile.tunnels.find(function(tunnel) { return tunnel.id === self.active.value; });
    this.routeSummary.textContent = !this.profile.tunnels.length ? 'Добавьте первое подключение'
      : checked(this.group) ? 'Автоматический выбор · серверов: ' + this.tunnelRows.filter(function(row) { return checked(row.input); }).length
        : (active ? active.name : 'Выберите основное подключение');
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

  filterTunnels: function() {
    var query = this.serverSearch.value.trim().toLowerCase(), visible = 0;
    this.tunnelRows.forEach(function(row) { row.element.hidden = !row.search.includes(query); if (!row.element.hidden) visible++; });
    this.serverEmpty.hidden = visible > 0;
    this.serverEmpty.textContent = this.tunnelRows.length ? 'По этому запросу серверы не найдены.' : 'Здесь появятся ваши серверы. Добавьте подключение в блоке импорта выше.';
  },

  installProtocols: function() {
    var self = this;
    if (this.lastStatus.running || this.lastStatus.coreBusy || this.lastStatus.updateBusy || this.lastStatus.jobBusy) return Promise.resolve();
    var profile = this.protocols.value === 'proxy' ? 'lite' : 'full';
    return this.operation(function() {
      return installCore(profile).then(function(result) {
        if (result.ok) ui.addNotification(null, E('p', {}, 'Установка запущена. Состояние обновится автоматически; страницу можно оставить открытой.'), 'info');
        return result;
      });
    });
  },

  updateAll: function() {
    var count = this.tunnelRows.filter(function(row) { return row.input.checked; }).length;
    this.all.checked = count > 0 && count === this.tunnelRows.length;
    this.all.indeterminate = count > 0 && count < this.tunnelRows.length;
    this.all.disabled = !checked(this.group) || this.tunnelRows.length === 0;
    this.tunnelRows.forEach(function(row) { row.input.disabled = !checked(this.group); }, this);
    this.autoFields.hidden = !checked(this.group);
    this.count.textContent = 'Выбрано: ' + count;
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
      if (checked(self.dnsEnabled) && self.dnsPoolMode.value !== 'single' && !self.lastStatus.dnsPoolReady) throw new Error('Сначала нажмите «Подготовить DNS-группы» в разделе «Сеть».');
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
