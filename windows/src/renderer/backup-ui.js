(() => {
  const page = document.getElementById('settings-backup');
  page.insertAdjacentHTML('beforeend', `
    <div class="backup-options">
      <section class="panel"><h2>Сохранить копию</h2><p>Все подключения и настройки — в одном файле. Для полной копии понадобится пароль.</p><button id="openBackupExport" class="primary">Экспортировать</button></section>
      <section class="panel"><h2>Восстановить из файла</h2><p>Откройте ранее сохранённую копию. Перед импортом вы увидите её состав и выберете, как применить настройки.</p><button id="openBackupImport" class="secondary">Импортировать</button></section>
    </div>
    <p class="backup-note">Экспортируются сохранённые настройки. Сначала сохраните изменения в других разделах, если хотите включить их в копию.</p>
    <p id="backupResult" role="status" class="backup-note"></p>`);
  document.body.insertAdjacentHTML('beforeend', `
    <dialog id="exportBackupDialog" class="backup-dialog"><form>
      <div class="dialog-head"><h2>Сохранить конфигурацию</h2><button type="button" class="close" data-backup-close aria-label="Закрыть">×</button></div>
      <label>Что сохранить<select id="backupKind"><option value="full">Все подключения и настройки</option><option value="rules">Только свои списки сайтов и готовые наборы</option></select></label>
      <div id="backupPasswordFields"><p class="backup-note">Пароль защищает ключи и данные подключений. Он понадобится для восстановления копии.</p>
        <label>Пароль, не менее 10 символов<input id="backupPassword" type="password" autocomplete="new-password" minlength="10" maxlength="1024" required></label>
        <label>Повторите пароль<input id="backupPasswordRepeat" type="password" autocomplete="new-password" maxlength="1024" required></label></div>
      <p id="backupRulesNote" class="backup-note" hidden>Подключения, внешние ссылки и правила программ не попадут в этот файл. Списки сайтов сохранятся без пароля.</p>
      <p id="backupExportError" class="backup-error" role="alert"></p>
      <div class="dialog-actions"><button type="button" class="secondary" data-backup-close>Отмена</button><button id="saveBackupFile" class="primary" type="submit">Сохранить файл</button></div>
    </form></dialog>
    <dialog id="importBackupDialog" class="backup-dialog"><form>
      <div class="dialog-head"><h2>Импорт конфигурации</h2><button type="button" class="close" data-backup-close aria-label="Закрыть">×</button></div>
      <p id="backupFileName" class="backup-note"></p>
      <label id="importPasswordLabel">Пароль копии<input id="importPassword" type="password" autocomplete="off" maxlength="1024"></label>
      <div id="backupPreview" hidden><div id="backupSummary" class="backup-summary"></div>
        <label>Как применить<select id="backupImportMode"><option value="merge">Добавить к моим настройкам</option><option value="replace">Заменить текущие настройки</option></select></label>
        <p id="backupModeHint" class="backup-note"></p>
        <p id="backupPathHint" class="backup-note" hidden>Правила программ будут выключены: проверьте пути к ним на этом компьютере и включите нужные правила.</p>
        <p class="backup-note">Перед импортом сохраняется копия для отката. Если Обход включён, соединение будет перезапущено.</p>
      </div>
      <p id="backupImportError" class="backup-error" role="alert"></p>
      <div class="dialog-actions"><button type="button" class="secondary" data-backup-close>Отмена</button><button id="applyBackup" type="submit" class="primary">Посмотреть содержимое</button></div>
    </form></dialog>`);
  let busy = false;
  let summary = null;
  const errorText = (error) => cleanErrorMessage(error);
  function setBusy(value, dialog) {
    busy = value;
    dialog.querySelectorAll('button, input, select').forEach((element) => { element.disabled = value; });
    dialog.setAttribute('aria-busy', String(value));
  }
  function modeHint() {
    const replacing = $('backupImportMode').value === 'replace';
    $('backupModeHint').textContent = summary?.kind === 'rules'
      ? (replacing ? 'Заменятся только свои списки сайтов и готовые наборы. Подключения останутся.' : 'Списки сайтов добавятся к текущим. Подключения останутся.')
      : (replacing ? 'Подключения и правила будут заменены содержимым файла. Параметры запуска Windows останутся прежними.' : 'Подключения и списки добавятся отдельно. Совпадающие названия не перезапишут ваши подключения. Текущий маршрут и параметры сети останутся.');
  }
  $('backupImportMode').addEventListener('change', modeHint);
  document.querySelectorAll('[data-backup-close]').forEach((button) => button.addEventListener('click', () => {
    if (!busy) button.closest('dialog').close();
  }));
  for (const id of ['exportBackupDialog', 'importBackupDialog']) {
    $(id).addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
    $(id).addEventListener('close', () => {
      $(id).querySelectorAll('input[type="password"]').forEach((input) => { input.value = ''; });
      if (id === 'importBackupDialog') { summary = null; window.obhod.cancelBackup().catch(() => {}); }
    });
  }
  $('openBackupExport').addEventListener('click', () => {
    $('backupExportError').textContent = ''; $('exportBackupDialog').showModal();
  });
  $('backupKind').addEventListener('change', () => {
    const full = $('backupKind').value === 'full';
    $('backupPasswordFields').hidden = !full; $('backupRulesNote').hidden = full;
    for (const id of ['backupPassword', 'backupPasswordRepeat']) { $(id).required = full; $(id).value = ''; }
  });
  $('exportBackupDialog').querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy) return;
    const dialog = $('exportBackupDialog'); $('backupExportError').textContent = '';
    if ($('backupKind').value === 'full' && $('backupPassword').value !== $('backupPasswordRepeat').value) {
      $('backupExportError').textContent = 'Пароли не совпадают.'; return;
    }
    setBusy(true, dialog);
    try {
      const result = await window.obhod.exportBackup({ kind: $('backupKind').value, password: $('backupPassword').value });
      if (!result.canceled) { $('backupResult').textContent = 'Копия сохранена.'; dialog.close(); }
    } catch (error) { $('backupExportError').textContent = errorText(error); }
    finally { $('backupPassword').value = ''; $('backupPasswordRepeat').value = ''; setBusy(false, dialog); }
  });
  async function preview() {
    summary = await window.obhod.previewBackup($('importPassword').value);
    $('importPassword').value = ''; $('importPasswordLabel').hidden = true;
    $('backupSummary').textContent = `Подключения: ${summary.tunnels}\nСвои списки сайтов: ${summary.localLists}\nГотовые наборы: ${summary.presets}\nВнешние списки: ${summary.remoteLists}\nПравила программ: ${summary.applications}`
      + (summary.conflicts ? `\nСовпадающие подключения: ${summary.conflicts}` : '');
    $('backupPathHint').hidden = !summary.applications;
    $('backupPreview').hidden = false; $('applyBackup').textContent = 'Импортировать';
    modeHint();
  }
  $('openBackupImport').addEventListener('click', async () => {
    if (busy) return;
    $('openBackupImport').disabled = true;
    try {
      const result = await window.obhod.chooseBackup(); if (result.canceled) return;
      summary = null; $('backupPreview').hidden = true; $('backupImportError').textContent = '';
      $('backupFileName').textContent = result.name; $('importPasswordLabel').hidden = !result.encrypted;
      $('backupImportMode').value = 'merge'; $('applyBackup').textContent = 'Посмотреть содержимое';
      $('importBackupDialog').showModal();
      if (!result.encrypted) {
        setBusy(true, $('importBackupDialog'));
        try { await preview(); } finally { setBusy(false, $('importBackupDialog')); }
      } else $('importPassword').focus();
    } catch (error) { $('backupResult').textContent = errorText(error); }
    finally { $('openBackupImport').disabled = false; }
  });
  $('importBackupDialog').querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (busy) return;
    const dialog = $('importBackupDialog'); $('backupImportError').textContent = '';
    setBusy(true, dialog);
    try {
      if (!summary) await preview();
      else {
        $('applyBackup').textContent = 'Импортируем…';
        const result = await window.obhod.importBackup($('backupImportMode').value);
        config = result.profile; running = result.status.running;
        serviceStartedAt = result.status.startedAt || null; ruleStatus = result.status.ruleStatus || null;
        renderAll(); setRoutingDirty(false); openTunnelEditor(config.tunnels[0]?.id || null);
        $('backupResult').textContent = 'Настройки импортированы. ' + (result.checkpoint ? 'Предыдущая копия сохранена для отката.' : '');
        dialog.close();
      }
    } catch (error) {
      $('backupImportError').textContent = errorText(error);
      if (summary) {
        summary = null; $('backupPreview').hidden = true;
        $('applyBackup').textContent = 'Выберите файл заново'; $('applyBackup').hidden = true;
        config = await window.obhod.loadProfile(); const status = await window.obhod.status();
        running = status.running; renderAll(); setRoutingDirty(false);
      }
    } finally { $('importPassword').value = ''; setBusy(false, dialog); }
  });
  $('importBackupDialog').addEventListener('close', () => { $('applyBackup').hidden = false; });
})();
