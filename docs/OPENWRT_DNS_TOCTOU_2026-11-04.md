# DNS restore / lifecycle: закрытие TOCTOU перед obhod.5

Исходный commit: `1fadccc55bbff099fb7ec056726ae35ad7492f10`.
Ветка: `fix/openwrt-audit-2026-11-04`. Рабочее дерево в начале было чистым.
Работа и тесты выполнены локально в WSL, без физического роутера.

## Подтверждённые сценарии

**Ранний restore — подтверждён и исправлен.** На исходном commit проверка backup
выполнялась до FD 8. FIFO останавливает apply после настоящего flock, перед
созданием backup. Дополнительный неблокирующий flock из Python подтверждает,
что блокировка занята. Запущенный restore на `1fadccc` выходит с кодом 0,
не достигая точки перед захватом блокировки. После исправления он ожидает apply,
снимает новый snapshot, восстанавливает `9.9.9.9` и удаляет завершённый backup.

**Обычный stop во время startup — дополнительный дефект не воспроизведён.**
Проверен следующий реальный порядок кода OpenWrt rootfs:

1. `control::stop_and_wait()` выполняет первоначальный DNS restore.
2. Init stop через `/etc/rc.common` вызывает `stop_service()`, который тоже
   выполняет DNS restore.
3. Затем `rc.common` вызывает `procd_kill()`: `procd.sh` отправляет ubus
   `service delete`.
4. При TERM `run` выполняет cleanup: снимает ready, восстанавливает DNS,
   после этого останавливает/ожидает ядро и снимает run-pid.
5. `control` ожидает завершения run PID и только после успешного результата
   сбрасывает enabled.

Тест использует настоящие `run`, `control`, init, `rc.common`, `procd.sh`,
UCI и ucode. Заглушены ядро/монитор и транспорт ubus. Барьер в `service delete`
расположен после настоящего `stop_service`; он позволяет startup начать apply
между restore и сигналом TERM. Этот тест проходит и на `1fadccc`.

**SIGKILL run с живым DNS-child — подтверждён и исправлен.** Если run не исполнил
cleanup, ожидание только его PID не означает окончания DNS-child. При остановке
apply под FD 8 до backup родителя можно завершить, а ребёнка затем выпустить:
старый control уже мог вернуть успех и сбросить enabled, ребёнок устанавливал
`127.0.0.1#1053`. Одного переноса проверки backup недостаточно для этого случая.
В тесте SIGKILL воспроизводит потерю cleanup; полноценный daemon procd не запускается.

**Queued apply после завершения владельца — подтверждён и исправлен.** Если
DNS-child ещё не приобрёл FD 8, финальный restore может завершиться раньше него.
Без проверки владельца поздний child всё равно применял DNS. Проверены как
завершившийся, так и заменённый worker.

**Отказ stop после ожидания первого backup — подтверждён и исправлен.** После
переноса проверки под FD 8 отдельный тест обнаружил, что control запоминал
`dns_was_managed` по отсутствующему backup до ожидания. В ходе ожидания apply
создавал backup, restore его снимал, но неудачный init stop уже не возвращал DNS
живому готовому worker. Падение зафиксировано до изменения этой проверки.

## Точное исправление

- `dns`: проверка отсутствующего backup для restore перенесена сразу после
  захвата FD 8, до создания WORK и копирования DHCP.
- `run`: служебный вызов теперь имеет вид `dns apply "$$"`.
- `dns`: если apply получил PID владельца, внутри FD 8 проверяются совпадение
  с текущим run-pid и живой процесс через существующий `operation.uc alive`.
  Завершившийся/заменённый владелец означает отказ до backup и UCI-изменений.
- `control::stop_and_wait()`: после ожидания run PID добавлен окончательный
  DNS restore. Он дожидается DNS-child, который уже прошёл проверку владельца
  и держит FD 8. При неудаче возвращается конкретная ошибка, enabled сохраняется;
  повторная остановка может завершить restore.
- `control::stop_failed()`: решение о возврате DNS живому ready worker использует
  настроенный `manageDns`, а не раннее наличие backup. Прежняя повторная проверка
  ready/run-pid после rollback сохранена; unmanaged DNS не включается.

Два порядка закрыты совместно: если apply уже прошёл проверку под FD 8,
окончательный restore дождётся его и снимет DNS. Если child получит FD 8 после
окончательного restore и завершения владельца, apply отменится. Обычная ручная
команда `dns apply` без PID сохраняет интерфейс; намеренный ручной apply после
остановки не является служебным queued apply и автоматически не запрещается.

Четыре фазы `prepared/applying/applied/restoring`, правила владения полями,
журнал commit, UCI compare-and-replace и обработка внешних upstream не менялись.
Operation manager, FD 9, token/PID/starttime и stale recovery не менялись.
Нового постоянно удерживаемого lock нет. Проверка alive берёт краткий operation
guard; operation manager сам не ждёт DNS FD 8. В тестах заблокированные операции
заканчиваются после выпуска FIFO; SIGKILL владельцев FD 8 не оставляет stale lock.

