# Остаточные дефекты OpenWrt: исправления и проверка

Исходный HEAD: `7d09912063737b3be8e72d1a963cb3604dc9cf9b`, ветка
`fix/openwrt-audit-2026-11-04`. При начале работы рабочее дерево было чистым.
Проверки выполнены локально в WSL/Linux, в одноразовых chroot с настоящими
OpenWrt UCI/ucode. Физический роутер не использовался.

## 1. P1: жизненный цикл DNS backup

**Статус: подтверждён и исправлен.**

**Причина.** Backup создавался до compare-and-replace. После отклонённого commit
в нём не было сведений, применялся ли DNS Obhod. Изменение `server` или
`noresolv` делало текущие поля непохожими и на исходные, и на применённые.
Следующие restore и apply отказывали. Ещё один подтверждённый дефект: после
restore с чужим дополнительным upstream и неудачным рестартом dnsmasq повторный
restore не распознавал уже записанный результат.

**Исправление.** В `dns` и `dns-commit.uc` введены фазы:

| Фаза | Значение и безопасное действие |
| --- | --- |
| `prepared` | Обход ещё не пытался заменить DHCP. При отсутствии собственного upstream backup можно убрать и снять новый snapshot. |
| `applying` | Под UCI flock проверен snapshot и опубликовано намерение записи; rename мог состояться. Проверяется фактическое состояние. |
| `applied` | Запись и рестарт dnsmasq успешны; повторный apply не делает лишний рестарт. |
| `restoring` | Сохранены ожидаемые DNS-поля результата restore, включая чужие upstream. После rename/неудачного рестарта можно повторить только рестарт и удаление backup. |

Намерение публикуется после проверки snapshot, перед rename, под тем же flock
файла DHCP. Ошибка записи журнала запрещает замену DHCP. Поля restore сохраняются
до commit. Ошибки UCI при удалении/восстановлении полей прерывают транзакцию.
Внешние `server`, `noresolv`, `cachesize` сохраняются по прежним правилам владения.

Локальная сериализация DNS переведена с mkdir на унаследованный flock FD 8:
SIGKILL не оставляет постоянный каталог блокировки. FD закрывается у вызова
рестарта dnsmasq, чтобы daemon не унаследовал эту блокировку. Существующий flock
UCI, проверка inode/содержимого и отдельный пакет для staging сохранены.

**Доказательство.** `scripts/test-openwrt-residual.py` воспроизводит реальные
конкурентные UCI commit через FIFO перед commit helper. Проверены `server` и
`noresolv`, прямой повторный apply без промежуточного restore, конфликт restore,
внешние cache/upstream после apply, SIGKILL до commit и по обе стороны rename,
неудачный рестарт, запись backup/staging/journal/rename и удаление backup.
Повторный restore проверен с дополнительным `8.8.8.8`.
Отдельно проверено внешнее добавление идентичного `127.0.0.1#1053` после создания
`prepared`: обе операции сохраняют файл и backup с ошибкой, не присваивая этот
upstream себе и не удаляя его.

Тест `test_dns_commit_cooperates_with_uci_lock` с изменением `domain` полезен:
compare-and-replace сравнивает весь файл. Но только `domain` не воспроизводит
зависание backup: `is_original()` сравнивает DNS-поля, а domain в них не входит.
Поэтому прежняя гонка с domain проходила и не доказывала устранение P1.

**Побочные эффекты.** После прерванного apply может потребоваться повторный
рестарт dnsmasq. Успешный повторный apply остаётся без рестарта. При неоднозначном
состоянии возвращается ошибка с путём backup; чужие поля не перезаписываются.

**Остаточный риск.** Старый backup без фазы и состояние `applying/applied`, в
котором внешний процесс полностью заменил upstream, остаются неоднозначными.
Они намеренно сохраняются с ошибкой для ручного согласования. Автоматически
удалять их или накатывать старые настройки было бы небезопасно. Обрыв питания
и аппаратные ошибки flash не моделировались; прерывание процессов проверено.

## 2. P2: финализация update

**Статус: подтверждён и исправлен.**

**Причина.** Worker вызывал release перед удалением собственного snapshot и
rpcd reload. Новый update/apply мог получить operation lock в этом окне.
При ошибке rm после release исчезала возможность сообщить корректный итог.

**Исправление.** В `update::finish()` порядок теперь следующий:

1. Восстановить ранее работавшую службу, если её останавливали для установки.
2. Удалить уникальный временный каталог текущего worker.
3. Выполнить rpcd reload и обработать его результат.
4. Опубликовать результат и освободить собственную операцию.

Код operation manager из snapshot сохраняется в памяти до cleanup: итоговый
release через `ucode -e` работает после удаления каталога и после замены
установленных файлов пакетным менеджером. `finish` обрабатывает ошибки без
преждевременного выхода из-за `set -e`. Неудачные rm/reload дают состояние error;
после ошибки reload остаётся `rpcd-reload-needed`.

