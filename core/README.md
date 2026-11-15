# Экспериментальное ядро Obhod

Версия `1.15.0-alpha.13-obhod.1` использует официальный prerelease
[`v1.15.0-alpha.13`](https://github.com/SagerNet/sing-box/releases/tag/v1.15.0-alpha.13).
Точные ревизии и версия Go находятся в [upstream.json](upstream.json).
[Отчёт о портировании](../docs/SING_BOX_1_15_EXPERIMENTAL.md) описывает проверки и ограничения.

## Сборка из закреплённых исходников

В Linux или WSL с Go 1.26.10, Git и Python 3 выполните команды из корня ветки.

```sh
mkdir -p .tmp/core-1.15
git clone --depth 1 --branch v1.15.0-alpha.13 https://github.com/SagerNet/sing-box.git .tmp/core-1.15/sing-box
git init .tmp/core-1.15/sing-tun
git -C .tmp/core-1.15/sing-tun fetch --depth 1 https://github.com/SagerNet/sing-tun.git 611d83b7a57b4719be45581eb674942ff561de6c
git -C .tmp/core-1.15/sing-tun checkout --detach FETCH_HEAD
git init .tmp/core-1.15/sing
git -C .tmp/core-1.15/sing fetch --depth 1 https://github.com/SagerNet/sing.git 03a6cce64bf744023af9e2691fb11afd405b9061
git -C .tmp/core-1.15/sing checkout --detach FETCH_HEAD
python3 scripts/prepare-network-core.py \
  --sing-box .tmp/core-1.15/sing-box --sing-tun .tmp/core-1.15/sing-tun --sing .tmp/core-1.15/sing \
  --output .tmp/core-1.15/prepared
out=release/network-core-1.15-experimental
for arch in amd64 arm64 mipsle; do
  for profile in lite full; do
    sh core/build.sh .tmp/core-1.15/prepared "$out/binaries" "$arch" "$profile"
  done
done
```

Сборка использует `CGO_ENABLED=0`, `-trimpath`, `-buildvcs=false`, для MIPS
`GOMIPS=softfloat`. Full включает WireGuard. Подготовка берёт файлы из
`git archive HEAD`, проверяет SHA, накладывает `core/patches` и копирует
`core/overlay`. В `build-manifest.json` записываются контрольные суммы
патчей и файлов overlay.

## Пакеты и исходники

```sh
python3 scripts/build-network-core-packages.py --binaries "$out/binaries" \
  --prepared .tmp/core-1.15/prepared --apk /path/to/apk.static --output "$out"
python3 scripts/package-network-core-source.py --prepared .tmp/core-1.15/prepared \
  --cache "$(go env GOMODCACHE)" --packages "$out" \
  --output "$out/sing-box-1.15.0-alpha.13-obhod.1-source.tar.gz"
```

Пакеты `obhod-experimental-core-lite` и `obhod-experimental-core-full`
устанавливают ядра в `/usr/lib/obhod-experimental/<профиль>/sing-box`. У них
собственные имена, версии и манифест `experimental-packages.json`. Оба профиля
могут сосуществовать со штатным ядром. Пакеты содержат лицензии и манифест
сборки, а архив содержит исходники модулей, использованных сборкой. Для
автономной сборки из архива запустите `sh BUILD.sh arm64 full`.

## Ручное тестирование

Для начальной проверки используйте отдельный network namespace и явный путь к
бинарнику. Проверка ядра из локального пакета и возврат к исходному состоянию
в тестовой OpenWrt rootfs воспроизводятся командой
`scripts/verify-experimental-core-packages.py`.

Если стенд проверяет запуск именно через сервис Obhod, на отдельной тестовой
OpenWrt-системе сохраните версию, SHA-256 и резервную копию
`/usr/bin/sing-box`, `/etc/obhod` и `/etc/sing-box`. Остановите службу.
Смонтируйте выбранный экспериментальный бинарник поверх `/usr/bin/sing-box`
как bind mount в отдельном mount namespace и используйте backend из этой
ветки. `prepare.uc experimental-1.15` преобразует только рабочую копию
профиля. После проверки остановите экспериментальный экземпляр. Выход из
приватного mount namespace снимает подмену, после чего можно проверить
сохранённый SHA-256 и запустить штатную службу. Для обычного запуска
используйте установленный штатный путь и штатные приложения.

Файлы ядра и патчи распространяются на условиях GPL-3.0-or-later. Сценарии
сборки и код приложения Obhod распространяются на условиях Apache-2.0.