Дополнительный restore при уже удалённом backup не перезапускает dnsmasq.
Регрессия повторных apply/restore проверяет ровно четыре restart на два полных
цикла; дополнительные no-op apply/restore не увеличивают счётчик.

## Регрессии и результаты

В `scripts/test-openwrt-residual.py` добавлены семь методов:

| Тест | Что проверено |
| --- | --- |
| `test_restore_waits_for_apply_before_backup_exists` | Restore ждёт настоящий flock до первого backup; повторные операции и restart count |
| `test_restore_waiting_on_dns_lock_recovers_after_sigkill` | Ожидающий restore продолжает после SIGKILL держателей FD 8; следующий цикл работает |
| `test_control_stop_while_run_is_entering_dns_apply` | Startup между stop_service и TERM; настоящий порядок rc.common |
| `test_control_stop_waits_for_dns_child_of_killed_run` | SIGKILL родителя; stop ожидает живую DNS-транзакцию |
| `test_queued_service_apply_rejects_dead_or_replaced_worker` | Поздний apply после финального restore; завершение и замена владельца |
| `test_final_restore_failure_preserves_enabled_and_can_retry` | Ошибка рестарта после финального restore; фаза restoring, enabled и безопасный retry |
| `test_failed_stop_after_waiting_for_first_backup_restores_live_dns` | Первый backup появился в ходе ожидания restore; возврат DNS после отказа stop |

На отдельной копии исходников **именно 1fadccc** первые шесть методов дали
**5 failed, 1 passed**. Passed — нормальный TERM lifecycle, не объявленный новым
дефектом. Первые два failed прямо подтверждают ранний успешный выход restore.
Другие падения подтверждают SIGKILL/поздний child и отсутствие финального restore.
Седьмой сценарий отдельно упал после исправления основного TOCTOU, до исправления
политики failed-stop. Все семь затем прошли в обоих userspace.

Финальные проверки:

| Проверка | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: |
| Residual, OpenWrt 25.12.6/apk | 44 | 0 | 0 |
| Residual `--opkg`, OpenWrt 24.10.4 | 44 | 0 | 0 |
| Existing `dns_tests()`, актуальный код на 25.12/apk, группы | 2 | 0 | 0 |
| Existing `dns_tests()`, актуальный код на 24.10/opkg, группы | 2 | 0 | 0 |
| Existing system test, группы проверок APK/IPK | 17 | 0 | 0 |
| `git diff --check` | 1 | 0 | 0 |

44 метода включают прежние 37 регрессий: конкурентные UCI server/noresolv/cache,
фазы/неоднозначные backup, прерывания commit, файловые ошибки, повторный restore,
отказ stop, no-op apply, operation leases и shell/ucode syntax. Syntax-тест
проверяет libexec shell и компиляцию ucode, кроме неизменённого optional
`dns-pool.uc`, требующего отсутствующего в базовых rootfs socket module.

System-тест выполнен с overlay актуальных libexec/init поверх disposable APK
installation, чтобы начальные DNS/lifecycle-проверки использовали изменённый
код. Последующие package/self-update сценарии используют прежние архивы APK/IPK
как и раньше. Ничего не пересобиралось и не публиковалось.
Кроме полного прогона, сама функция `dns_tests()` из существующего system-теста
отдельно выполнена в каждом из двух disposable rootfs с актуальным кодом.

Для повторения основных регрессий в Linux/WSL root:

```sh
python3 scripts/test-openwrt-residual.py
python3 scripts/test-openwrt-residual.py --opkg
```

Проверка исходного дефекта с новым тестом и старым production-кодом:

```sh
baseline=$(mktemp -d /tmp/obhod-dns-baseline.XXXXXX)
git archive 1fadccc openwrt/obhod/files | tar -x -C "$baseline"
OBHOD_TEST_BASE="$baseline/openwrt/obhod/files" python3 scripts/test-openwrt-residual.py \
  Residual.test_restore_waits_for_apply_before_backup_exists
```

Локальные логи: `.tmp/dns-toctou-{before,baseline,lifecycle,focus,extra,apk,opkg,system,system-dns}.log`
и `.tmp/dns-toctou-stop-failure-before.log`.

## Границы и риски

Изменены только `dns`, `control`, `run`, residual-тесты и этот отчёт.
Маршрутизация, nftables, NFQUEUE, TUN, FakeIP, генератор, sing-box, DNS pool,
версии, зависимости и опубликованные пакеты/ядра/теги не изменялись.

На AX3000T/OpenWrt 25.12 обязательно проверить настоящие ubus/procd TERM и
эскалацию SIGKILL, отсутствие DNS upstream на остановленный listener, повторную
остановку после ошибки dnsmasq и отсутствие лишнего restart при no-op.
Реальный daemon procd, аппаратные ошибки flash, power loss и принудительный
SIGKILL сразу всех компонентов службы на устройстве не проверялись. Само
исправление не заменяет общий механизм восстановления ядра после SIGKILL:
оно сериализует DNS и не даёт штатному служебному apply пережить успешный stop.
Пока реальная DNS-транзакция продолжает держать FD 8, restore обязан ждать;
падение владельцев освобождает lock, но не обещается обход живого зависшего
процесса с принудительным повреждением его транзакции.
