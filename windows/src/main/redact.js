function redactSensitive(input) {
  return String(input ?? '')
    .replace(/(?:vless|trojan|ss|hysteria2|hy2|tuic|anytls):\/\/\S+/gi, '[ссылка подключения скрыта]')
    .replace(/\b[a-z]:\\(?:[^\\\r\n"]+\\)+([^\\\r\n"]+\.exe)\b/gi, '[путь приложения скрыт]\\$1')
    .replace(/((?:private[_ -]?key|pre[_ -]?shared[_ -]?key|obfs[_ -]?password|password|passwd|uuid|token)\s*[:=]\s*)\S+/gi, '$1[скрыто]')
    .replace(/("(?:private_key|pre_shared_key|preshared_key|obfs_password|password|uuid)"\s*:\s*")[^"]+("\s*[,}])/gi, '$1[скрыто]$2');
}

module.exports = { redactSensitive };
