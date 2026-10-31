const { parseProxyUri, validateConnection } = require('./profile');

const MAX_SUBSCRIPTION_BYTES = 2 * 1024 * 1024;
const MAX_SUBSCRIPTION_CONNECTIONS = 500;
const SUPPORTED_SCHEMES = /^(vless|trojan|ss|hysteria2|hy2|tuic|anytls|socks5|socks|https?):\/\//i;

function parseSubscription(input) {
  let text = String(input ?? '').replace(/^\uFEFF/, '').trim();
  if (Buffer.byteLength(text) > MAX_SUBSCRIPTION_BYTES) throw new Error('Подписка больше 2 МБ.');
  // V2Ray subscriptions may encode the entire newline-separated list as Base64.
  if (text && /^[a-z0-9+/_=\s-]+$/i.test(text)) {
    const encoded = text.replace(/\s/g, '');
    if (encoded.length % 4 === 1) throw new Error('Некорректный Base64 в подписке.');
    text = Buffer.from(encoded, 'base64url').toString('utf8').replace(/^\uFEFF/, '').trim();
  }
  const lines = text.split(/\r?\n/).map((line, index) => ({ value: line.trim(), number: index + 1 }))
    .filter(({ value }) => value && !value.startsWith('#'));
  if (!lines.length) throw new Error('В подписке нет подключений.');
  if (lines.length > MAX_SUBSCRIPTION_CONNECTIONS) throw new Error('В подписке больше 500 подключений.');
  return lines.map(({ value, number }) => {
    if (!SUPPORTED_SCHEMES.test(value)) {
      throw new Error(`Неподдерживаемый формат подключения в строке ${number}. Поддерживаются VLESS, Trojan, Shadowsocks, Hysteria2, TUIC, AnyTLS, SOCKS5 и HTTP(S).`);
    }
    try {
      const tunnel = parseProxyUri(value, `Сервер ${number}`);
      const url = new URL(value);
      const transport = url.searchParams.get('type');
      if (transport && !['tcp', 'none', 'ws', 'grpc', 'http'].includes(transport)) {
        throw new Error('unsupported transport');
      }
      return tunnel;
    } catch {
      // URL/parser errors can contain credentials: never include their raw message.
      throw new Error(`Некорректное или несовместимое подключение в строке ${number}. Проверьте протокол, транспорт и параметры сервера.`);
    }
  });
}

function connectionIdentity(input) {
  const { id, name, ...connection } = validateConnection(input);
  return JSON.stringify(connection);
}

function mergeSubscription(existing, incoming) {
  const seen = new Set(existing.map(connectionIdentity));
  const tunnels = [];
  let duplicates = 0;
  for (const tunnel of incoming) {
    const key = connectionIdentity(tunnel);
    if (seen.has(key)) { duplicates += 1; continue; }
    seen.add(key);
    tunnels.push(tunnel);
  }
  return { tunnels, duplicates };
}

async function loadSubscription(source, { fetchImpl = fetch } = {}) {
  const text = String(source ?? '').trim();
  // Pasted lists and their Base64 representation work without a network request.
  if (!/^https?:\/\/\S+$/i.test(text)) return parseSubscription(text);
  let url;
  try { url = new URL(text); } catch { throw new Error('Некорректный URL подписки.'); }
  if (url.username || url.password) throw new Error('URL подписки не должен содержать логин и пароль. Для HTTP-прокси выберите «Одно подключение».');
  let response;
  try {
    response = await fetchImpl(url.href, {
      signal: AbortSignal.timeout(20000), redirect: 'follow',
      headers: { Accept: 'text/plain', 'User-Agent': 'v2rayN/Obhod' }
    });
    if (!response.ok) throw new Error(`Сервер подписки ответил HTTP ${response.status}.`);
    if (Number(response.headers.get('content-length')) > MAX_SUBSCRIPTION_BYTES) throw new Error('Подписка больше 2 МБ.');
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > MAX_SUBSCRIPTION_BYTES) throw new Error('Подписка больше 2 МБ.');
      chunks.push(Buffer.from(chunk));
    }
    return parseSubscription(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (/^(Сервер подписки|Подписка больше|В подписке|Неподдерживаемый формат|Некорректн)/.test(error.message)) throw error;
    throw new Error('Не удалось загрузить подписку. Проверьте ссылку и доступ к серверу.');
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

module.exports = { MAX_SUBSCRIPTION_BYTES, MAX_SUBSCRIPTION_CONNECTIONS, parseSubscription, loadSubscription, mergeSubscription };
