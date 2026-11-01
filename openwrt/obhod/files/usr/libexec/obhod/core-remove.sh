#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Sourced by the asynchronous core worker while both operation locks are held.
remove_core() {
	detect_manager
	old=$(find_core)
	case "$old" in sing-box|sing-box-tiny) ;; *) die 'Установленный пакет ядра не найден. Файлы стороннего ядра не удалены.' ;; esac
	work=$(mktemp -d /tmp/obhod-core.XXXXXX) || die 'Не удалось создать рабочую папку.'
	printf 'Проверяем зависимости перед удалением…\n' > "$RUN/core-message"
	if [ "$manager" = apk ]; then
		set -- "$old"
		[ "$old" != sing-box-tiny ] || set -- "$@" sing-box
		apk --no-network --simulate del "$@" > "$work/remove-plan" 2>&1 || die 'Пакетный менеджер отклонил удаление ядра.'
		cat "$work/remove-plan"
		# Never remove dependants, orphan libraries or change other packages.
		awk -v name="$old" '/^\([0-9]+\/[0-9]+\)/ {if($2!="Purging" || $3!=name)exit 1; n++} END {if(n!=1)exit 1}' "$work/remove-plan" || die 'Ядро требуется другому пакету или удаление затронет другие пакеты. Операция отменена.'
	else
		opkg --noaction remove "$old" > "$work/remove-plan" 2>&1 || die 'Ядро требуется другому пакету. Удаление отменено.'
		cat "$work/remove-plan"
		awk -v name="$old" '/^Removing package / {if($3!=name)exit 1; n++} END {if(n!=1)exit 1}' "$work/remove-plan" || die 'Не удалось подтвердить удаление только ядра.'
	fi
	/usr/libexec/obhod/control stop || die 'Не удалось выключить службу и восстановить DNS; ядро не удалено.'
	printf 'Удаляем пакет ядра…\n' > "$RUN/core-message"
	if [ "$manager" = apk ]; then apk --no-network del "$@" || die 'Не удалось удалить ядро.'
	else opkg remove "$old" || die 'Не удалось удалить ядро.'; fi
	[ -z "$(find_core)" ] || die 'Пакет ядра остался установленным. Проверьте зависимости.'
	rm -f "$RUN/core-version-key" "$RUN/core-version" "$RUN/core-capabilities"
}
