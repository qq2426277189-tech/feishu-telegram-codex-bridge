'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function env(name) {
  const value = process.env[name];
  return value === undefined ? '' : String(value).trim();
}

function envBool(name, fallback) {
  const value = env(name).toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function expandPath(value, rootDir) {
  let result = String(value || '').trim();
  if (!result) return '';
  if (result === '~') result = os.homedir();
  else if (result.startsWith('~/') || result.startsWith('~\\')) result = path.join(os.homedir(), result.slice(2));
  result = result.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env(name));
  if (!path.isAbsolute(result)) result = path.resolve(rootDir, result);
  return path.normalize(result);
}

function parseIntSafe(value, fallback, min = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min ? Math.floor(number) : fallback;
}

function parseAllowedUsers(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  return String(value || '').split(',').map(Number).filter(Number.isFinite);
}

function readJson(filePath, required) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    if (required) throw new Error(`Unable to read JSON config ${filePath}: ${error.message}`);
    return {};
  }
}

function loadConfig(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, '..'));
  const configPath = expandPath(env('BRIDGE_CONFIG') || path.join(rootDir, 'config.json'), rootDir);
  const exists = fs.existsSync(configPath);
  if (!exists && !options.allowMissing) {
    throw new Error(`Missing ${configPath}. Copy config.example.json to config.json and fill in your own values.`);
  }
  const raw = exists ? readJson(configPath, true) : {};
  const dataDir = expandPath(env('BRIDGE_DATA_DIR') || raw.storage?.dataDir || './data', rootDir);
  const codexHome = expandPath(env('CODEX_HOME') || raw.codex?.home || path.join(os.homedir(), '.codex'), rootDir);
  const codexCwd = expandPath(env('CODEX_CWD') || raw.codex?.cwd || path.join(dataDir, 'workspace'), rootDir);
  const outputsDir = expandPath(raw.storage?.outputsDir || path.join(dataDir, 'outputs'), rootDir);
  const downloadsDir = expandPath(raw.storage?.downloadsDir || path.join(dataDir, 'downloads'), rootDir);
  const tempDir = expandPath(raw.storage?.tempDir || path.join(dataDir, 'temp'), rootDir);
  const settingsPath = expandPath(env('CC_SWITCH_SETTINGS') || raw.ccSwitch?.settingsPath || path.join(os.homedir(), '.cc-switch', 'settings.json'), rootDir);
  const larkCliPath = expandPath(env('LARK_CLI_PATH') || raw.feishu?.larkCliPath || '', rootDir);
  const allowedUserIds = parseAllowedUsers(env('TELEGRAM_ALLOWED_USER_IDS') || raw.telegram?.allowedUserIds || []);
  const agentsFiles = (env('BRIDGE_AGENTS_FILES') ? env('BRIDGE_AGENTS_FILES').split(';') : (Array.isArray(raw.sync?.agentsFiles) ? raw.sync.agentsFiles : []))
    .map(value => expandPath(value, rootDir)).filter(Boolean);
  const config = {
    rootDir,
    configPath,
    exists,
    feishu: {
      enabled: envBool('FEISHU_ENABLED', raw.feishu?.enabled !== false),
      larkCliPath,
      ailyBin: larkCliPath ? path.dirname(larkCliPath) : '',
      appId: env('FEISHU_APP_ID') || String(raw.feishu?.appId || '').trim(),
      chatId: env('FEISHU_CHAT_ID') || String(raw.feishu?.chatId || '').trim(),
      notifyChatId: env('FEISHU_NOTIFY_CHAT_ID') || String(raw.feishu?.notifyChatId || raw.feishu?.chatId || '').trim()
    },
    telegram: {
      enabled: envBool('TELEGRAM_ENABLED', raw.telegram?.enabled !== false),
      botToken: env('TELEGRAM_BOT_TOKEN') || String(raw.telegram?.botToken || '').trim(),
      allowedUserIds,
      notifyChatId: Number(env('TELEGRAM_NOTIFY_CHAT_ID') || raw.telegram?.notifyChatId || allowedUserIds[0] || 0),
      proxyUrl: env('TELEGRAM_PROXY_URL') || String(raw.telegram?.proxyUrl || '').trim(),
      offsetFile: expandPath(raw.telegram?.offsetFile || path.join(dataDir, 'telegram-offset.json'), rootDir)
    },
    codex: {
      executable: expandPath(env('CODEX_EXECUTABLE') || raw.codex?.executable || '', rootDir),
      home: codexHome,
      cwd: codexCwd,
      timeoutMs: parseIntSafe(raw.codex?.timeoutMs, 20 * 60 * 1000, 1000),
      probeTimeoutMs: parseIntSafe(raw.codex?.probeTimeoutMs, 90 * 1000, 1000)
    },
    ccSwitch: {
      enabled: raw.ccSwitch?.enabled !== false,
      settingsPath
    },
    storage: {
      dataDir,
      outputsDir,
      downloadsDir,
      tempDir,
      stateFile: path.join(dataDir, 'state.json'),
      replyFile: path.join(dataDir, 'last-reply.txt'),
      logFile: path.join(dataDir, 'bridge.log'),
      sharedMemoryFile: path.join(dataDir, 'shared-memory.md'),
      auditFile: path.join(dataDir, 'audit.jsonl'),
      taskHistoryFile: path.join(dataDir, 'task-history.jsonl'),
      healthFile: path.join(dataDir, 'health.json'),
      pidFile: path.join(dataDir, 'bridge.pid'),
      deliveredFilesFile: path.join(dataDir, 'delivered-files.json'),
      artifactRetentionMs: parseIntSafe(raw.storage?.artifactRetentionHours, 24, 0) * 60 * 60 * 1000
    },
    limits: {
      healthCheckMs: parseIntSafe(raw.limits?.healthCheckMs, 15 * 60 * 1000, 10000),
      healthAlertDedupMs: parseIntSafe(raw.limits?.healthAlertDedupMs, 30 * 60 * 1000, 10000),
      maxTaskHistory: parseIntSafe(raw.limits?.maxTaskHistory, 500, 1),
      maxReply: parseIntSafe(raw.limits?.maxReply, 4000, 500),
      maxTurnsPerSession: parseIntSafe(raw.limits?.maxTurnsPerSession, 20, 1),
      batchWaitMs: parseIntSafe(raw.limits?.batchWaitMs, 5000, 0),
      maxArchive: parseIntSafe(raw.limits?.maxArchive, 8, 0),
      modelWatchMs: parseIntSafe(raw.limits?.modelWatchMs, 5000, 1000),
      modelSwitchSettleMs: parseIntSafe(raw.limits?.modelSwitchSettleMs, 2500, 0),
      modelProbeRetryMs: parseIntSafe(raw.limits?.modelProbeRetryMs, 5 * 60 * 1000, 1000)
    },
    protocolFile: expandPath(raw.protocol?.path || path.join(rootDir, 'docs', 'REMOTE_TASK_PROTOCOL.md'), rootDir),
    sync: { agentsFiles }
  };

  if (!options.allowMissing) {
    if (config.feishu.enabled && (!config.feishu.larkCliPath || !config.feishu.chatId)) {
      throw new Error('Feishu is enabled but feishu.larkCliPath or feishu.chatId is missing.');
    }
    if (config.telegram.enabled && (!config.telegram.botToken || !config.telegram.allowedUserIds.length)) {
      throw new Error('Telegram is enabled but telegram.botToken or telegram.allowedUserIds is missing.');
    }
  }
  return config;
}

module.exports = { loadConfig, expandPath };
