# Разработка и сборка Обхода для OpenWrt

[← Руководство пользователя](../README.md) · [Совместимое ядро](../../core/README.md)

[Соединения и восстановление](STABILITY.md) описывает проверки сетевых событий,
повторного сохранения, запуска из кэша и явных IP-маршрутов.

Команды ниже выполняются из корня репозитория. Для Linux-проверок используется отдельная тестовая среда.

## Сборка

Исходники пакетов: `openwrt/obhod` и `openwrt/luci-app-obhod`. Парсеры подключений
и генератор общие с Windows-версией; браузерный модуль собирается из исходников:

```sh
node scripts/build-openwrt-core.js
python3 scripts/build-openwrt-packages.py --apk /path/to/apk --output release/openwrt
```

Проверки разработки:

```sh
npm test
npm run test:openwrt:ui
npm run openwrt:fixture
python3 scripts/test-openwrt-system.py
python3 scripts/test-openwrt-dns-pool.py
python3 scripts/test-openwrt-core-migration.py
sudo unshare -n python3 scripts/test-openwrt-kernel-routing.py /path/to/sing-box-linux-amd64-full
npm run test:openwrt:ui -- --luci-loader .tmp/openwrt-tools/luci-25.12.6.js --luci-theme .tmp/openwrt-tools/luci-bootstrap-25.12.6.css
```

Команда `python3 scripts/test-openwrt-system.py` запускается от root в отдельной Linux-среде. Она создаёт
тестовый rootfs в `/tmp/obhod-openwrt-lab`, проверяет установку APK и IPK настоящими
пакетными менеджерами, транзакции UCI/DNS и откат RPC. Для проверки установки
зависимости заменяются тестовым пакетом; службы и сеть физического роутера не
затрагиваются. Для проверки ошибок запуска используется управляемая заглушка ядра.
Полная схема конфигурации отдельно проверяется настоящим Linux sing-box 1.12.22.
Системная проверка также извлекает штатный `luci.js` из проверенного образа в
`.tmp/openwrt-tools/luci-25.12.6.js`. Последняя команда использует именно его
загрузчик классов: воспроизводит ошибку обычного object-экспорта и проверяет
загрузку исправленного модуля, наследующего `baseclass`, перед проверками UI.
Также используются штатный DOM LuCI и стили Bootstrap: проверяются значения
чекбоксов, вкладки, сохранение ввода, несовместимые списки и ширины 320/390 пикселей.
Изображения тёмного, светлого и мобильного интерфейса сохраняются в `.tmp/openwrt-ui-preview`.
Код LuCI используется только в тесте и не включается в наши пакеты.

`test-openwrt-kernel-routing.py` проверяет настоящее ядро с функцией
`kernel-route-set-v1` в отдельных сетевых пространствах имён. Проверяются
первые TCP/UDP-пакеты прямого трафика (счётчики NFQUEUE не растут), FakeIP,
DNS, IPv6, JSON/SRS, обновление адресного набора без перезапуска и удаление
TUN/правил при остановке. На физическом роутере нужно отдельно проверить
dnsmasq и procd. При замере скорости учитывайте аппаратный offload:
счётчики PPPoE могут не отражать весь поток; для Windows VPN используется
разница счётчиков RAS, а CPU sing-box считается по `/proc/stat` и `/proc/PID/stat`.

Для создания APK нужен Linux и apk-tools 3 с командой `mkpkg`. Для этой сборки
использован официальный `apk-tools-static 3.0.8-r0` Alpine Linux; инструмент
сборки и sing-box в распространяемый комплект не включаются. SHA-256 архива
инструмента: `673f1bfb22136fc42ca035321cf731a4ad0452c000928666cb39a138f0c277bf`.
Пакеты можно также включить в SDK с установленным feed LuCI; Makefile находятся
рядом с исходниками. Собственный код распространяется по Apache-2.0.

Документация первоисточников: [TUN/auto_redirect sing-box](https://sing-box.sagernet.org/configuration/inbound/tun/),
[APK mkpkg](https://gitlab.alpinelinux.org/alpine/apk-tools/-/blob/v3.0.8/doc/apk-mkpkg.8.scd),
[пакет sing-box OpenWrt 24.10](https://github.com/openwrt/packages/blob/openwrt-24.10/net/sing-box/Makefile).
