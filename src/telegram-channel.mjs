// Telegram 通道适配层
// 只负责：长轮询收消息、白名单、发送文本/图片/文件、状态回报。
// 不负责模型调用和工具执行；执行统一交给飞书 bridge 的内核。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyAgent, FormData, fetch as undiciFetch } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'config.json');
const DEFAULT_OFFSET_PATH = path.join(ROOT, 'data', 'telegram-offset.json');
let offsetPath = DEFAULT_OFFSET_PATH;
const TOKEN_RE = /^\d{8,12}:[A-Za-z0-9_-]{30,}$/;

let cfg = null;
let token = '';
let api = '';
let dispatcher;
let handlers = {};
let running = false;
let offset = 0;
let pollTimer = null;
let botUsername = '';
let lastPollAt = 0;
let lastError = '';
let pollCount = 0;

function log(...args) { const message = args.map(x => String(x)).join(' '); if (handlers.onLog) { try { handlers.onLog(message); return; } catch (_) {} } console.log('[tg-channel]', ...args); }

function loadOffset() {
  try {
    const n = Number(JSON.parse(fs.readFileSync(offsetPath, 'utf8')).offset || 0);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

function saveOffset(n) {
  offset = Math.max(offset, Number(n) || 0);
  try { fs.mkdirSync(path.dirname(offsetPath), { recursive: true }); fs.writeFileSync(offsetPath, JSON.stringify({ offset }, null, 2), 'utf8'); } catch (_) {}
}

function loadConfig(source) {
  const raw = source || JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
  const t = String(raw.botToken || '').trim();
  if (!TOKEN_RE.test(t)) throw new Error('botToken 格式不正确');
  const allowed = Array.isArray(raw.allowedUserIds) ? raw.allowedUserIds.map(Number).filter(Number.isFinite) : [];
  return {
    botToken: t,
    allowedUserIds: allowed,
    proxyUrl: String(raw.proxyUrl || '').trim(),
  };
}

async function tg(method, payload, { timeoutMs = 30000, httpMethod = '' } = {}) {
  const useGet = String(httpMethod).toUpperCase() === 'GET';
  let url = `${api}/${method}`;
  if (useGet && payload) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(payload)) {
      if (value === undefined || value === null) continue;
      query.set(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
    }
    url += '?' + query.toString();
  }
  const opts = {
    method: useGet ? 'GET' : (payload ? 'POST' : 'GET'),
    headers: useGet ? undefined : { 'Content-Type': 'application/json' },
    dispatcher,
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (payload && !useGet) opts.body = JSON.stringify(payload);
  const res = await undiciFetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`${method} 失败: ${json.description || `HTTP ${res.status}`}`);
  return json.result;
}

function isAllowed(userId) {
  return cfg.allowedUserIds.length > 0 && cfg.allowedUserIds.includes(Number(userId));
}

function replyParams(messageId) {
  const n = Number(messageId);
  return Number.isFinite(n) ? { message_id: n, allow_sending_without_reply: true } : undefined;
}

export async function sendText(chatId, messageId, text) {
  if (!cfg) throw new Error('Telegram 通道未初始化');
  const full = String(text ?? '');
  const chunks = [];
  if (full.length <= 3900) chunks.push(full);
  else {
    for (let i = 0; i < full.length; i += 3800) chunks.push(full.slice(i, i + 3800));
  }
  let lastId = null;
  for (let i = 0; i < chunks.length; i++) {
    const payload = { chat_id: chatId, text: chunks[i] || '(空)' };
    const rp = replyParams(messageId);
    if (rp && i === 0) payload.reply_parameters = rp;
    const result = await tg('sendMessage', payload);
    lastId = result?.message_id ?? lastId;
  }
  return { ok: true, messageId: lastId };
}

async function sendMultipart(method, field, chatId, messageId, filePath, caption = '') {
  if (!cfg) throw new Error('Telegram 通道未初始化');
  const form = new FormData();
  form.append('chat_id', String(chatId));
  const rp = replyParams(messageId);
  if (rp) form.append('reply_parameters', JSON.stringify(rp));
  if (caption) form.append('caption', String(caption));
  const data = fs.readFileSync(filePath);
  const blob = new Blob([data], { type: 'application/octet-stream' });
  form.append(field, blob, path.basename(filePath));
  const res = await undiciFetch(`${api}/${method}`, { method: 'POST', body: form, dispatcher, signal: AbortSignal.timeout(120000) });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`${method} 失败: ${json.description || `HTTP ${res.status}`}`);
  return { ok: true, messageId: json.result?.message_id ?? null };
}

