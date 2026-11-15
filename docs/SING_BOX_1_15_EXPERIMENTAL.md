# Obhod Experimental на sing-box 1.15

## A. Результаты портирования

Рабочая ветка `experimental/sing-box-1.15` создана от `b104edd`. В базе есть
`c791f37`, ядро `1.13.21-obhod.5` из `55526fe` и подготовка OpenWrt 0.1.20.
Работа выполнена в отдельном worktree. Экспериментальная версия
`1.15.0-alpha.13-obhod.1` закреплена на последнем официальном prerelease 1.15,
найденном на 15 ноября 2026 года. [Релиз upstream](https://github.com/SagerNet/sing-box/releases/tag/v1.15.0-alpha.13).

| Компонент | Версия | Commit SHA |
| --- | --- | --- |
| sing-box | `v1.15.0-alpha.13` | `824dbcfb4dd0a95921840b1737b950cde590241e` |
| sing-tun | `v0.9.7-0.20261023115453-611d83b7a57b` | `611d83b7a57b4719be45581eb674942ff561de6c` |
| sing | `v0.9.7-0.20261023115510-03a6cce64bf7` | `03a6cce64bf744023af9e2691fb11afd405b9061` |

### Аудит патчей

| Патч или механизм | Назначение | Upstream 1.15 | Решение | Тест |
| --- | --- | --- | --- | --- |
| `obhod-pool` | Ограничить параллелизм, вернуть положительный ответ сразу, разрешить конфликт NXDOMAIN/NODATA за 200 мс | DNS `evaluate` поддерживает параллельную оценку ответов. Правила не воспроизводят лимит пула, отмену проигравших запросов и арбитраж | Сохранить общий лимит 64 на группу, окно 200 мс, balanced hedge 350 мс и общий тайм-аут 4 с. Принимать запрос до запуска фоновой горутины в новом `ExchangeAsync` | Go race и реальный DNS-пул |
| DNS RCODE и ID | Не терять NXDOMAIN, REFUSED, SERVFAIL и не смешивать ответы клиентов | Новый транспортный мультиплексор назначает ID в пределах соединения, приложение по-прежнему задаёт политику пула | Сохранить проверку ID и вопроса, в том числе QTYPE и QCLASS, и отменять проигравшие запросы | `TestObhodPool*`, включая одновременные запросы с совпадающими клиентскими ID |
| FakeIP metadata | Ответить только после долговечной записи отображения и курсора | 1.15 сохраняет метаданные при чтении, резервирует адреса группами и буферизует отображения | Использовать транзакцию bbolt с существующими `putFakeIP` и `putFakeIPMetadata`. Проверять восстановленный курсор, при ошибке записи не выдавать адрес | DB reopen, ошибка записи, SIGKILL и повторный запуск |
| UDP NAT | Изолировать DNS от других портов и разных резолверов при совпадающем исходном сокете | Новый sing-tun распознаёт перехваченный DNS до создания NAT и содержит собственный `UDPNat` | Убрать изменения старого `sing/common/udpnat2`. Для UDP/53 вне перехвата использовать адрес назначения и порт в ключе нового NAT. Для остальных портов сохранять выбранный режим NAT | `TestObhodUDPNATDestinationIsolation`, сквозные TCP/UDP и DNS |
| DNS hijack timeout | Независимый тайм-аут DNS и отмена при закрытии соединения | UDP-перехват в Go TUN отвечает на отдельные датаграммы. Обычный packet handler имеет свой обновляемый таймер на 10 с | Убрать хуки старого `SetTimeout`. Привязать асинхронные обмены packet handler к его контексту и вернуть обработанные метаданные пакета в пул | `TestObhodDNSPacketExchangeCanceledOnClose`, ресурсные тесты пула |
| `auto_redirect`, `route_address_set` | Выполнить отбор до NFQUEUE в Linux | Alpha.13 на Linux проверяет динамический набор в пользовательском pre-match. Обновление kernel address set в этой ревизии подключено для Android VPN | Вернуть именованные IPv4/IPv6 sets, атомарно обновлять снимок и применять те же фильтры к pre-match и downstream redirect. DNS DNAT выполняется раньше отбора | Счётчики nftables для LAN/router output, JSON/SRS и замена правил на ходу |
| NFQUEUE после SIGKILL | Блокировать выбранный трафик при оставшихся правилах и пропавшем TUN | Queue bypass и возврат к main при отсутствии TUN возможны в upstream | Для выборочного Obhod убрать queue bypass. На postrouting блокировать input mark при выходе через другой интерфейс | Новые TCP/UDP соединения к выбранному адресу во время простоя после SIGKILL, обычные соединения проходят |
| 31-битный индекс таблицы | Исключить переполнение int на MIPS | `chooseRouteTableIndex` уже маскирует индекс и обходит занятые таблицы | Убрать патч и использовать upstream | Сборка и запуск MIPS ELF под QEMU |
| Владение redirect routes | Восстановиться после SIGKILL, сохраняя чужие маршруты | Alpha.13 чистит stale tables по приоритету, метке и номеру таблицы | Для Obhod сохранить метку владельца маршрута `proto 253`. Учитывать форму маршрута, тип и scope. Смешанную таблицу считать конфликтом | Чужое правило priority 1 и маршрут в реальном netns, unit-test ownership и повторный startup |
| ICMP/ping | Отделить штатное истечение сессии от отсутствия первого ответа и ошибок сокета | Текущий `ping.Destination` обновляет дедлайн по активности и молча завершает сессию | Оставить новый цикл, классификацию журнала перенести в обработку фактического окончания сессии. Старые изменения gVisor-пути исключены | Unit-test уровней и реальные IPv4 Echo через прямой и выбранный пути |
| Clash API, urltest history, DNS cache | Сохранять видимость выбранного туннеля и управление кэшем | Alpha.13 содержит API истории, TCP/UDP выбор urltest и отдельные endpoint для очистки DNS/FakeIP | Использовать штатный Clash API. TTL и хранение DNS не расширять | `/proxies/proxy` и переключение по реальным HTTP запросам, `POST /cache/dns/flush` и последующий FakeIP |
| Remote SRS/JSON | Загружать, обновлять и восстанавливать списки | Upstream хранит SRS/JSON в cache file, поддерживает HTTP client и загрузку из кэша | Сохранить штатный формат и кэш. Перенести `download_detour` в `http_client`, а обновления адресов подключить к nftables | Холодная загрузка, обновление, битый JSON, перезапуск без HTTP сервера |
| WireGuard L3 | Передавать TCP/UDP напрямую на пакетный порт WireGuard | Прямой путь alpha.13 воспроизводимо зависал на TCP `iperf3` через сервер .5, хотя соединение устанавливалось | Для TCP/UDP входящего Obhod TUN использовать обычную маршрутизацию к выбранному WireGuard outbound. Новый TUN-стек обрабатывает входящий трафик. Этот режим сохраняет адресный выбор, failover и прокси DNS | Повторный сквозной TCP/UDP тест WireGuard с той же топологией |

## B. Архитектура и конфигурация

Только ядро с capability `obhod-experimental-1.15` активирует миграцию
рабочего JSON в `prepare.uc`. Записанный пользователем профиль остаётся
источником конфигурации. Экспериментальный TUN использует Go TCP/IP стек,
когда поле `stack` отсутствует. Фильтры nftables отсекают невыбранные сети,
поддерживают те же LAN-интерфейсы и отдельно маршрутизируют трафик роутера.
Выбранный трафик проходит штатные метки и NFQUEUE/TUN. Часть TCP при
`auto_redirect` обслуживает redirect listener sing-tun. Это отдельный путь
от прямого входа TCP через TUN, использованного в измерениях.
[Документация TUN и миграции](https://sing-box.sagernet.org/migration/#migrate-tun-stack).

В обоих профилях правила DNS предшествуют private/direct и доменным
правилам. Восстановленное имя FakeIP участвует до sniff, правила для домена
после sniff остаются в графе. Изменения не добавляют прямой маршрут к
выбранному DNS. В 1.15 ключ DNS кэша уже включает транспорт, поэтому
`independent_cache` убирается. Правила `predefined` и `route` с
`query_type` сохраняются. Тесты проверяют выбор A, AAAA, HTTPS/SVCB и
FakeIP после перезапуска. `store_rdrc` и legacy DNS response filters
отсутствуют в генерируемых профилях. Для вручную добавленного
`store_rdrc: true` нужна отдельная миграция с сохранением
семантики кэширования отказов. `store_dns` хранит также обычные ответы.
[Документация DNS миграции](https://sing-box.sagernet.org/migration/#migrate-independent-dns-cache).

Запросы к удалённым спискам идут через указанный прокси или прямой HTTP
client с тем же DNS-резолвером. Профили с конфликтующими `http_client`
и `download_detour` получают ошибку подготовки.
[Документация HTTP client для rule-set](https://sing-box.sagernet.org/configuration/rule-set/#http_client).

## C. Измерения

WSL2 x86_64, Linux 6.18.33.2, три парных прогона full по 5 секунд для
TCP и UDP. В каждой паре использованы тот же SOCKS5 relay из .5, выборочная
маршрутизация через TUN, MTU 1500 и одинаковый iperf3 3.9. Порядок версий
чередовался. WAN-фильтр блокировал прямой доступ к серверу нагрузки,
счётчик на TUN подтверждал путь. DNS замерялся на 150 уникальных именах
за прогон. CPU и память относятся к процессу маршрутизатора в стенде.
Значения в таблице представляют медианы, если не указано иное.

| Метрика | .5 | alpha.13-obhod.1 |
| --- | ---: | ---: |
| TCP, Гбит/с | 1.56 | 38.24 |
| TCP, CPU процесса (% одного логического CPU) | 160 | 110 |
| TCP, системное CPU процесса за прогон, с | 7.11 | 4.45 |
| UDP, Мбит/с при подаче 50 Мбит/с | 49.99 | 49.99 |
| UDP, потеря, % | 0.000 | 0.000 |
| UDP, CPU процесса (% одного логического CPU) | 24 | 10 |
| Старт до записи readiness, мс | 29.0 | 246.5 |
| RSS на старте, МиБ | 24.2 | 35.0 |
| RSS после нагрузки и DNS, МиБ | 29.8 | 44.7 |
| Пиковый RSS, МиБ | 29.8 | 44.7 |
| FD после нагрузки и DNS, снимок | 13 | 12 |
| DNS, среднее время, мс | 0.287 | 0.347 |
| DNS, p95, мс | 0.318 | 0.365 |
| DNS, p99, мс | 0.531 | 0.693 |
| Ошибки DNS, сумма трёх прогонов | 0 | 0 |

TCP показал диапазоны 1.55–1.66 и 36.01–38.98 Гбит/с. Высокий результат относится к
виртуальному veth/SOCKS стенду с прямым TCP входом через TUN. Для UDP
50 Мбит/с была заданной нагрузкой, поэтому замер показывает её обработку.
На этом стенде выросли RSS, время запуска и p95 DNS. Замеры на физических
линиях, результаты ARM64/MIPSel и общий CPU всей системы требуют отдельной
проверки.

Отдельно оба ядра выдержали по 30 секунд передачи на одном TCP и одном
UDP потоке. Результаты этого прогона — baseline 1.64 Гбит/с TCP, 50.00 Мбит/с UDP (0.000% потерь), experimental 37.39 Гбит/с TCP, 50.00 Мбит/с UDP (0.000% потерь). Это короткий стендовый
прогон, для оценки долговременной стабильности на OpenWrt нужны часы работы.

```sh
unshare -nm --propagation private python3 scripts/benchmark-openwrt-tun.py \
  --baseline "$BASE" --experimental "$EXP" --seconds 5 --repeats 3 \
  --dns-queries 150 --output "$OUT/bench-wsl-amd64.json"
unshare -nm --propagation private python3 scripts/benchmark-openwrt-tun.py \
  --baseline "$BASE" --experimental "$EXP" --seconds 2 --repeats 1 \
  --dns-queries 20 --soak-seconds 30 --output "$OUT/soak-wsl-amd64.json"
```

В локальном каталоге артефактов находятся сырые прогоны с SHA-256 обоих
бинарников. `smoke-*-wsl-amd64.json` содержат сквозные прогоны HTTP,
VLESS, WireGuard и статического `route_address_set` без `auto_redirect`.

## D. OpenWrt и пакеты

| Среда | Результат |
| --- | --- |
| 25.12.6, APK | Установка и удаление в x86_64 rootfs, четыре ARM64/MIPSel APK. Проверены SHA, metadata и вызовы `version`, `check`, `obhod-capabilities` под QEMU |
| 24.10.4, IPK | Аналогично для четырёх IPK через opkg offline-root |
| Linux AMD64 | Lite/full собраны локально. Реальный TUN, DNS и nftables проверены на WSL x86_64 |
| ARM64 Cortex-A53 и MIPSel 24kc | ELF обоих профилей проверен под QEMU. Пакетный прогон использует виртуальные зависимости от kernel-модулей |
| Профили | Full включает WireGuard. Lite использует тот же собственный стек для поддерживаемых протоколов |
| Выбор ядра | Экспериментальные имена пакетов, пути установки и отдельный `experimental-packages.json`. Проверка снимка после установки и удаления подтверждает сохранение `/usr/bin/sing-box` и конфигураций .5 |

Размер ELF в МиБ важен для установки на устройства с небольшим flash.

| Архитектура | .5 lite / full | alpha.13 lite / full |
| --- | ---: | ---: |
| AMD64 | 31,9 / 32,5 | 44,3 / 44,9 |
| ARM64 | 29,6 / 30,1 | 41,4 / 42,0 |
| MIPSel | 33,7 / 34,3 | 46,8 / 47,5 |

Сборка ведётся по [инструкции](../core/README.md). Релизные операции не
требуются. Исходники, лицензии, `build-manifest.json` и `SHA256SUMS`
сохранены в локальном каталоге `release/network-core-1.15-experimental`.

## E. Регрессии и команды

В командах ниже `BASE` и `EXP` указывают на AMD64 full бинарники
`1.13.21-obhod.5` и `1.15.0-alpha.13-obhod.1`, `TOOLS` указывает на
каталог проверенных OpenWrt rootfs и apk.static. `OUT` указывает на
`release/network-core-1.15-experimental`, `STABLE` на каталог пакетов .5.

| Проверка | Команда | Состояние |
| --- | --- | --- |
| Статические проверки Node и генератор | `npm ci --ignore-scripts`, `npm test` | Passed, 98 тестов. 14 встроенных runtime проверок пропущены в Windows source-only worktree |
| Текущие IPv4/IPv6 и сохранённые профили, `sing-box check` в 24.10/25.12 | `unshare -nm --propagation private python3 scripts/test-experimental-openwrt-config.py --baseline "$BASE" --experimental "$EXP" --tools "$TOOLS"` | Passed, 6 профилей проверены обоими ядрами |
| DNS pool, FakeIP, отмена | В `PREPARED/source` выполнить `go test -race -mod=readonly ./dns/transport ./experimental/cachefile ./protocol/dns -run TestObhod -count=1` | Passed |
| Реальные DNS pool, filtered FakeIP и повторяющиеся ID | В приватном namespace с поднятым loopback выполнить `python3 scripts/test-openwrt-dns-pool.py --native-core "$EXP" --tools "$TOOLS"` | Passed, включая 256 запросов, отмену 64 обменов и отсутствие DNS fallback |
| UDP NAT, redirect ownership, ICMP logging | В `PREPARED/sing-tun` выполнить `go test -race -mod=readonly . ./ping -run TestObhod -count=1` | Passed |
| Реальный LAN/router origin, IPv4/IPv6, nft/NFQUEUE, FakeIP, WAN source IP, DNS flush, ICMP ping и аварийное восстановление | `unshare -nm --propagation private python3 scripts/test-openwrt-kernel-routing.py "$EXP"` | Passed |
| Domain-first, server-first и отсутствие прямого DNS при отказе туннелей | Команды namespace ниже | Passed |
| TCP/UDP через SOCKS, VLESS и WireGuard, TCP через HTTP | `benchmark-openwrt-tun.py` с аргументом `--tunnel socks\|vless\|wireguard\|http` | Passed с WireGuard через обычный путь. Прямой L3 WireGuard alpha.13 выключен для TCP/UDP Obhod |
| Автономная пересборка | В распакованном архиве выполнить `sh BUILD.sh amd64 full`, `sh BUILD.sh arm64 full` и `sh BUILD.sh mipsle lite`, затем сравнить SHA-256 с локальными бинарниками | Passed, побайтовое совпадение |
| APK/IPK, версия, профиль и сохранение стабильного ядра | `unshare -nm --propagation private python3 scripts/verify-experimental-core-packages.py --packages "$OUT" --previous "$STABLE" --tools "$TOOLS" --report "$OUT/verification.json"` | Passed в disposable rootfs |
| Тесты физического AX3000T, ARM64/MIPSel performance, procd и аппаратные offload-настройки | Требуется отдельный стенд OpenWrt | Skipped |

```sh
# Эти команды выполняются в отдельном unshare -nm --propagation private.
ip link set lo up
ip addr add 8.8.8.8/32 dev lo
ip link add lab type dummy
ip addr add 192.0.2.9/24 dev lab
ip link set lab up
ip route add default via 192.0.2.1
OBHOD_TEST_CORE="$EXP" OBHOD_TEST_DNS_TRAP=1 node --test \
  test/failover-dns-runtime.test.js test/failover-runtime.test.js \
  test/openwrt-fakeip-runtime.test.js test/openwrt-ip-runtime.test.js \
  test/openwrt-routing-runtime.test.js
```

В одном парном прогоне с интервалом urltest 1 с от остановки основного
HTTP-туннеля до DNS-ответа через резерв прошло 1023 мс на .5 и 1018 мс на
alpha.13. Контрольный прямой DNS-сервер не получил соединений. Проверки
TCP/UDP через удалённые прокси выполнялись на IPv4. Варианты IPv6 проверялись
на стенде nftables/TUN отдельно.

## F. Готовность

Сборка пригодна для ограниченного тестирования в Linux namespaces и
OpenWrt userspace. Для Xiaomi AX3000T на OpenWrt 25.12 сравните full и
lite с .5 на одинаковых профилях, используя внешние LAN и WAN iperf3
узлы, измерения RSS/HWM и CPU на роутере, фактические счётчики
nftables и серию DNS/FakeIP проверок до и после WAN renew и SIGKILL.
Затем выполните длительный TCP/UDP прогон и проверьте возврат к .5.
Зафиксируйте версию ядра OpenWrt, MTU, частоту CPU и режим offload рядом
с результатами.

Для повседневной замены .5 пока недостаточно результатов на OpenWrt
ядрах и целевой памяти устройства. Остаются ограничения prerelease, прямого
L3 WireGuard, больших динамических наборов на малопамятных устройствах и
момента пересоздания таблицы при старте. Проверка после SIGKILL охватывает
период с оставшимися правилами, а проверка остановки подтверждает их очистку.
