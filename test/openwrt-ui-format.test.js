const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../openwrt/luci-app-obhod/htdocs/luci-static/resources/view/obhod/overview.js'), 'utf8');
function view(zone = 'UTC') {
  const page = new Function('rpc', 'view', source)({ declare: () => () => {} }, { extend: value => value });
  page.configureSystemTime({ zonename: zone });
  return page;
}

test('LuCI journal removes terminal colours, cursor codes and OSC links without changing text', () => {
  const esc = '\x1b';
  const raw = `${esc}[33mWARN${esc}[0m ${esc}[38;5;209m[123]${esc}[0m ${esc}[38;2;255;0;0mошибка${esc}[0m\r\n` +
    `${esc}]8;;https://example.org${esc}\\ссылка${esc}]8;;${esc}\\\t${esc}[2Kтекст\u009b31m!\u009b0m\x00\x07`;
  assert.equal(view().formatLogText(raw), 'WARN [123] ошибка\nссылка\tтекст!');
  assert.equal(raw.includes(esc), true);
});

test('LuCI journal preserves ordinary brackets, IPv6, Unicode, newlines and literal markup', () => {
  const raw = 'WARN [ID скрыт] 2001:db8::1 <script>alert(1)</script>\nСлужба: ошибка\n';
  assert.equal(view().formatLogText(raw), raw);
  assert.equal(view().formatLogText('WARN\n\x1b[38;5;'), 'WARN\n');
  assert.equal(view().formatLogText(null), '');
});

test('LuCI journal uses the router IANA timezone, including fractional-hour offsets and DST', () => {
  for (const [zone, input, expected] of [
    ['Asia/Yekaterinburg', '+0000 2026-11-04 08:11:14 WARN', '+0500 2026-11-04 13:11:14 WARN'],
    ['Asia/Kathmandu', '+0000 2026-11-04 08:11:14 WARN', '+0545 2026-11-04 13:56:14 WARN'],
    ['America/New York', '+0000 2026-11-04 08:11:14 WARN', '-0500 2026-11-04 03:11:14 WARN'],
    ['America/New_York', '+0000 2026-07-04 08:11:14 WARN', '-0400 2026-07-04 04:11:14 WARN'],
    ['UTC', '+0530 2026-11-04 00:10:14.125 WARN', '+0000 2026-11-03 18:40:14.125 WARN']
  ]) {
    const page = view(zone);
    assert.equal(page.formatLogText(input), expected, zone);
    assert.equal(page.formatLogText(expected), expected, 'Repeated rendering must not shift time twice');
  }
});

test('LuCI journal explains unavailable system zones and preserves unrecognised timestamps', () => {
  const page = view('Invalid/Timezone');
  assert.equal(page.systemTimeZone, 'UTC');
  assert.equal(page.systemTimeUnavailable, true);
  page.configureSystemTime(null);
  assert.equal(page.systemTimeUnavailable, true);
  assert.equal(page.formatLogText('+9900 2026-11-04 08:11:14 WARN'), '+9900 2026-11-04 08:11:14 WARN');
  assert.equal(page.formatLogText('2026-11-04 08:11:14 WARN'), '2026-11-04 08:11:14 WARN');
});

test('LuCI route and diagnostic times use the same configured router zone', () => {
  const page = view('Asia/Yekaterinburg');
  const epoch = Date.parse('2026-11-04T08:11:14Z') / 1000;
  assert.equal(page.formatSystemTime(epoch, false), '13:11:14');
  assert.match(page.formatSystemTime(epoch, true), /04\.11\.(?:20)?26.*13:11:14/);
  const title = page.routeTelemetry({ routeKnown: true, routeCheckedAt: epoch, routeReceivedAt: epoch }, epoch).title;
  assert.match(title, /Замер: 13:11:14 Получено: 13:11:14/);
});
