const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../openwrt/luci-app-obhod/htdocs/luci-static/resources/view/obhod/overview.js'), 'utf8');
const view = new Function('rpc', 'view', source)({ declare: () => () => {} }, { extend: value => value });

test('LuCI keeps the latency, timestamp and age visible across the default threshold', () => {
  const state = { routeCheckedAt: 1000, routeReceivedAt: 1290, routeMaxAge: 300, routeDelay: '83' };
  const fresh = view.routeTelemetry(state, 1300);
  assert.match(fresh.label, /^83 мс · 00:16:40 · 5 мин\./);
  assert.equal(fresh.stale, false);
  const stale = view.routeTelemetry({ ...state, routeReceivedAt: 1301 }, 1301);
  assert.equal(stale.label, fresh.label);
  assert.equal(stale.stale, true);
  // Polling can change receivedAt without moving the measurement timestamp.
  assert.deepEqual(view.routeTelemetry(state, 1400),
    view.routeTelemetry({ ...state, routeReceivedAt: 1400, routeDiagnosedAt: 1400 }, 1400));
});

test('display override uses minutes and restores the automatic threshold when cleared', () => {
  const state = { routeCheckedAt: 1000, routeMaxAge: 15, routeDelay: '72', routeStaleMinutes: '3' };
  assert.equal(view.routeTelemetry(state, 1180).stale, false);
  assert.equal(view.routeTelemetry(state, 1181).stale, true);
  assert.equal(view.routeTelemetry({ ...state, routeStaleMinutes: '' }, 1180).stale, true);
});

test('an unsuccessful recheck is shown separately from the last successful latency', () => {
  const state = { routeCheckedAt: 1000, routeMaxAge: 90, routeFailedAt: 1100, routeDelay: '72' };
  const result = view.routeTelemetry(state, 1101);
  assert.match(result.label, /^72 мс · 00:16:40/);
  assert.equal(result.stale, true);
  assert.match(result.failure, /HTTPS-проверка не удалась/);
  const noSuccess = view.routeTelemetry({ routeFailedAt: 1100 }, 1101);
  assert.equal(noSuccess.label, 'Успешных замеров нет');
  assert.equal(noSuccess.failure, result.failure);
  const switched = view.routeTelemetry({ routeName: 'Другой сервер' }, 1101);
  assert.equal(switched.label, 'Успешных замеров нет');
  assert.equal(switched.stale, false);
  assert.equal(switched.failure, '');
});
