# Проверка выпуска OpenWrt 0.1.19 — 4 ноября 2026

Приложение: **0.1.19**. Ядро: **1.13.21-obhod.5**, APK r500 / IPK 500.
Исходники ядра: `55526feaaad378c1c2a659198feeed9a7180a047`.
Исходники приложения закрепляются тегом `openwrt-v0.1.19`; точный commit также
записывается в метаданные обновления и описание GitHub Release.

## Решение blocker

Изучен opkg OpenWrt 24.10.4 (`2024.10.16~38eccbb1-r1`), исходный commit
`38eccbb1fd694d4798ac1baf88f9ba83d1eac616`.
[Реальная последовательность установки](https://git.openwrt.org/project/opkg-lede.git/tree/libopkg/opkg_install.c?id=38eccbb1fd694d4798ac1baf88f9ba83d1eac616):
prerm/preinst → backup_modified_conffiles → распаковка payload → resolve_conffiles
→ сохранение состояния и postinst. Каталог в conffiles старого 400 ломает
резервирование до postinst; исправлять это постфактум невозможно.

Выбран отдельный compatibility rollback: **500 → 401**, бинарник сообщает `.4`.
Четыре IPK revision 401 содержат побайтово тот же `data.tar.gz`, что опубликованные
400. Изменены только Version и conffiles нового пакета. Старые `.4`, их SHA256,
теги и релизы не изменяются. Прямой downgrade на оригинальный 400 сохраняет
историческую ошибку и не является поддерживаемым способом отката.

Одной revision недостаточно для SIGKILL и сохранения прав: opkg временно заменяет
конфигурации, а копирование conffiles может менять владельцев/права. Помощник
`core-opkg.uc` сохраняет содержимое, права и владельцев двух пакетных конфигураций
в приватном постоянном журнале. Восстановление идемпотентно; неизвестные внешние
правки не затираются, копия сохраняется. Живая дочерняя opkg удерживает lease.
База opkg не редактируется, конфигурационные каталоги не перемещаются и не удаляются,
force-overwrite/force-maintainer не используются. Проверяется SHA256 установленного
ELF: фактический ENOSPC может не отражаться в коде возврата opkg.

## Проверки

| Проверка | Passed | Failed | Skipped / границы |
| --- | ---: | ---: | --- |
| Windows npm test | 108 | 0 | 0 |
| Linux source-only npm test | 94 | 0 | 14 Windows/runtime-dependent |
| Новый Linux core: FakeIP и failover DNS | 2 | 0 | Локальные серверы |
| Go audit с -race | 17 | 0 | amd64 |
| Residual + inherited audit, apk/opkg | 44 + 44 | 0 | Настоящие UCI/ash/ucode |
| Recovery journal: bytes, modes, uid/gid, external edits, guard, missing file | 5 | 0 | Настоящий ucode 24.10 |
| Все основные APK/IPK: install, upgrade, downgrade, reinstall, config | 8 | 0 | QEMU + native package managers |
| Все IPK: ENOSPC на записи ELF, SIGKILL, SIGTERM, lease, recovery, retry | 4 комплекта | 0 | Настоящий opkg, strace fault injection |
| Повторный прогон скачанных публичных APK/IPK и всех IPK faults | 8 + 4 комплекта | 0 | Отдельные chroot |
| Приложение: update 0.1.18 → 0.1.19, APK/opkg | 2 сценария | 0 | Сохранение профиля и UCI |
| Приложение: rollback 0.1.19 → 0.1.18 → 0.1.19 | 2 сценария | 0 | Настоящие APK/opkg, профиль и UCI/DNS |
| Full/tiny, required core, migration, management/RPC, stale catalog 401→400 refusal | passed | 0 | Оба менеджера |
| LuCI stock loader/DOM/theme 24.10 и 25.12, light/dark/mobile | 2 прогона | 0 | Electron, RPC fixtures |
| nftables/NFQUEUE/TUN, IPv4/IPv6, router-originated, SRS/JSON, SIGKILL | passed | 0 | Native amd64, WSL namespaces |
| DNS pool native/ucode и FD/admission/cancel/RSS | passed | 0 | Локальные upstreams |
| Offline binary rebuild / repeat core packaging | 6 / 8 совпадений | 0 | Побайтово |
| Repeat compatibility rollback packaging | 4 совпадения | 0 | Побайтово, исходные .4 неизменны |
| 29 файлов опубликованного ядра: размеры и SHA256 | 29 | 0 | Скачаны с GitHub |
| Анонимная загрузка APK/IPK / доступность всего каталога | 12 / 32 | 0 | Реальные опубликованные asset ID |
| Compliance, notices, shell/ucode syntax, generated LuCI core, diff check, secrets | passed | 0 | Локально и CI |
| GitHub Actions source 55526fe | 4 jobs × 2 runs | 0 | Windows, Linux, secrets, network-core |
| Физическое оборудование | 0 | 0 | Не выполнялось в этом сеансе |

В каталог включены реальные asset ID опубликованного `.5` и 401. Для `.4`
на opkg выбирается 401, APK остаётся r400. Старые 400 IPK сохранены в provenance
и прежнем релизе; отдельный исходный архив `.4` приложен для GPL-соответствия.

## Артефакты и совместимость

[Стабильное ядро .5](https://github.com/Ktoto59/obhod-releases/releases/tag/openwrt-core-v1.13.21-obhod.5)
и [OpenWrt 0.1.19](https://github.com/Ktoto59/obhod-releases/releases/tag/openwrt-v0.1.19).
Полные хеши и размеры:
[SHA256 ядра](https://github.com/Ktoto59/obhod-releases/releases/download/openwrt-core-v1.13.21-obhod.5/SHA256SUMS),
[SHA256 приложения](https://github.com/Ktoto59/obhod-releases/releases/download/openwrt-v0.1.19/SHA256SUMS).
Статус публичной публикации и проверки скачанных пакетов приложения фиксируются
в итоговом отчёте и GitHub Release после завершения последнего gate.

OpenWrt 24.10/opkg и 25.12/apk; ARM64 Cortex-A53/MIPS little-endian 24Kc;
lite/full. sing-box 1.15 не включён. Windows-версия и pipeline не изменены.
Наличие `.5` само по себе не перезапускает совместимую работающую службу.
Равный профиль сохраняет безопасный no-op apply; пассивная телеметрия, chunked
upload, toggleService и ограничение чтения журнала 32 КБ сохранены.

Перед обновлением с 0.1.18 сохраните /etc/obhod, /etc/config/obhod и
/etc/config/dhcp. После обновления выберите `.5` во вкладке «Протоколы» для
новых исправлений. Для отката opkg используйте 401 через помощник/интерфейс,
а не прямую установку старого 400. При незавершённой операции повторите
восстановление, сохранив journal при конфликте внешних правок.

Ограничения: client DoH/DoT может обходить DNS роутера; обычный IPv6 при
отключённой обработке остаётся прямым; глобального kill switch нет.
В package chroot dependencies представлены fixtures и procd hooks не исполняются;
сервисные сценарии моделируются. QEMU/WSL не подтверждают работу драйверов,
dnsmasq/procd и offload на конкретном роутере. Старые скриншоты не подменялись
результатами физического тестирования. Логи: .tmp/release-019-resume/.
