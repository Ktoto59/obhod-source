const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const INTERVALS = { '1h': 3600e3, '6h': 21600e3, '12h': 43200e3, '24h': 86400e3 };
const PRESET_BASE = 'https://github.com/itdoginfo/allow-domains/releases/latest/download';
const MAX_SIZE = 10 * 1024 * 1024;

class RuleSetService {
  constructor(userDataPath, onEvent) {
    this.directory = path.join(userDataPath, 'rulesets');
    this.onEvent = onEvent;
    this.warnings = [];
  }

  async prepare(config) {
    fs.mkdirSync(this.directory, { recursive: true });
    this.warnings = [];
    const preparedRuleSets = [];
    const maxAge = INTERVALS[config.routing.updateInterval] || INTERVALS['12h'];
    const downloads = (config.routing.presetIds || []).map(async (id) => {
      const filePath = path.join(this.directory, `preset-${id.replace(/[^a-z0-9_-]/gi, '_')}.srs`);
      await this.ensureRemoteFile(`${PRESET_BASE}/${id}.srs`, filePath, id, maxAge);
      preparedRuleSets.push({ id, scope: 'preset', path: filePath, format: 'binary' });
    });
    for (const list of config.routing.remoteLists.filter((item) => item.enabled)) {
      const pathname = new URL(list.url).pathname.toLowerCase();
      const binary = pathname.endsWith('.srs');
      const source = pathname.endsWith('.json');
      const extension = binary ? '.srs' : '.json';
      const filePath = path.join(this.directory, `remote-${list.id.replace(/[^a-z0-9_-]/gi, '_')}${extension}`);
      const fresh = fs.existsSync(filePath) && Date.now() - fs.statSync(filePath).mtimeMs < maxAge;
      if (binary || source) downloads.push(this.ensureRemoteFile(list.url, filePath, list.name, maxAge));
      else if (!fresh) downloads.push(this.downloadPlainList(list, filePath));
      preparedRuleSets.push({ id: list.id, scope: 'remote', path: filePath, format: binary ? 'binary' : 'source' });
    }
    await Promise.all(downloads);
    const localSources = (config.routing.localLists || []).filter((item) => item.enabled);
    return {
      ...config,
      preparedRuleSets,
      ruleStatus: {
        sourcesTotal: preparedRuleSets.length + localSources.length,
        sourcesReady: preparedRuleSets.length + localSources.length,
        knownEntries: localSources.reduce((sum, item) => sum + item.domains.length + item.cidrs.length, 0),
        entriesComplete: true,
        warnings: [...this.warnings]
      }
    };
  }

  countSourceRules(value) {
    const count = (node) => {
      if (Array.isArray(node)) return node.reduce((sum, item) => sum + count(item), 0);
      if (!node || typeof node !== 'object') return 0;
      return Object.entries(node).reduce((sum, [key, item]) => {
        if (['domain', 'domain_suffix', 'domain_keyword', 'domain_regex', 'ip_cidr', 'source_ip_cidr'].includes(key) && Array.isArray(item)) {
          return sum + item.length;
        }
        return sum + count(item);
      }, 0);
    };
    return count(value);
  }

  async inspectPrepared(profile, binary) {
    const status = profile.ruleStatus || { sourcesTotal: 0, sourcesReady: 0, knownEntries: 0, warnings: [] };
    for (const item of profile.preparedRuleSets || []) {
      let sourcePath = item.path;
      let temporaryDirectory = null;
      try {
        if (item.format === 'binary') {
          temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'obhod-rules-inspect-'));
          sourcePath = path.join(temporaryDirectory, 'rules.json');
          await execFileAsync(binary, ['rule-set', 'decompile', item.path, '-o', sourcePath], {
            windowsHide: true, timeout: 15000
          });
        }
        const parsed = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
        status.knownEntries += this.countSourceRules(parsed);
      } catch {
        status.entriesComplete = false;
      } finally {
        if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
    return { ...profile, ruleStatus: status };
  }

  async ensureRemoteFile(url, filePath, name, maxAge) {
    const fresh = fs.existsSync(filePath) && Date.now() - fs.statSync(filePath).mtimeMs < maxAge;
    if (fresh) return;
    this.onEvent('status', `Обновление списка «${name}»…`);
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(25000), redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const declaredSize = Number(response.headers.get('content-length') || 0);
        if (declaredSize > MAX_SIZE) throw new Error('файл больше 10 МБ');
        const data = Buffer.from(await response.arrayBuffer());
        if (data.length > MAX_SIZE) throw new Error('файл больше 10 МБ');
        const temporary = `${filePath}.tmp`;
        fs.writeFileSync(temporary, data, { mode: 0o600 });
        fs.renameSync(temporary, filePath);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (fs.existsSync(filePath)) {
      const warning = `Не удалось обновить «${name}», используется сохранённая копия.`;
      this.warnings.push(warning);
      this.onEvent('status', warning);
      return;
    }
    throw new Error(`Не удалось загрузить список «${name}» после трёх попыток: ${lastError?.message || lastError}`);
  }

  async downloadPlainList(list, filePath) {
    this.onEvent('status', `Загрузка списка «${list.name}»…`);
    const response = await fetch(list.url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
    if (!response.ok) throw new Error(`Не удалось загрузить «${list.name}»: HTTP ${response.status}.`);
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > 10 * 1024 * 1024) throw new Error(`Список «${list.name}» больше 10 МБ.`);
    const text = await response.text();
    if (Buffer.byteLength(text) > 10 * 1024 * 1024) throw new Error(`Список «${list.name}» больше 10 МБ.`);
    const values = [...new Set(text.split(/\r?\n/)
      .map((line) => line.replace(/\s*(?:#|\/\/).*$/, '').trim().toLowerCase())
      .filter(Boolean))].sort();
    const matcher = list.kind === 'cidrs' ? /^[0-9a-f:.]+(?:\/\d{1,3})?$/i : /^\.?[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/i;
    const valid = values.filter((value) => matcher.test(value));
    if (!valid.length) throw new Error(`В списке «${list.name}» не найдено подходящих записей.`);
    const key = list.kind === 'cidrs' ? 'ip_cidr' : 'domain_suffix';
    const source = { version: 3, rules: [{ [key]: valid }] };
    const temporary = `${filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(source), { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  }
}

module.exports = { RuleSetService };