Acquire/claim, token, PID/starttime, FD 9, stale recovery и guard apk/opkg не
менялись. На время reload удерживается операция/lease, но не кратковременный
`obhod-operations.guard`. Поэтому синхронные status/recover могут завершаться.
Штатный rpcd reload в исследованном rootfs вызывает `procd_send_signal rpcd`.

**Доказательство.** FIFO удерживает реальный worker в rm и rpcd reload. Acquire
нового update и apply отклоняется в обоих местах. Проверены status/recover из
reload, ошибка reload, ошибка rm и SIGKILL worker при живом cleanup child:
FD 9 удерживает операцию до окончания ребёнка. Повторный release со старым
токеном не освобождает следующую операцию. Унаследованы регрессии PID reuse,
zombie/stale recovery, живых control children и guard пакетного менеджера.
Существующий system-тест прошёл настоящую установку APK/IPK и self-update.

**Побочные эффекты.** Busy сохраняется до окончания финализации. Ошибка cleanup
может оставить только уникальный каталог старой операции; следующий worker
использует другой mktemp-каталог и не удаляется поздним cleanup.

**Остаточный риск.** Реальные взаимодействия rpcd/procd на ARM64 требуют
проверки на устройстве. Пользовательский reload, ожидающий освобождения самой
операции бесконечно, не является поведением штатного init-скрипта и не проверялся.

## 3. P2/P3: возраст телеметрии

**Статус: подтверждён и исправлен.**

**Причина.** `inspect.uc` брал задержку из последнего `history`, но ставил
`checkedAt = time()` при каждом чтении. LuCI принимал время чтения за свежесть
замера и использовал фиксированный порог 90 секунд. Формат подтверждён по
локальным исходникам ядра: `adapter.URLTestHistory` содержит `time.Time` и delay;
Clash API возвращает сохранённую историю, а успешный `/delay` записывает новую.

**Исправление.** `inspect.uc` разделяет `checkedAt` (время замера), `receivedAt`
(получение данных), `diagnosedAt` (завершение явной диагностики). Пассивное время
разбирается из RFC3339 `sample.time`, включая дробную часть и UTC offset,
независимо от TZ роутера. Поле `known` отличает отсутствие замера от неуспеха.
`maxAge` соответствует настроенному urltest interval; для существующей активной
проверки фиксированного сервера сохранён порог 90 секунд.

RPC `status` передаёт эти поля. LuCI `routeTelemetry()` отдельно проверяет возраст
замера и свежесть получения данных. Состояния показываются как задержка,
«нет замера», «нет ответа» либо «замер устарел». Подсказка различает время замера,
получения и явную диагностику.

**Доказательство.** Проверены свежий и старше 5 минут sample, пустой/неверный
history time, RFC3339 с наносекундами и `+05:00`, повторное чтение, явная
диагностика, failed sample, переключение активного сервера и RPC поля.
Два Node-теста исполняют настоящую функцию LuCI и проверяют подписи/свежесть.
Унаследованный тест делает четыре пассивных опроса группы: **0 `/delay`**;
явная диагностика добавляет один запрос. Прежняя одиночная проверка фиксированного
сервера сохранена. `monitor` не изменялся.

**Побочные эффекты.** Старый успешный или неуспешный sample больше не выдаётся
за текущую доступность. Старый backend без новых полей отображается как отсутствие
замера до обновления backend. Фоновые сетевые проверки не добавлены.

**Остаточный риск.** Проверена логика UI, не полный браузерный сценарий LuCI на
роутере. NTP/timezone и смену сервера во время реальной работы следует проверить
на устройстве.

## 4. Отказ stop после успешного restore

**Статус: подтверждён и исправлен.**

**Причина.** Ошибка init stop немедленно возвращалась после успешного restore.
Готовая служба могла продолжить работу без ранее управляемого DNS. Отдельно
ветка неудачного start сбрасывала enabled, даже когда её cleanup stop отказал.

**Исправление.** `control::stop_failed()` возвращает DNS работающему worker,
только если ранее существовал backup, включён `manageDns`, worker готов и жив.
Ядро и рабочий config не перезапускаются/не заменяются. После apply повторно
проверяются ready и живой run-pid: если cleanup worker успел завершиться до apply,
DNS снова восстанавливается. Готовый живой respawn оставляет необходимый ему DNS.
При неудаче stop enabled сохраняется, включая cleanup неудачного start.
Неудачный первоначальный DNS restore по-прежнему запрещает вызов init stop.

