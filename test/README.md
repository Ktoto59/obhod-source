# Проверки

Запуск из корня: `npm test`.

Общие модели и генераторы проверяют `config-generator.test.js` и
`subscription.test.js`. Тесты с префиксом `openwrt` относятся к конфигурации
роутера. Остальные покрывают Windows-приложение и его службы.

Проверки с настоящим Windows-ядром пропускаются, когда
`windows/runtime/sing-box.exe` отсутствует. Ключи и аккаунты в тестах —
синтетические данные, адреса серверов используют зарезервированные сети.
Сетевые интеграционные проверки создают локальные серверы и временные профили.

Для OpenWrt дополнительно используются `scripts/test-openwrt-system.py`
в изолированной Linux-среде и `npm run test:openwrt:ui` для LuCI. Физический
роутер для этих проверок не требуется.

Регрессии аудита маршрутизации и отказоустойчивости запускаются на Linux от
root: `python3 scripts/test-openwrt-audit.py` и тот же вызов с `--opkg`.
Используются проверенные rootfs OpenWrt 25.12.6 и 24.10.4 из
`.tmp/openwrt-tools`, одноразовые chroot и настоящие ash/UCI/ucode.
Сценарии включают SIGKILL, живых потомков, гонки status/worker, ошибки запуска
procd, конкурентные UCI commit, откат DNS и сохранение без записи во flash.
Запуск самого procd заменён транспортной фикстурой; это не проверка init/PID 1.

`scripts/test-openwrt-dns-pool.py` проверяет ucode-пул; `--native-core PATH`
выбирает собранное Linux-ядро. Для параллельного запуска используйте отдельные
network namespace, поскольку сценарий занимает фиксированные локальные порты.
`scripts/test-openwrt-kernel-routing.py PATH` запускается через `unshare -n`
с доступными nftables, NFQUEUE и `/dev/net/tun`.

`test/failover-dns-runtime.test.js`, `test/openwrt-fakeip-runtime.test.js`, `test/openwrt.test.js` и
`test/subscription.test.js` принимают `OBHOD_TEST_CORE` для выбора Linux-бинарника;
на Windows без переменной сохраняется штатный выбор `windows/runtime/sing-box.exe`.
Для последовательного запуска всех Node.js-сценариев: `npm test -- --test-concurrency=1`.
