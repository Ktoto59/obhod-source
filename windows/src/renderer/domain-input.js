(function (root) {
  function normalizeDomains(value) {
    const entries = Array.isArray(value) ? value : String(value || '').split(/[\r\n\s,]+/);
    return [...new Set(entries.filter(Boolean).map((entry) => {
      let host;
      try {
        const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(entry) ? entry : `https://${entry}`);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
        host = url.hostname.toLowerCase().replace(/\.$/, '');
        if (host.length > 253 || !host.includes('.') || /^\d+(\.\d+){3}$/.test(host)
          || !host.split('.').every((part) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(part))) throw new Error();
      } catch {
        throw new Error('Введите домен или ссылку HTTP(S), например example.com. IP-адреса добавляйте в поле «IP и подсети».');
      }
      return host;
    }))];
  }
  if (typeof module === 'object' && module.exports) module.exports = { normalizeDomains };
  else root.normalizeDomains = normalizeDomains;
})(globalThis);