**Доказательство.** Реальные DNS apply/restore с init stop, возвращающим ошибку;
отдельные тесты unmanaged DNS, неудачного start+cleanup stop и управляемой гонки
cleanup между проверкой worker и rollback apply. Проверка запрета остановки
listener при неудачном restore унаследована и проходит.

**Побочные эффекты.** Ошибка остановки может вызвать дополнительный рестарт
dnsmasq. Чужие настройки сохраняются в новом backup перед повторным apply.

**Остаточный риск.** Поведение штатного procd при частично выполненной остановке
и реальном respawn требует проверки на устройстве. SIGKILL самого listener без
cleanup не превращается в новую гарантию восстановления этой правкой.

## 5. Производительность и FD DNS pool

**Статус: утечка/неограниченный рост не воспроизведены; реализация оставлена.**

`scripts/test-openwrt-dns-pool-resources.py` запускает настоящий ucode pool с
двумя, тремя и четырьмя локальными upstream. Condition подтверждает получение
всех запросов upstream; ответы победителей выпускаются явно. Запрос №65
получает SERVFAIL и не достигает upstream при уже занятых 64 exchange.

| Upstream | Пик UDP sockets для exchange | Исходные/пиковые/конечные FD | Пик RSS при NXDOMAIN, КиБ | 64 NXDOMAIN с молчащими проигравшими |
| ---: | ---: | ---: | ---: | ---: |
| 2 | 128 | 8 / 136 / 8 | 1552 | 0,227–0,232 с |
| 3 | 192 | 8 / 200 / 8 | 1668 | 0,236–0,240 с |
| 4 | 256 | 8 / 264 / 8 | 1720 | 0,245–0,249 с |

На каждый размер пула выполнено 1280 NXDOMAIN exchange в 20 насыщенных пачках.
RSS выходит на плато после прогрева. Проверены также 64 полностью истёкших
таймаута и отмена 16 TCP-клиентов с четырьмя уже отправленными exchange каждый:
все FD возвращаются к исходному количеству. Проигравшие UDP sockets закрываются
после ответа победителя, до получения от них ответов. При TCP нагрузке проверен
предел `baseline + 16 clients + 64 * upstreams` до отмены.

Отдельный существующий end-to-end pool-тест прошёл 256 параллельных запросов,
62 отменённых TCP race, FakeIP, SOCKS/fail-closed, cold bootstrap, неправильные
пакеты и bounded NXDOMAIN. Измеренный RSS трёх helper в нём: 1216/1184/1196 КиБ.

**Побочные эффекты:** отсутствуют, `dns-pool.uc` не изменён. Окно арбитража 200 мс
и лимит 64 сохранены; задержки не добавлены. При насыщении окна новые запросы
получают предусмотренный SERVFAIL. Это ограниченное admission-поведение.

**Остаточный риск:** замеры x86_64/WSL — не оценка пропускной способности AX3000T.
Не проведён многосуточный soak и не измерялся CPU ARM64. На устройстве необходимы
проверка фактического RLIMIT_NOFILE и суммарной памяти всех helper/ядра.

## Проверки и доказательство падения до исправлений

| Проверка | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| `python3 scripts/test-openwrt-residual.py`, OpenWrt 25.12.6/apk | 37 | 0 | 0 |
| Тот же runner с `--opkg`, OpenWrt 24.10.4 | 37 | 0 | 0 |
| `npm test`, включая compliance/notices и два новых UI-теста | 103 | 0 | 0 |
| `python3 scripts/test-openwrt-system.py`, группы проверок | 17 | 0 | 0 |
| `python3 scripts/test-openwrt-dns-pool.py`, группы проверок | 14 | 0 | 0 |
| Новый resource-тест, варианты upstream | 3 | 0 | 0 |
| Shell syntax, оба userspace | 17 + 17 | 0 | 0 |
| OpenWrt JS `node --check` | 4 | 0 | 0 |
| `git diff --check` | 1 | 0 | 0 |

В каждом 37-тестовом runner содержатся 17 прежних регрессий и 20 новых методов.
В него включена компиляция ucode и shell syntax libexec. Optional socket module
отсутствует в базовых rootfs: `dns-pool.uc` компилируется/исполняется отдельно
при установленном модуле в pool-тестах 25.12; pool с модулем на 24.10 не запускался.

Для доказательства использована отдельная копия **исходников из HEAD 7d09912**,
без checkout поверх правок. Одиннадцать целевых методов дали **12 ожидаемых assertion
failures**, поскольку `server` и `noresolv` проверяются отдельно. Падения:
зависший restore и прямой apply после конфликта, повторный частичный restore,
оба окна update, ошибка rm после release, потеря защиты cleanup child после
SIGKILL, подмена времени history, отказ stop и преждевременный сброс enabled
после неудачного start и присвоение внешнего upstream по совпадающему адресу.
После исправления те же методы
проходят. FIFO/реальные flock управляют гонками; короткий polling только ожидает
публикации события и не определяет порядок конкурирующих записей.

