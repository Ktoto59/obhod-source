// SPDX-License-Identifier: Apache-2.0
import { readfile, access } from 'fs';
let work = ARGV[0], settings = json(readfile('/etc/obhod/settings.json') || '{}');
let running = access('/var/run/obhod/ready');
let route = json(readfile('/var/run/obhod/telemetry.json') || '{}');
let devices = settings.options?.interfaces || ['br-lan'];
let missing = filter(devices, name => !access('/sys/class/net/' + name));
let intercept = !!running && !!access('/sys/class/net/obhod-tun') && !!access(work + '/firewall-ok');
let routeOk = !!running && !!route.ok && time() - route.checkedAt < 90;
let checks = [
    { name: 'Конфигурация', ok: access(work + '/config-ok'), message: access(work + '/config-ok') ? 'Ядро принимает сохранённые настройки.' : 'Ядро отклонило конфигурацию или не установлено.' },
    { name: 'Служба', ok: running, message: running ? 'Служба запущена и готова.' : 'Обход выключен. Включите его для проверки маршрута.' },
    { name: 'LAN-интерфейсы', ok: !length(missing), message: length(missing) ? 'Не найдены: ' + join(', ', missing) : 'Найдены: ' + join(', ', devices) },
    { name: 'Перехват трафика', ok: intercept, message: intercept ? 'TUN-интерфейс и таблица sing-box в nftables найдены.' : 'Требуются работающий TUN и таблица sing-box в nftables.' },
    { name: 'DNS роутера', ok: running && access(work + '/dns-ok'), message: access(work + '/dns-ok') ? 'Получен DNS-ответ через локальный dnsmasq.' : 'Нет DNS-ответа. Проверьте настройки DNS и доступ в интернет.' },
    { name: 'HTTPS через подключение', ok: routeOk, message: routeOk ? (route.name + ' · ' + route.delay + ' мс') : 'Не удалось выполнить HTTPS-запрос через выбранный сервер.' }
];
push(checks, {
    name: 'FakeIP через DNS роутера', ok: running && access(work + '/fakeip-ok'),
    message: access(work + '/fakeip-ok') ? 'dnsmasq передаёт служебные адреса. Кэш находится в ОЗУ и сохраняется при перезапуске службы.' : 'Нет служебного адреса. Проверьте управление dnsmasq и сохранённую конфигурацию.'
});
printf('%J\n', { checkedAt: time(), checks, note: 'На клиентском устройстве шлюз и DNS должны указывать на этот роутер. Проверка на роутере не проверяет настройки ПК или телефона.' });
