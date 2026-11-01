#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Shared by the offline installer and the LuCI core installer. Caller owns work.
detect_manager() {
	if command -v apk >/dev/null 2>&1 && [ -f /etc/apk/world ]; then manager=apk
	elif command -v opkg >/dev/null 2>&1; then manager=opkg
	else die 'Не найден настроенный apk или opkg.'; fi
}
find_core() {
	if [ "$manager" = apk ]; then
		awk '/^P:sing-box(-tiny)?$/ {sub(/^P:/, ""); print; exit}' /lib/apk/db/installed 2>/dev/null || true
	else
		opkg status 'sing-box*' 2>/dev/null | awk '/^Package:/ {p=$2} /^Status:.* installed$/ && (p=="sing-box" || p=="sing-box-tiny") {print p; exit}'
	fi
}
detect_core_platform() {
	compat_release=$(. /etc/openwrt_release; printf '%s' "${DISTRIB_RELEASE:-}")
	case "$compat_release" in 24.10|24.10.*) compat_release=24.10;; 25.12|25.12.*) compat_release=25.12;; esac
	if [ "$manager" = apk ] && [ -s /etc/apk/arch ]; then compat_arch=$(awk 'NF{print $1;exit}' /etc/apk/arch)
	elif [ "$manager" = apk ]; then compat_arch=$(. /etc/openwrt_release; printf '%s' "${DISTRIB_ARCH:-}")
	else compat_arch=$(opkg print-architecture | awk '$1=="arch" && $2!="all" && $2!="noarch" && $3>=n {n=$3;a=$2} END{print a}'); fi
}
free_kb() { df -Pk "$1" | awk 'NR>1 {v=$4} END {if(v ~ /^[0-9]+$/)print v;else exit 1}'; }
read_resources() {
	ram_total=$(awk '$1=="MemTotal:" {print $2}' /proc/meminfo)
	ram_available=$(awk '$1=="MemAvailable:" {print $2}' /proc/meminfo)
	[ -n "$ram_available" ] || ram_available=$(awk '$1=="MemFree:" || $1=="Buffers:" || $1=="Cached:" {n+=$2} END {print n+0}' /proc/meminfo)
	flash_path=/overlay; [ -d /overlay ] || flash_path=/
	flash_free=$(free_kb "$flash_path") || die 'Не удалось определить место накопителя.'
	tmp_free=$(free_kb /tmp) || die 'Не удалось определить место /tmp.'
}
opkg_metadata() {
	# `opkg info` omits Installed-Size and SHA256sum in stock OpenWrt.
	# Read records from indexes populated and signature-checked by `opkg update`.
	lists=$(awk '$1=="lists_dir" {print $3; exit}' /etc/opkg.conf)
	[ -n "$lists" ] || lists=/var/opkg-lists
	for index in "$lists/"*; do
		[ -f "$index" ] || continue
		case "$index" in *.sig) continue ;; esac
		awk -v name="$1" 'BEGIN{RS="";FS="\n"} {for(i=1;i<=NF;i++)if($i=="Package: "name){print $0 "\n";break}}' "$index"
	done
}
resolve_sizes() {
	if [ "$manager" = apk ]; then
		command -v ucode >/dev/null 2>&1 || die 'Нет штатного ucode; точная оценка места недоступна.'
		# Query requested packages, not the old world: a core switch excludes the old variant.
		apk query --recursive --format json --fields name,version,installed-size,file-size "$@" > "$work/plan.json" || die 'Не удалось разрешить зависимости APK.'
		apk query --installed --format json --fields name,version '*' > "$work/installed.json" || die 'Не удалось получить установленные пакеты.'
		ucode "$planner" "$work/plan.json" "$work/installed.json" > "$work/sizes" || die 'Не удалось оценить размер APK.'
		read -r installed_bytes download_bytes < "$work/sizes"
	else
		opkg --noaction install "$@" > "$work/plan.txt" 2>&1 || { cat "$work/plan.txt"; die 'Не удалось разрешить зависимости opkg.'; }
		awk '$1=="Installing" || $1=="Upgrading" {print $2}' "$work/plan.txt" | sort -u > "$work/names"
		installed_bytes=0; download_bytes=0
		while read -r name; do
			[ -n "$name" ] || continue
			opkg_metadata "$name" > "$work/info" || die "Нет метаданных $name."
			values=$(awk '$1=="Installed-Size:" && $2 ~ /^[0-9]+$/ {if($2>i)i=$2;s=1} $1=="Size:" && $2 ~ /^[0-9]+$/ {if($2>d)d=$2;t=1} END {if(!s || !t)exit 1;printf "%.0f %.0f\n",i,d}' "$work/info") || die "Неизвестен размер $name."
			set -- $values
			installed_bytes=$((installed_bytes + $1)); download_bytes=$((download_bytes + $2))
		done < "$work/names"
	fi
}
check_budget() {
	case "$installed_bytes:$download_bytes" in *[!0-9:]*|:*|*:) die 'Некорректные размеры пакетов.' ;; esac
	# Estimates describe logical package sizes, not physical compressed flash usage.
	# Like a normal OpenWrt install, the package manager makes the final space check.
	required_flash=$(((installed_bytes + 1023) / 1024 + 2048))
	required_tmp=$(((download_bytes + 1023) / 1024 + 1024))
	minimum_flash=2048
	[ "$installed_bytes" -lt 8388608 ] || minimum_flash=15360
	read_resources
	printf 'Оценка новых зависимостей: %s МБ без сжатия, загрузка %s МБ.\n' "$(((installed_bytes+1048575)/1048576))" "$(((download_bytes+1048575)/1048576))"
	[ "$flash_free" -ge "$minimum_flash" ] || die "Недостаточно места: нужно минимум $((minimum_flash/1024)) МБ, доступно $((flash_free/1024)) МБ."
	[ "$tmp_free" -ge 1024 ] || die 'В /tmp осталось менее 1 МБ.'
	[ "$flash_free" -ge "$required_flash" ] || echo 'Предупреждение: места меньше оценки без сжатия. Окончательную проверку выполнит пакетный менеджер; установка может не поместиться.'
	[ "$tmp_free" -ge "$required_tmp" ] || echo 'Предупреждение: /tmp меньше общей загрузки. Пакетный менеджер будет устанавливать пакеты штатным способом; при нехватке места установка завершится ошибкой.'
	if [ "$ram_available" -lt 49152 ] || [ "$ram_total" -lt 114688 ]; then
		echo 'Предупреждение: мало ОЗУ. Установка разрешена; для работы выберите облегчённое ядро, минимальные списки и небольшую группу серверов.'
	fi
}