Повторить baseline в Linux/WSL root из корня репозитория можно так:

```sh
baseline=$(mktemp -d /tmp/obhod-baseline.XXXXXX)
git archive 7d09912063737b3be8e72d1a963cb3604dc9cf9b openwrt/obhod/files | tar -x -C "$baseline"
OBHOD_TEST_BASE="$baseline/openwrt/obhod/files" python3 scripts/test-openwrt-residual.py \
  Residual.test_rejected_dns_server_commit_allows_retry \
  Residual.test_rejected_commit_allows_direct_apply_without_restore \
  Residual.test_partial_restore_with_foreign_upstream_can_retry \
  Residual.test_update_cleanup_excludes_new_update_and_apply \
  Residual.test_update_rpcd_reload_excludes_operations_and_can_read_status \
  Residual.test_update_cleanup_failure_still_releases_own_operation \
  Residual.test_history_timestamp_is_measurement_time \
  Residual.test_failed_service_stop_restores_running_dns_and_enabled_intent \
  Residual.test_killed_update_keeps_live_cleanup_child_lease \
  Residual.test_failed_start_cleanup_does_not_clear_enabled_when_stop_fails \
  Residual.test_prepared_backup_cannot_claim_foreign_listener_upstream
```

Локальные логи сохранены в `.tmp/residual-{baseline,apk,opkg,npm,system,pool-integration,pool-resources}.log`.
Промежуточные ошибки тестового стенда/синтаксиса исправлены; таблица отражает
финальные прогоны. Указанные аппаратные и browser-проверки не засчитаны как passed.

## Изменённые файлы и границы

Production:

- `openwrt/obhod/files/usr/libexec/obhod/dns` — фазы, retry/restore target, DNS flock.
- `openwrt/obhod/files/usr/libexec/obhod/dns-commit.uc` — журнал намерения под UCI flock.
- `openwrt/obhod/files/usr/libexec/obhod/update` — финализация до release.
- `openwrt/obhod/files/usr/libexec/obhod/control` — отказ stop/неудачный start cleanup.
- `openwrt/obhod/files/usr/libexec/obhod/inspect.uc` — время измерения и получения.
- `openwrt/obhod/files/usr/libexec/rpcd/obhod` — новые поля телеметрии.
- `openwrt/luci-app-obhod/htdocs/luci-static/resources/view/obhod/overview.js` — возраст и подписи.

Тесты: `scripts/test-openwrt-residual.py`,
`scripts/test-openwrt-dns-pool-resources.py`, `test/openwrt-telemetry.test.js`.
Документация: этот отчёт.

Маршрутные генераторы, kernel-route, nftables/NFQUEUE, TUN/auto_redirect/
route_address_set, FakeIP, private/direct, IPv4/IPv6, протоколы, sniff и remote
SRS/JSON не изменялись. Маршруты не добавлялись. No-op apply подтверждён прежним
runtime-тестом `test_identical_apply_skips_core_check` на обоих userspace: нет
control restart, core check или staging профиля во flash при идентичном save.
Версии, зависимости, Windows production-код, опубликованные ядра/пакеты/теги/
релизы не менялись. Локальные пакетные тесты используют существующие архивы.

## Что обязательно проверить на Xiaomi AX3000T / OpenWrt 25.12

1. Apply/restore настоящего dnsmasq с конкурентным UCI commit `server/noresolv`,
   повторным apply и сохранением дополнительных upstream, включая IPv6 и domain-specific server.
2. Прерывание worker перед/после commit, ошибка рестарта dnsmasq, восстановление
   после перезагрузки; проверить backup и отсутствие DNS-зависимости от остановленного listener.
3. Настоящий apk update/install в контролируемом тестовом окружении устройства:
   запрет apply/update до финализации, rpcd reload, сохранение профиля/enable intent,
   SIGKILL worker с живым package child. Не менять опубликованные артефакты.
4. Отказ stop/продолжающийся cleanup/respawn procd: DNS доступен, enabled не сброшен
   преждевременно, повторная остановка завершается безопасно.
5. LuCI при интервале 5 минут, старом/пустом history, NTP/TZ и смене сервера;
   отсутствие `/delay` на пассивном polling группы.
6. Для ucode fallback с 2–4 upstream: `/proc/PID/fd`, RSS, CPU, RLIMIT_NOFILE,
   NXDOMAIN/timeout/TCP cancellation и более длительный soak. Отдельно проверить
   native DNS pool ядра: его реализация этой задачей не менялась.
7. Идентичный apply без рестарта и сохранение LAN selection, IPv6, FakeIP,
   DNS hijack, failover/urltest, всех используемых протоколов и fail-closed DNS.
