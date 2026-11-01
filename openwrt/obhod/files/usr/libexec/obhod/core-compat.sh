#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# The caller owns work, the operation lock, signed dependency indexes and budget.
select_compat_core() {
	compat=0
	compat_skip=0
	[ -n "${core:-}" ] || return 0
	[ -f "$compat_catalog" ] || return 0
	detect_core_platform
	case "$compat_arch" in mipsel_24kc|aarch64_cortex-a53) ;; *) return 0;; esac
	# Never silently downgrade a newer upstream core to the pinned compatibility base.
	if command -v sing-box >/dev/null 2>&1; then
		compat_current=$(sing-box version 2>/dev/null | head -n 1 | sed -n 's/^sing-box version //p')
		if [ "${compat_requested:-auto}" = auto ]; then
		case "$compat_current" in 1.12.*|1.13.[0-9]|1.13.1[0-9]|1.13.20|1.13.21|1.13.21-obhod.1|1.13.21-obhod.2|1.13.21-obhod.3|'') ;; *) return 0;; esac
		fi
	fi
	compat_profile=full; [ "$core" != sing-box-tiny ] || compat_profile=lite
	ucode "$compat_selector" "$compat_catalog" "$compat_arch" "$manager" "$compat_profile" "$compat_release" "${compat_requested:-auto}" > "$work/core-selection" || die 'Не удалось проверить каталог совместимых ядер.'
	[ -s "$work/core-selection" ] || return 0
	read -r compat_url compat_sha compat_bytes compat_installed compat_version < "$work/core-selection"
	compat=1
	compat_plan_installed=$compat_installed
	compat_plan_download=$compat_bytes
	compat_target=1.13.21-obhod.3; case "$compat_version" in *200) compat_target=1.13.21-obhod.2;; esac
	if [ "${compat_current:-}" = "$compat_target" ] && [ "$(find_core)" = "$core" ] && /usr/bin/sing-box obhod-capabilities 2>/dev/null | grep -qx dns-pool-v1; then
		compat_skip=1; compat_plan_installed=0; compat_plan_download=0
	fi
	printf 'Совместимое ядро Обхода: %s · %s · %s\n' "$compat_arch" "$compat_profile" "$compat_version"
}

download_compat_core() {
	read_resources
	[ "$tmp_free" -ge "$(((compat_bytes+1023)/1024+2048))" ] || die 'Недостаточно места в /tmp для совместимого ядра. Освободите память и повторите установку.'
	compat_file="$work/$core.$manager"
	[ "$manager" != opkg ] || compat_file="$work/$core.ipk"
	uclient-fetch -q -T 120 --header='Accept: application/octet-stream' -O "$compat_file" "$compat_url" || die 'Не удалось загрузить совместимое ядро; штатное ядро не заменено.'
	[ "$(wc -c < "$compat_file")" -eq "$compat_bytes" ] || die 'Неожиданный размер совместимого ядра.'
	compat_actual=$(sha256sum "$compat_file"); compat_actual=${compat_actual%% *}
	[ "$compat_actual" = "$compat_sha" ] || die 'Контрольная сумма совместимого ядра не совпала.'
}

