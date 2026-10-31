const fs = require('node:fs');

async function applyImport({ store, recovery, service, candidate }) {
  const previous = store.load();
  // Check before touching either the profile or the active connection.
  if (candidate.tunnels.length) await service.checkProfile(candidate);
  const wasRunning = service.isRunning();
  const existed = fs.existsSync(store.filePath);
  const original = existed ? fs.readFileSync(store.filePath) : null;
  const checkpoint = `${store.filePath}.before-import`;
  if (original) {
    fs.writeFileSync(`${checkpoint}.tmp`, original, { mode: 0o600 });
    fs.renameSync(`${checkpoint}.tmp`, checkpoint);
  }
  try {
    await recovery.stop();
    const profile = store.save(candidate);
    if (wasRunning && profile.tunnels.length) await recovery.start(profile);
    return { profile, status: service.status(), checkpoint: Boolean(original) };
  } catch {
    let rollbackFailed = false;
    try { await recovery.stop(); } catch { rollbackFailed = true; }
    try {
      if (original) {
        fs.writeFileSync(`${store.filePath}.tmp`, original, { mode: 0o600 });
        fs.renameSync(`${store.filePath}.tmp`, store.filePath);
      } else if (fs.existsSync(store.filePath)) fs.unlinkSync(store.filePath);
    } catch {
      throw new Error('Импорт не завершён. Не удалось вернуть файл настроек. Предыдущая копия сохранена рядом с профилем как profile.json.before-import.');
    }
    if (wasRunning) {
      try { await recovery.start(previous); } catch { rollbackFailed = true; }
    }
    throw new Error(rollbackFailed
      ? 'Импорт отменён, прежние настройки возвращены. Подключение нужно включить вручную.'
      : 'Импорт отменён. Прежние настройки и состояние подключения восстановлены.');
  }
}

module.exports = { applyImport };
