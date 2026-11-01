#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Usage: sh core/build.sh PREPARED_DIRECTORY OUTPUT_DIRECTORY GOARCH lite|full [GOOS]
set -eu
prepared=$(CDPATH='' cd -- "$1" && pwd)
mkdir -p "$2"
output=$(CDPATH='' cd -- "$2" && pwd)
export GOARCH=$3 GOOS=${5:-linux} CGO_ENABLED=0 GOTOOLCHAIN=local
case "$GOARCH" in mipsle) export GOMIPS=softfloat;; arm64|amd64) ;; *) echo 'Unsupported architecture' >&2; exit 1;; esac
case "$4" in lite) tags=with_gvisor,with_quic,with_utls,with_clash_api;; full) tags=with_gvisor,with_quic,with_utls,with_clash_api,with_wireguard;; *) exit 1;; esac
case "$(go version)" in 'go version go1.26.10 '*) ;; *) echo 'Use Go 1.26.10 for this release' >&2; exit 1;; esac
cd "$prepared/source"
name="sing-box-$GOOS-$GOARCH-$4"
[ "$GOOS" != windows ] || name="$name.exe"
go build -mod=readonly -trimpath -buildvcs=false -tags "$tags" \
    -ldflags '-s -w -checklinkname=0 -X github.com/sagernet/sing-box/constant.Version=1.13.21-obhod.3' \
    -o "$output/$name" ./cmd/sing-box
