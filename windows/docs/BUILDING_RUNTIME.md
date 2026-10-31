# Сборка сетевого ядра

«Обход» взаимодействует с `sing-box.exe` как с отдельным процессом через
конфигурационный файл, стандартный вывод и сигналы завершения. Код GPL-ядра не
линкуется и не импортируется в код Electron-приложения.

Для воспроизведения поставляемого ядра используется ревизия
`57276220a20679cad762c9644f6abdaf39ab7688` репозитория
`https://github.com/hoaxisr/amnezia-box`. В её `go.mod` зафиксирован
AmneziaWG-Go v3 с заменой на `github.com/hoaxisr/amneziawg-go/v3 v3.1.0-awgm.2`
(ревизия `ad2b1d906df4e4e0c405c5490addc7c984bc878d`).
Релиз `1.14.0-rc.1-awgm.15` является предварительной RC-версией.

```powershell
git clone https://github.com/hoaxisr/amnezia-box.git
Set-Location amnezia-box
git checkout --detach 57276220a20679cad762c9644f6abdaf39ab7688
$env:CGO_ENABLED = '0'
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
$env:GOTOOLCHAIN = 'go1.26.8'
go build -trimpath -buildvcs=false -tags "with_gvisor,with_quic,with_dhcp,with_wireguard,with_utls,with_acme,with_clash_api,with_tailscale,with_ccm,with_ocm,with_naive_outbound,with_purego,with_awg" -ldflags "-X github.com/sagernet/sing-box/constant.Version=1.14.0-rc.1-awgm.15+57276220a20679cad762c9644f6abdaf39ab7688" -o sing-box.exe ./cmd/sing-box
```

Эталонный бинарник собран Go 1.26.8 для `windows/amd64` с отключённым CGO.
Его SHA-256:
`00302b3785ee7f3f896df4d027707543202d082300e60719a51b21f5fc9a5917`.

Результат другой версии Go может быть функционально эквивалентен, но не обязан
совпасть побайтно. Проверить версию и ревизию можно командой
`sing-box.exe version`.

Ревизия явно добавлена к версии через `ldflags`; автоматическое VCS-клеймо
отключено, чтобы сборка из архива соответствующих исходников давала тот же
результат, что и чистый checkout. Go 1.27.1 для этой ревизии не подходит:
линковка завершается ошибкой `http2.(*Transport).connPool`.
