const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../openwrt/luci-app-obhod/htdocs/luci-static/resources/view/obhod/overview.js'), 'utf8');
const view = new Function('rpc', 'view', source)({ declare: () => () => {} }, { extend: value => value });

test('LuCI uses measurement age and the configured urltest interval', () => {
  const state = {routeCheckedAt:1000, routeReceivedAt:1290, routeMaxAge:300, routeKnown:true, routeOk:true, routeDelay:'83'};
  assert.equal(view.routeTelemetry(state, 1299).label, '83 мс');
  assert.equal(view.routeTelemetry({...state,routeReceivedAt:1301}, 1301).label, 'замер устарел');
  assert.equal(view.routeTelemetry({...state,routeReceivedAt:1400}, 1400).label, 'замер устарел');
  assert.equal(view.routeTelemetry({...state,routeReceivedAt:1000}, 1299).label, 'замер устарел');
});

test('LuCI distinguishes absent history, failed measurement and explicit diagnosis', () => {
  const state = {routeCheckedAt:1000, routeReceivedAt:1000, routeMaxAge:90, routeKnown:true, routeOk:false, routeDelay:''};
  assert.equal(view.routeTelemetry({...state,routeKnown:false}, 1001).label, 'нет замера');
  assert.equal(view.routeTelemetry(state, 1001).label, 'нет ответа');
  assert.equal(view.routeTelemetry(state, 1100).label, 'замер устарел');
  assert.match(view.routeTelemetry({...state,routeDiagnosedAt:1000}, 1001).title, /Явная диагностика/);
});