export async function sendPhoto(chatId, messageId, filePath) {
  return sendMultipart('sendPhoto', 'photo', chatId, messageId, filePath);
}

export async function sendDocument(chatId, messageId, filePath, caption = '') {
  return sendMultipart('sendDocument', 'document', chatId, messageId, filePath, caption);
}

export async function sendTyping(chatId) {
  try { await tg('sendChatAction', { chat_id: chatId, action: 'typing' }, { timeoutMs: 10000 }); } catch (_) {}
}

async function handleUpdate(update) {
  const msg = update?.message;
  if (!msg || !msg.from || !msg.text) return;
  const from = msg.from;
  const chatId = msg.chat?.id;
  const text = String(msg.text || '').trim();
  if (!chatId || !text) return;

  if (!isAllowed(from.id)) {
    log('拒绝未授权 Telegram 用户', from.id);
    try { await sendText(chatId, msg.message_id, `未授权。你的 Telegram ID 是 ${from.id}`); } catch (_) {}
    return;
  }

  try {
    if (/^(状态|健康|health|status|\/status)$/i.test(text)) {
      const card = handlers.onStatus ? await handlers.onStatus() : 'Telegram 通道在线';
      await sendText(chatId, msg.message_id, card);
      return;
    }
    if (/^(重新开始|\/reset)$/i.test(text)) {
      if (handlers.onReset) await handlers.onReset(chatId);
      await sendText(chatId, msg.message_id, '已清空这个 Telegram 对话的记忆。');
      return;
    }
    if (!handlers.onMessage) throw new Error('未配置任务执行回调');
    await sendTyping(chatId);
    await handlers.onMessage({
      chatId,
      messageId: msg.message_id,
      userId: from.id,
      username: from.username || '',
      text,
      at: new Date().toISOString(),
    });
  } catch (e) {
    lastError = e.message;
    log('处理消息失败:', e.message);
    try { await sendText(chatId, msg.message_id, `处理失败：${e.message}`); } catch (_) {}
  }
}

async function pollOnce() {
  const result = await tg('getUpdates', {
    offset: offset || undefined,
    timeout: 10,
    allowed_updates: ['message'],
  }, { timeoutMs: 20000, httpMethod: 'GET' });
  lastPollAt = Date.now();
  pollCount++;
  lastError = '';
  if (Array.isArray(result) && result.length) {
    for (const update of result) {
      saveOffset(Number(update.update_id) + 1);
      void handleUpdate(update);
    }
  }
}

async function pollLoop() {
  let backoff = 1000;
  while (running) {
    try {
      await pollOnce();
      backoff = 1000;
    } catch (e) {
      const cause = e && e.cause ? (e.cause.code || e.cause.message || '') : '';
      lastError = e.message + (cause ? ' / ' + cause : '');
      log('轮询失败:', lastError);
      await new Promise(r => { pollTimer = setTimeout(r, backoff); });
      backoff = Math.min(backoff * 2, 30000);
    }
  }
}

export function getStatus() {
  const enabled = !!cfg;
  const ok = enabled && !!lastPollAt && Date.now() - lastPollAt < 90000;
  return { enabled, ok, botUsername, lastPollAt, lastError, pollCount, offset };
}

export async function startTelegramChannel(options = {}) {
  if (running) return { ...getStatus(), sendText, sendPhoto, sendDocument, sendTyping, getStatus, stop: stopTelegramChannel };
  cfg = loadConfig(options.config);
  offsetPath = options.offsetPath ? path.resolve(String(options.offsetPath)) : DEFAULT_OFFSET_PATH;
  token = cfg.botToken;
  api = `https://api.telegram.org/bot${token}`;
  dispatcher = cfg.proxyUrl ? new ProxyAgent(cfg.proxyUrl) : undefined;
  handlers = options;
  offset = loadOffset();
  const me = await tg('getMe', null, { timeoutMs: 30000 });
  botUsername = me?.username || '';
  running = true;
  log(`已上线 @${botUsername}，白名单 ${cfg.allowedUserIds.join(',') || '空'}`);
  void pollLoop();
  return { ...getStatus(), sendText, sendPhoto, sendDocument, sendTyping, getStatus, stop: stopTelegramChannel };
}

export function stopTelegramChannel() {
  running = false;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}
