# Лицензии и сторонние компоненты

Собственный код «Обхода» распространяется по Apache License 2.0. Полный текст
находится в `LICENSE`.

## sing-box / amnezia-box

- Upstream: https://github.com/SagerNet/sing-box
- AWG-совместимый fork: https://github.com/hoaxisr/amnezia-box/tree/57276220a20679cad762c9644f6abdaf39ab7688
- Версия: 1.14.0-rc.1-awgm.15, Windows amd64, ревизия `57276220a20679cad762c9644f6abdaf39ab7688`
- Тег сборки: `with_awg` и стандартные теги проекта
- SHA-256 встроенного `sing-box.exe`: `00302b3785ee7f3f896df4d027707543202d082300e60719a51b21f5fc9a5917`
- Лицензия: GPL-3.0-or-later; полный текст — `LICENSES/GPL-3.0-only.txt`, уведомление проекта — `LICENSES/sing-box-GPL-notice.txt`
- Соответствующий исходный код: https://github.com/hoaxisr/amnezia-box/tree/57276220a20679cad762c9644f6abdaf39ab7688
- Инструкция воспроизводимой сборки: `windows/docs/BUILDING_RUNTIME.md`

Ядро собирается из опубликованного исходного кода и запускается как отдельный
процесс. В каждый GitHub Release рядом с установщиком прикладывается архив
именно этой ревизии исходников.

## Необязательное ядро OpenWrt MIPS

Отдельный пакет `sing-box-tiny` 1.13.21-obhod.1 для `mipsel_24kc` не входит
в Windows-установщик. Он основан на sing-box `628cb31ffa79cffffd34c2f9cde6cae044e4fc12`
и sing-tun `f3b42b8b8e061ef849213a776d9fcf3d5f6ea239` с исправлением 32-битного
номера таблицы маршрутизации. Лицензия — GPL-3.0-or-later. Рядом с APK/IPK
предоставляются соответствующие исходники, включая используемые Go-модули.
Сборка и проверка описаны в `openwrt/core-mips/README.md`.

## AmneziaWG-Go

- Проект: https://github.com/hoaxisr/amneziawg-go
- Ревизия: `ad2b1d906df4e4e0c405c5490addc7c984bc878d` (Go-модуль `v3.1.0-awgm.2`)
- Использование: userspace-реализация AmneziaWG внутри AWG-совместимого ядра
- Лицензия: MIT; полный текст — `LICENSES/AmneziaWG-Go-MIT.txt`
- Исходный код: https://github.com/hoaxisr/amneziawg-go/tree/ad2b1d906df4e4e0c405c5490addc7c984bc878d

## Production-зависимости Electron

Полные тексты лицензий npm-пакетов, попадающих в приложение, собраны в
`legal/NPM_THIRD_PARTY_LICENSES.txt`. Файл генерируется из lock-файла командой
`npm run licenses:update` и проверяется перед релизом.

## Podkop allow-domains

- Проект: https://github.com/itdoginfo/allow-domains
- Использование: удалённые бинарные SRS rule-set, обновление каждые 12 часов

Эти rule-set загружаются во время работы и не входят в установщик «Обхода».