install_compat_core() {
	[ "$compat_skip" = 0 ] || return 0
	for compat_other in sing-box podkop passwall passwall2 homeproxy; do
		if ubus call service list "{\"name\":\"$compat_other\"}" 2>/dev/null | jsonfilter -e '@.*.instances.*.running' | grep -q true; then die 'Остановите другую службу прокси перед сменой ядра.'; fi
	done
	download_compat_core
	compat_backup="/root/obhod-before-core-$(date +%Y%m%d-%H%M%S)-$$.tar.gz"
	set -- /etc/config/dhcp
	for compat_path in /etc/obhod /etc/config/obhod /etc/config/sing-box; do [ ! -e "$compat_path" ] || set -- "$@" "$compat_path"; done
	tar -czf "$compat_backup" "$@" 2>/dev/null || die 'Не удалось сохранить настройки перед сменой ядра.'
	chmod 600 "$compat_backup"
	# Replacing the binary must not enable OpenWrt's separate sing-box service.
	if uci -q get sing-box.main >/dev/null; then uci set sing-box.main.enabled=0; uci commit sing-box; fi
	if [ "$manager" = apk ]; then
		set -- "$compat_file"
		if [ "$core" = sing-box ]; then set -- "$@" '!sing-box-tiny'; else set -- "$@" sing-box; fi
		apk --no-network --simulate add --allow-untrusted "$@" || die 'Пакетный менеджер отклонил совместимое ядро.'
		apk --no-network add --allow-untrusted "$@" || die 'Не удалось установить совместимое ядро.'
	else
		compat_old=$(find_core)
		if [ -n "$compat_old" ]; then
			mkdir "$work/rollback"
			compat_old_version=$(opkg status "$compat_old" | awk '$1=="Version:" {print $2;exit}')
			case "$compat_old_version" in 1.13.21-200|1.13.21-300)
				compat_old_core=1.13.21-obhod.3; [ "$compat_old_version" != 1.13.21-200 ] || compat_old_core=1.13.21-obhod.2
				compat_old_profile=full; [ "$compat_old" != sing-box-tiny ] || compat_old_profile=lite
				ucode "$compat_selector" "$compat_catalog" "$compat_arch" opkg "$compat_old_profile" "$compat_release" "$compat_old_core" > "$work/rollback/selection" || die 'Не удалось проверить пакет отката.'
				[ -s "$work/rollback/selection" ] || die 'Точная версия ядра для отката недоступна. Установка отменена.'
				read -r rollback_url rollback_sha rollback_bytes rollback_installed rollback_version < "$work/rollback/selection"
				read_resources
				[ "$tmp_free" -ge "$(((rollback_bytes+1023)/1024+2048))" ] || die 'Недостаточно места для пакета отката.'
				compat_rollback="$work/rollback/core.ipk"
				uclient-fetch -q -T 120 --header='Accept: application/octet-stream' -O "$compat_rollback" "$rollback_url" || die 'Не удалось загрузить ядро для отката.'
				[ "$(wc -c < "$compat_rollback")" = "$rollback_bytes" ] || die 'Некорректный размер пакета отката.'
				printf '%s  %s\n' "$rollback_sha" "$compat_rollback" | sha256sum -c - || die 'Контрольная сумма пакета отката не совпала.'
				;;
			*)
			opkg_metadata "$compat_old" > "$work/rollback/info"
			(cd "$work/rollback" && opkg download "$compat_old") || die 'Не удалось загрузить прежнее ядро для отката.'
			set -- "$work/rollback/"*.ipk
			[ "$#" = 1 ] && [ -f "$1" ] || die 'Неоднозначный пакет отката.'
			compat_rollback=$1
			compat_hash=$(sha256sum "$1"); compat_hash=${compat_hash%% *}
			awk -v h="$compat_hash" '$1=="SHA256sum:" && $2==h {f=1} END {exit !f}' "$work/rollback/info" || die 'Не подтверждена подпись индекса пакета отката.'
			awk -v v="$compat_old_version" -v h="$compat_hash" 'BEGIN{RS="";FS="\n"} {version=0;hash=0;for(i=1;i<=NF;i++){if($i=="Version: "v)version=1;if($i=="SHA256sum: "h)hash=1}if(version&&hash)found=1} END{exit !found}' "$work/rollback/info" || die 'Точная версия ядра для отката недоступна. Установка отменена.'
			;; esac
		fi
		if [ -n "$compat_old" ] && [ "$compat_old" != "$core" ]; then
			opkg --noaction remove "$compat_old" > "$work/remove-plan" 2>&1 || die 'Другое приложение зависит от текущего ядра.'
			[ "$(grep -c '^Removing package ' "$work/remove-plan")" = 1 ] || die 'Смена ядра затронет другие пакеты.'
			opkg remove "$compat_old" || die 'Не удалось удалить прежнее ядро.'
		fi
		if ! opkg --force-downgrade install "$compat_file"; then
			if [ -n "${compat_rollback:-}" ] && [ "$compat_old" != "$core" ] && opkg status "$core" | grep -q '^Status:.* installed$'; then opkg remove "$core" || die 'Не удалось удалить незавершённую установку ядра для отката.'; fi
			if [ -n "${compat_rollback:-}" ]; then opkg --force-downgrade install "$compat_rollback" || die 'Не удалось восстановить прежнее ядро. Проверьте пакеты через SSH.'; fi
			die 'Установка совместимого ядра не удалась; выполнен откат, если прежнее ядро было установлено.'
		fi
	fi
	rm -f "$compat_file"
	rm -f /var/run/obhod/core-version-key /var/run/obhod/core-capabilities
	/usr/bin/sing-box obhod-capabilities 2>/dev/null | grep -qx redirect-table-31bit || die 'Установленное ядро не подтвердило совместимость.'
	if [ "$compat_arch" = mipsel_24kc ]; then
		# Only the erroneous RTN_LOCAL 127.0.0.1/32 entry in MAIN, never LOCAL.
		ip -4 route show table main > "$work/routes-before" || die 'Не удалось проверить таблицу main.'
		awk '$1=="local" && ($2=="127.0.0.1" || $2=="127.0.0.1/32") {for(i=3;i<NF;i++)if($i=="dev")print $(i+1)}' "$work/routes-before" > "$work/loopback-devices"
		while read -r compat_device; do
			[ -n "$compat_device" ] || continue
			case "$compat_device" in *[!a-zA-Z0-9_.:-]*) die 'Некорректное имя устройства в main.';; esac
			[ "${#compat_device}" -le 15 ] || die 'Некорректное имя устройства в main.'
			ip -4 route del table main local 127.0.0.1/32 dev "$compat_device" scope host || die 'Не удалось удалить ошибочный маршрут loopback из main.'
		done < "$work/loopback-devices"
	fi
}
