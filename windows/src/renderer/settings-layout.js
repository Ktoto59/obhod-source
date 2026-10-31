// Assemble existing forms into sections without duplicating fields or their state.
(() => {
  const $ = (id) => document.getElementById(id);
  const nav = document.querySelector('.sidebar nav');
  nav.innerHTML = `
    <button class="nav-item active" data-view="home"><span>●</span>Главная</button>
    <button class="nav-item" data-view="settings" data-pane="tunnels"><span>↗</span>Подключения</button>
    <button class="nav-item" data-view="settings" data-pane="routing"><span>☷</span>Сайты и приложения</button>
    <button class="nav-item" data-view="settings" data-pane="general"><span>⚙</span>Настройки</button>
    <button class="nav-item" data-view="help"><span>?</span>Помощь</button>`;
  document.querySelector('.brand small').textContent = 'Выборочное подключение';
  document.querySelector('.home-next-actions').remove();
  $('openQuickHelp').remove();
  document.querySelector('#view-home header p:last-child').textContent = 'Состояние подключения';
  document.querySelector('#view-settings > header').remove();
  const tabs = document.querySelector('.settings-tabs');
  tabs.hidden = true;
  tabs.innerHTML = [ ['general', 'Основные'], ['failover', 'Автовыбор'], ['dns', 'Сеть'], ['backup', 'Перенос настроек'], ['app', 'Обновления'] ]
    .map(([id, title]) => `<button class="settings-tab" data-settings-pane="${id}">${title}</button>`).join('');
  const pane = (id, title, description) => {
    const element = document.createElement('div');
    element.className = 'settings-pane'; element.id = `settings-${id}`;
    element.innerHTML = `<header><div><h1>${title}</h1><p>${description}</p></div></header>`;
    $('view-settings').append(element);
    return element;
  };
  const general = pane('general', 'Основные настройки', 'Запуск приложения и поведение подключения');
  const failover = pane('failover', 'Автоматический выбор', 'Обход сможет переключиться на другое подключение, если текущее недоступно');
  const network = pane('dns', 'Настройки сети', 'Меняйте эти параметры, только если стандартное подключение не подходит');
  pane('backup', 'Перенос настроек', 'Сохраните копию или перенесите Обход на другой компьютер');
  const servicePanel = document.querySelector('[data-routing-section="service"] .panel');
  general.append(servicePanel);
  servicePanel.querySelector('h2').textContent = 'Запуск приложения';
  const startupGrid = servicePanel.querySelector('.form-grid');
  const networkBasics = document.createElement('section'); networkBasics.className = 'panel';
  networkBasics.innerHTML = '<h2>Способ подключения</h2><div class="form-grid routing-grid"></div>';
  network.append(networkBasics);
  const networkGrid = networkBasics.querySelector('.form-grid');
  ['trafficMode', 'listenPort', 'strictRoute'].forEach((id) => networkGrid.append($(id).closest('label')));
  // List refresh belongs with rules, verbose logging belongs with support.
  const refresh = $('updateInterval').closest('label');
  document.querySelector('[data-routing-section="lists"]').append(refresh);
  failover.append(document.querySelector('.failover-panel'));
  network.append(document.querySelector('.dns-resolver-panel'));
  const lists = document.querySelector('[data-routing-section="lists"]');
  lists.className = 'site-lists';
  $('settings-routing').append(lists);
  const policy = document.querySelector('.failure-policy');
  const help = document.createElement('section'); help.className = 'view'; help.id = 'view-help';
  help.innerHTML = `<header><div><h1>Помощь</h1><p>Начало работы и решение проблем</p></div></header>
    <section class="panel"><h2>Как начать пользоваться Обходом</h2><div id="helpGuide"></div></section>
    <section class="panel"><h2>Нужна проверка подключения?</h2><p>Проверьте подключение на странице «Подключения». Если проблема повторяется, откройте журнал и сохраните отчёт для поддержки.</p><button id="openJournal" class="secondary">Открыть журнал</button><div id="helpLogSettings"></div></section>`;
  document.querySelector('main').append(help);
  $('helpGuide').append(document.querySelector('.quick-help-steps'));
  $('helpGuide').querySelectorAll('li')[2].querySelector('p').textContent = 'Откройте «Сайты и приложения». Выберите нужные сервисы из готовых наборов или нажмите «Добавить сайт» в своих списках. Можно вставить адрес страницы целиком. Нажмите «Сохранить», чтобы применить выбор.';
  $('addLocalList').textContent = '+ Добавить сайт';
  $('helpLogSettings').append($('enableDiagnostics').closest('label'));
  help.append(document.querySelector('.setup-guide-panel'));
  help.append(policy);
  $('quickHelpDialog').remove();
  document.querySelector('.routing-tools').remove();
  const saveBar = document.querySelector('.routing-save-bar'); saveBar.hidden = true; $('view-settings').append(saveBar);
  // Advanced DNS and probe details stay available behind a deliberate expansion.
  const details = (parent, title, ids) => {
    const section = document.createElement('details'); section.className = 'advanced-fields';
    section.innerHTML = `<summary>${title}</summary><div class="form-grid routing-grid"></div>`;
    ids.forEach((id) => section.lastChild.append($(id).closest('label')));
    parent.append(section);
  };
  details(document.querySelector('.dns-resolver-panel'), 'Дополнительные параметры DNS', ['dnsProtocol', 'dnsServer', 'dnsBootstrap', 'dnsPath', 'dnsTtl']);
  details(document.querySelector('.failover-panel'), 'Частота проверок и чувствительность', ['failoverInterval', 'failoverTolerance', 'testUrl']);
  document.querySelector('.failover-explainer').remove();
  document.querySelector('.routing-presets h2').textContent = 'Популярные сайты и сервисы';
  document.querySelector('.application-rules-panel h2').textContent = 'Правила для программ';
  document.querySelector('.application-rules-panel .panel-title p:last-child').textContent = 'Выберите программы, которые должны подключаться через Обход';
  document.querySelector('#settings-routing h1').textContent = 'Сайты и приложения';
  document.querySelector('#settings-tunnels h1').textContent = 'Подключения';
  document.querySelector('#settings-app h1').textContent = 'Обновления';
  $('settings-routing').insertBefore(document.querySelector('.routing-presets'), document.querySelector('.application-rules-panel'));
})();
