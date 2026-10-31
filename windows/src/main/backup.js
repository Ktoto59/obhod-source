const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { validateConfig } = require('../../../shared/profile');
const scrypt = promisify(crypto.scrypt);
const MAX_BYTES = 16 * 1024 * 1024;
const FORMAT = 'obhod-backup';
const AAD = Buffer.from('obhod-backup:1:full');

function checkProfile(profile) {
  if (!profile || profile.version !== 6 || !Array.isArray(profile.tunnels) || !profile.routing) {
    throw new Error('Эта версия конфигурации не поддерживается. Обновите Обход.');
  }
  try { return validateConfig(profile); }
  catch { throw new Error('В файле есть некорректные настройки. Импорт отменён.'); }
}

async function keyFor(password, salt) {
  if (typeof password !== 'string' || password.length > 1024) throw new Error('Некорректный пароль.');
  return scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function inspectBackup(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw new Error('Файл слишком большой (максимум 16 МБ).');
  let file;
  try { file = JSON.parse(text); } catch { throw new Error('Не удалось прочитать файл конфигурации Обхода.'); }
  if (!file || file.format !== FORMAT || file.version !== 1 || !['full', 'rules'].includes(file.kind)) {
    throw new Error('Неизвестный формат файла. Выберите экспорт конфигурации Обхода.');
  }
  return file;
}

async function encodeBackup(input, kind, password) {
  const profile = checkProfile(input);
  let file;
  if (kind === 'rules') {
    // Explicit allowlist: URLs can contain credentials or subscription tokens.
    file = { format: FORMAT, version: 1, kind, rules: {
      presetIds: profile.routing.presetIds, localLists: profile.routing.localLists
    } };
  } else if (kind === 'full') {
    if (typeof password !== 'string' || password.length < 10) throw new Error('Придумайте пароль длиной не менее 10 символов.');
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = await keyFor(password, salt);
    try {
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(AAD);
      const data = Buffer.concat([cipher.update(JSON.stringify(profile), 'utf8'), cipher.final()]);
      file = { format: FORMAT, version: 1, kind, salt: salt.toString('base64'), iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    } finally { key.fill(0); }
  } else throw new Error('Неизвестный вариант экспорта.');
  const text = JSON.stringify(file, null, 2);
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Конфигурация превышает 16 МБ.');
  return text;
}

async function decodeBackup(text, password) {
  const file = inspectBackup(text);
  if (file.kind === 'rules') {
    if (!file.rules || !Array.isArray(file.rules.presetIds) || !Array.isArray(file.rules.localLists)) throw new Error('Повреждён список правил.');
    const profile = checkProfile({ version: 6, tunnels: [], routing: {
      presetIds: file.rules.presetIds, localLists: file.rules.localLists
    } });
    return { kind: 'rules', profile };
  }
  const bytes = (name, length) => {
    if (typeof file[name] !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file[name])) throw new Error('Повреждён файл конфигурации.');
    const value = Buffer.from(file[name], 'base64');
    if ((length && value.length !== length) || !value.length) throw new Error('Повреждён файл конфигурации.');
    return value;
  };
  const salt = bytes('salt', 16), iv = bytes('iv', 12), tag = bytes('tag', 16), data = bytes('data');
  const key = await keyFor(password, salt);
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(AAD); decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch { throw new Error('Неверный пароль или файл повреждён. Настройки не изменены.'); }
  finally { key.fill(0); }
  try { return { kind: 'full', profile: checkProfile(JSON.parse(plain.toString('utf8'))) }; }
  catch { throw new Error('В файле есть несовместимые настройки. Импорт отменён.'); }
  finally { plain.fill(0); }
}

function prepareImport(currentInput, decoded, mode) {
  if (!['merge', 'replace'].includes(mode)) throw new Error('Выберите способ импорта.');
  const current = checkProfile(currentInput);
  const incoming = checkProfile(decoded.profile);
  const result = structuredClone(mode === 'replace' && decoded.kind === 'full' ? incoming : current);
  const remap = (items) => items.map((item) => ({ ...item, id: crypto.randomUUID() }));
  if (decoded.kind === 'rules') {
    result.routing.localLists = mode === 'replace' ? remap(incoming.routing.localLists)
      : [...current.routing.localLists, ...remap(incoming.routing.localLists)];
    result.routing.presetIds = mode === 'replace' ? incoming.routing.presetIds
      : [...new Set([...current.routing.presetIds, ...incoming.routing.presetIds])];
  } else {
    incoming.routing.applicationRules.forEach((rule) => { rule.enabled = false; rule.needsReview = true; });
    if (mode === 'merge') {
      const ids = new Map(incoming.tunnels.map((item) => [item.id, crypto.randomUUID()]));
      result.tunnels.push(...incoming.tunnels.map((item) => ({ ...item, id: ids.get(item.id) })));
      result.routing.localLists.push(...remap(incoming.routing.localLists));
      result.routing.remoteLists.push(...remap(incoming.routing.remoteLists));
      result.routing.applicationRules.push(...remap(incoming.routing.applicationRules));
      result.routing.presetIds = [...new Set([...current.routing.presetIds, ...incoming.routing.presetIds])];
      if (!current.tunnels.length) {
        result.routing.activeTunnelId = ids.get(incoming.routing.activeTunnelId) || null;
        result.routing.failoverTunnelIds = incoming.routing.failoverTunnelIds.map((id) => ids.get(id));
        result.routing.failoverEnabled = incoming.routing.failoverEnabled;
      }
    } else result.routing.applicationRules = incoming.routing.applicationRules;
    // Startup is a property of this installation, not of the imported machine.
    result.routing.launchAtLogin = current.routing.launchAtLogin;
    result.routing.startOnLaunch = current.routing.startOnLaunch;
    result.routing.onboardingCompleted = current.routing.onboardingCompleted;
  }
  return checkProfile(result);
}

function importSummary(current, decoded) {
  const p = decoded.profile;
  return { kind: decoded.kind, tunnels: p.tunnels.length, localLists: p.routing.localLists.length,
    presets: p.routing.presetIds.length, remoteLists: p.routing.remoteLists.length,
    applications: p.routing.applicationRules.length,
    conflicts: p.tunnels.filter((t) => current.tunnels.some((c) => c.id === t.id || c.name === t.name)).length };
}

module.exports = { MAX_BYTES, encodeBackup, decodeBackup, inspectBackup, prepareImport, importSummary };
