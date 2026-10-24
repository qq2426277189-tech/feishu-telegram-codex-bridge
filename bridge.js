// Feishu + Telegram + Codex remote bridge
// Model/provider selection follows the current Codex config and CC Switch state.
'use strict';
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { loadConfig } = require('./src/config');
const VERSION = require('./package.json').version;

const APP_ROOT = __dirname;
const SELFTEST_MODE = process.argv.includes('--selftest');
const CLI_INFO_MODE = process.argv.includes('--help') || process.argv.includes('-h') || process.argv.includes('--version');
if (SELFTEST_MODE) {
  process.env.BRIDGE_DATA_DIR = process.env.BRIDGE_DATA_DIR || path.join(APP_ROOT, 'tests', '.selftest-data');
  process.env.CODEX_HOME = process.env.CODEX_HOME || path.join(APP_ROOT, 'tests', 'fixtures', 'codex-home');
  process.env.CC_SWITCH_SETTINGS = process.env.CC_SWITCH_SETTINGS || path.join(APP_ROOT, 'tests', 'fixtures', 'cc-switch.settings.json');
}
const CONFIG = loadConfig({ rootDir: APP_ROOT, allowMissing: SELFTEST_MODE || CLI_INFO_MODE });
const LARK = CONFIG.feishu.larkCliPath;
const AILY_BIN = CONFIG.feishu.ailyBin;
const PS = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const CODEX_CWD = CONFIG.codex.cwd;
const WORK = CONFIG.storage.dataDir;
const DL_DIR = CONFIG.storage.downloadsDir;
const OUT_DIR = CONFIG.storage.outputsDir;
const STATE_FILE = CONFIG.storage.stateFile;
const REPLY_FILE = CONFIG.storage.replyFile;
const LOG_FILE = CONFIG.storage.logFile;
const SHARED_MEM_FILE = CONFIG.storage.sharedMemoryFile;
const TEMP_ROOT = CONFIG.storage.tempDir;
const AUDIT_FILE = CONFIG.storage.auditFile;
const TASK_HISTORY_FILE = CONFIG.storage.taskHistoryFile;
const HEALTH_FILE = CONFIG.storage.healthFile;
const DELIVERED_FILES_FILE = CONFIG.storage.deliveredFilesFile;
const PID_FILE = CONFIG.storage.pidFile;
const TASK_PROTOCOL_FILE = CONFIG.protocolFile;
const GLOBAL_AGENTS_FILE = CONFIG.sync.agentsFiles[0] || '';
const DOCS_AGENTS_FILE = CONFIG.sync.agentsFiles[1] || '';
const TELEGRAM_CHANNEL_PATH = path.join(APP_ROOT, 'src', 'telegram-channel.mjs');
const BRIDGE_CODEX_HOME = CONFIG.codex.home;
const CAPTURE_SCRIPT = path.join(APP_ROOT, 'scripts', 'capture-screen.ps1');
const CODEX_CONFIG_FILE = path.join(BRIDGE_CODEX_HOME, 'config.toml');
const CODEX_AUTH_FILE = path.join(BRIDGE_CODEX_HOME, 'auth.json');
const CC_SWITCH_SETTINGS_FILE = CONFIG.ccSwitch.settingsPath;
const ARTIFACT_RETENTION_MS = CONFIG.storage.artifactRetentionMs;
const HEALTH_CHECK_MS = CONFIG.limits.healthCheckMs;
const HEALTH_ALERT_DEDUP_MS = CONFIG.limits.healthAlertDedupMs;
const MODEL_WATCH_MS = CONFIG.limits.modelWatchMs;
const MODEL_SWITCH_SETTLE_MS = CONFIG.limits.modelSwitchSettleMs;
const MODEL_PROBE_TIMEOUT_MS = CONFIG.codex.probeTimeoutMs;
const MODEL_PROBE_RETRY_MS = CONFIG.limits.modelProbeRetryMs;
const MAX_TASK_HISTORY = CONFIG.limits.maxTaskHistory;
const MAX_REPLY = CONFIG.limits.maxReply;
const EXEC_TIMEOUT_MS = CONFIG.codex.timeoutMs;
const MAX_TURNS_PER_SESSION = CONFIG.limits.maxTurnsPerSession;
const BATCH_WAIT_MS = CONFIG.limits.batchWaitMs;
const MAX_ARCHIVE = CONFIG.limits.maxArchive;
const MAX_CONSEC_FAILS = 2;
const DAILY_RUN_LIMIT = 100;
const NOTIFY_CHAT_ID = CONFIG.feishu.notifyChatId;
const NOTIFY_TELEGRAM_CHAT_ID = CONFIG.telegram.notifyChatId;
const NOTIFY_DEDUP_MS = 60000;
const TASK_HINTS = /报告|文件|文档|表格|电子表格|多维|ppt|pptx|docx?|xlsx?|sheet|总结|附件|上传|发过|之前发的|这个报告|这份文件|刚才那个文件/;
const ACTION_INTENT_RE = /打开|关闭|关掉|启动|运行|安装|卸载|下载|上传|发送|发给|创建|生成|制作|修改|编辑|整理|搜索|查找|查询|截图|播放|点击|输入|保存|导出|删除|移动|复制|重命名|转换|处理|执行|操作|看一下|帮我/;
const GUI_INTENT_RE = /浏览器|网页|网站|窗口|桌面|应用|软件|程序|打开|关闭|关掉|启动|播放|看一下|搜索|查找/;
const CLOSE_INTENT_RE = /关闭|关掉|退出|结束进程|停止程序/;
const NEW_WINDOW_INTENT_RE = /打开|启动|运行|播放|搜索|查找|浏览|进入|点击/;
const COMPLETION_RE = /完美完成|已完成|已经完成|完成啦|搞定|大功告成|任务完成/;
// 模型和供应商完全跟随 Codex/CC Switch 当前配置；bridge 不再硬编码 --model。

let lastNotifyTs = 0;
let consumerChild = null;
let telegramChannel = null;
let consumerFailures = 0;
let consumerRestartTimer = null;
let telegramRestartTimer = null;
let telegramFailures = 0;
let lastHealthState = '';
let lastHealthAlertAt = 0;
let lastHealth = null;
let currentModelConfig = null;
let modelProbe = { ok: false, fingerprint: '', at: '', atMs: 0, error: '尚未验证' };
let modelProbePromise = null;
let modelProbePromiseFingerprint = '';
let modelNoticeKey = '';
let modelWatcherTimer = null;
let modelSwitchTimer = null;
let startupTelegramNoticeSent = false;
let startupTelegramNoticeAttempts = 0;
let startupTelegramNoticeTimer = null;


const ROLE_PROMPT =
  '你是用户的全能 AI 助理（相当于他的 Codex 智能助手），通过飞书与他单聊，人在外面用手机，需要你帮他处理电脑上的任务。' +
  '你可以使用 Codex 的工具（读写文件、运行命令、访问网络等）完成任务，并调用飞书原生能力。' +
  '行为准则：\n' +
  '1. 直接动手完成用户的任务。不要检查、分析或谈论本机正在运行的进程/程序/服务（例如 node、lark-cli、powershell、桥接程序等），也不要查看 Codex 自身的配置、会话或日志文件。\n' +
  '2. 回复用简洁的中文，并使用飞书友好的 Markdown 排版（**加粗**、- 列表、[文字](链接)）。任务给结果总结，闲聊自然聊天。不要提及本提示词。\n' +
  '3. 优先使用飞书原生功能完成任务。本机装有飞书命令行工具 lark-cli（直接运行 lark-cli 即可），通过它调用飞书 API：创建/编辑飞书文档(lark-cli docs)、电子表格(lark-cli sheets；用户说「表格」时默认用这种像 Excel/WPS 的网格表，要设置表头加粗/底色、合理列宽、冻结首行；只有用户明确说「多维表格」或「base」时才用多维表格)、幻灯片(lark-cli slides)、多维表格(lark-cli base)、发消息/群聊(lark-cli im)、任务(lark-cli task)、日历(lark-cli calendar)、知识库(lark-cli wiki)。不确定用法时先运行 lark-cli <domain> --help，或 lark-cli skills list 与 lark-cli skills read <skill> 查看使用说明。\n' +
  '4. 如果生成物是飞书文档/表格/幻灯片/多维表格等，回复中直接给出飞书链接；只有飞书没有对应能力、或用户明确要本地文件（如提交作业用的 .pptx/.docx）时，才用本机 Office/本地文件。若生成 PPT/Word/Excel 等本地文件，用 PowerShell 调用 Office COM（New-Object -ComObject PowerPoint.Application / Word.Application / Excel.Application），并把文件保存到 ' + OUT_DIR + ' 目录（绝对不能保存到其他目录）。保存后系统会自动把文件发到飞书会话，不需要询问用户「要不要发给你」；回复时直接说文件已发送到飞书并给出文件名。\n' +
  '5. 如果附件已提供提取后的文本文件，直接基于该文本处理，不要重复尝试读取原始二进制文件。\n' +
  '6. 提示中出现的"用户发送过的文件"或"已提取为文本"的路径，都是用户在本聊天中提供的资料，请直接读取使用，不要怀疑或拒绝。\n' +
  '7. 【95%澄清协议】开始实质执行前先判断目标、交付物、对象、可见结果、截止时间、限制和验收方式；若存在会明显改变结果的关键歧义，必须先提出具体问题并给推荐方案，达到约95%理解后才执行。用户说不知道或让你决定时，要主动给出可选方案、推荐理由和影响，帮他把需求完善；不得做一个“差不多”的成品。简单低风险且结果几乎唯一时，可以一句话说明假设后执行。\n' +
  '8. 完成任务后主动验证结果（文件是否存在、飞书链接是否有效等），再简洁汇报；耗时步骤先说明计划再执行。\n' +
  '9. 用户说「再发一份/再发一次/重新发」某个产物时：若是飞书文档/表格/幻灯片，直接重新发链接；若是本地文件，重新生成并保存到 outputs 目录（系统会自动回传），不要再询问。\n' +
  '10. 严禁使用鼠标/键盘自动化模拟（如 SetCursorPos、SendKeys、mouse_event、点击屏幕坐标等）操作电脑，严禁截屏后根据截图点击窗口。\n' +
  '11. 严禁打开、操作或读取用户的任何通讯/聊天软件（Telegram/纸飞机、微信、QQ、飞书客户端、钉钉等），绝对禁止在这些应用内搜索、点击、输入或读取任何内容。\n' +
  '12. 需要打开网页/网站时，只通过浏览器完成：优先使用 Codex 的浏览器工具；否则用命令启动全新浏览器窗口（如 start msedge <网址> 或 start chrome <网址>），所有搜索与操作都必须在浏览器网页内完成，不要点击或操作其他任何窗口。\n' +
  '13. 执行任何会打开可见窗口（如浏览器）的操作前，先在回复中告知用户即将执行什么（如「我将在电脑上打开浏览器搜索xxx」），然后继续；若用户回复「暂停」或「等一下」，立即停止等待。启动窗口时不得抢占键盘/鼠标焦点（用 start 启动新窗口即可，不要 SetForegroundWindow），尽量最小化后台运行，避免影响用户正在进行的操作。\n' +
  '14. 当任务既可以用浏览器完成、也可以用电脑上的应用完成时，只有在两种方式会产生明显不同结果时才询问用户；否则按最适合任务的方式执行并说明。\n' +
  '15. 要有人性化：执行前先理解任务意图，思考最佳做法，不要机械照做；有歧义先想清楚再行动；回复自然、简洁、有温度。';

const SAFETY_RULES =
  '【安全规则（每条消息都强制生效，必须遵守）】\n' +
  '1. 严禁盲目「截屏后猜坐标点击」式操作（SetCursorPos、SendKeys、点击屏幕坐标等）；操控应用请用程序化方式（COM、Windows UI Automation、命令行参数）。\n' +
  '2. 通讯/聊天软件（Telegram/纸飞机、微信、QQ、钉钉等）默认不碰、不打开、不读取；只有用户明确要求操作它们时才允许。\n' +
  '3. 可以操控浏览器和电脑上的应用（Office、播放器、系统设置等），但打开/操作可见窗口前先告知用户；启动窗口不得抢占键盘/鼠标焦点，尽量最小化后台运行。\n' +
  '4. 涉及重要或不可逆操作（删除文件、修改系统设置、发送消息等）前，先向用户确认。\n' +
  '5. 当任务既可以用浏览器完成、也可以用电脑上的应用完成时，先询问用户用哪种再执行；执行前先理解任务意图、思考最佳做法，不要机械执行。\n' +
  '6. 任务执行完成后，回复中列出**本次任务真实执行**的步骤（如「1.运行命令获取系统时间 2.整理回复」），必须只写本次实际做的动作；若本次没有打开浏览器/操作文件，如实说明（如「本次仅获取信息，无额外操作」）。严禁把历史任务或记忆中的步骤当作本次步骤，严禁虚构。\n' +
  '7. 【强制·可视结果】每次任务执行完成后，回复末尾必须给出可点击的链接；没有链接时明确说明没有可点击链接。生成了飞书文档/表格/幻灯片/多维表格时给出飞书链接；生成本地文件时说明文件已发送到飞书并给出文件名；纯操作类任务说明被打开目标的网页链接或应用名称。桌面截图由 bridge 在回复后自动附上，Codex 不要自行创建额外截图，也不得写“没有截图/未创建截图”。\n' +
  '8. 【真实性】没有实际工具证据、可见窗口证据或文件存在证据时，绝不能写“已完成/完美完成”。只能如实写“未执行”“失败”“部分完成”或“已执行但未验证”。命令退出码 0、PID、HTTP 200 都不能单独当作用户可见任务成功。\n' ;

function readTaskProtocol() {
  try { return fs.readFileSync(TASK_PROTOCOL_FILE, 'utf8').replace(/^\uFEFF/, '').trim(); } catch (_) { return ''; }
}
function getTaskProtocolPrompt() {
  const protocol = readTaskProtocol();
  return protocol ? '【跨窗口强制任务协议（每轮强制生效）】\n' + protocol + '\n\n' : '';
}

function buildAgentRuleBlock(protocol) {
  const start = '<!-- CODEX_REMOTE_PROTOCOL_V3:START -->';
  const end = '<!-- CODEX_REMOTE_PROTOCOL_V3:END -->';
  return start + '\n## 跨窗口远程任务强制协议（V3，自动同步）\n\n' +
    '以下内容是当前生效的完整规则，源文件为 ' + TASK_PROTOCOL_FILE + '。bridge 会自动同步本区块。\n\n' +
    protocol + '\n' + end + '\n';
}

function syncAgentRulesFile(file, protocol) {
  let current = '';
  try { current = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch (_) {}
  const block = buildAgentRuleBlock(protocol);
  const start = current.indexOf('<!-- CODEX_REMOTE_PROTOCOL_V3:START -->');
  const end = current.indexOf('<!-- CODEX_REMOTE_PROTOCOL_V3:END -->');
  let next;
  if (start >= 0 && end > start) {
    next = current.slice(0, start) + block + current.slice(end + '<!-- CODEX_REMOTE_PROTOCOL_V3:END -->'.length);
  } else {
    const old = current.indexOf('<!-- CODEX_REMOTE_PROTOCOL_V2 -->');
    const before = old >= 0 ? current.slice(0, old) : current;
    next = before.trimEnd() + '\n\n' + block;
  }
  next = next.replace(/\s+$/, '') + '\n';
  if (next !== current) fs.writeFileSync(file, next, 'utf8');
}

function syncAgentRules() {
  const protocol = readTaskProtocol();
  if (!protocol || !CONFIG.sync.agentsFiles.length) return;
  if (GLOBAL_AGENTS_FILE) {
    try { syncAgentRulesFile(GLOBAL_AGENTS_FILE, protocol); } catch (e) { log('全局规则同步失败: ' + e.message); }
  }
  if (DOCS_AGENTS_FILE) {
    try { syncAgentRulesFile(DOCS_AGENTS_FILE, protocol); } catch (e) { log('项目规则同步失败: ' + e.message); }
  }
}



function loadTaskHistory(limit) {
  const max = Number(limit) || 200;
  try {
    const lines = fs.readFileSync(TASK_HISTORY_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-max).map(line => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

function historyNeedsContext(text) {
  const t = String(text || '');
  return t.length < 15 || /上次|之前|那个|这个|刚才|刚刚|继续|再发|发给我|文件|视频|报告|表格|文档|链接|它|他|她/.test(t);
}

function historyTerms(text) {
  const raw = String(text || '').replace(/[^\w\u4e00-\u9fff]+/g, ' ');
  const generic = /^(上次|之前|那个|这个|刚才|刚刚|继续|发给我|发一下|文件|视频|报告|表格|文档|链接|一下|帮我|我的|这个|那个)$/;
  const words = raw.split(/\s+/).filter(x => x.length >= 2 && !generic.test(x));
  const chars = String(text || '').replace(/[^\u4e00-\u9fff\w]+/g, '');
  const grams = [];
  for (let i = 0; i < chars.length - 1; i++) { const g = chars.slice(i, i + 2); if (!generic.test(g)) grams.push(g); }
  return [...new Set(words.concat(grams))];
}

function getTaskHistoryBlock(text) {
  if (!historyNeedsContext(text)) return '';
  const all = loadTaskHistory(MAX_TASK_HISTORY);
  if (!all.length) return '【任务历史索引】暂无历史任务记录。\n\n';
  const terms = historyTerms(text);
  const phrase = String(text || '').replace(/上次|之前|那个|这个|刚才|刚刚|继续|再发|发给我|发一下|文件|视频|报告|表格|文档|链接|一下|帮我|我的/g, '').replace(/[^\u4e00-\u9fff\w]+/g, '');
  const recent = all.slice(-5).reverse();
  const scored = all.map(item => {
    const hay = String(item.userText || '') + ' ' + String(item.summary || '') + ' ' + (item.artifacts || []).join(' ');
    let score = 0;
    for (const term of terms) if (hay.includes(term)) score += term.length >= 2 ? 3 : 1;
    if (phrase.length >= 2 && hay.includes(phrase)) score += 12;
    if (phrase.length >= 2 && String(item.sourceTitle || '').includes(phrase)) score += 20;
    return { item, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || String(b.item.at || '').localeCompare(String(a.item.at || '')));
  const picked = [];
  const seen = new Set();
  const strong = scored.filter(x => x.score >= 3).map(x => x.item);
  const ordered = strong.length ? strong.concat(recent, scored.map(x => x.item)) : recent.concat(scored.map(x => x.item));
  for (const x of ordered) {
    const key = (x.taskId || '') + '|' + (x.at || '') + '|' + String(x.userText || '').slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(x);
    if (picked.length >= 8) break;
  }
  const lines = picked.map((x, i) => {
    const links = Array.isArray(x.links) && x.links.length ? ' 链接=' + x.links.slice(0, 2).join(',') : '';
    const files = Array.isArray(x.artifacts) && x.artifacts.length ? ' 文件=' + x.artifacts.slice(0, 3).join(',') : '';
    return (i + 1) + '. [' + (x.at || '') + '] ' + (x.status || 'unknown') + ' | ' + String(x.userText || '').slice(0, 120) + links + files;
  });
  return '【任务历史索引（按“上次/那个/继续/发给我”等指代和关键词检索；候选不唯一时必须询问，不得猜测）】\n' + lines.join('\n') + '\n\n';
}


function appendTaskHistory(entry) {
  try {
    fs.appendFileSync(TASK_HISTORY_FILE, JSON.stringify(redactSensitiveValue(entry)) + '\n');
    const lines = fs.readFileSync(TASK_HISTORY_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    if (lines.length > MAX_TASK_HISTORY) fs.writeFileSync(TASK_HISTORY_FILE, lines.slice(-MAX_TASK_HISTORY).join('\n') + '\n');
  } catch (e) { log('任务历史写入失败: ' + e.message); }
}

function classifyTaskStatus(v) {
  if (v.failedFiles && v.failedFiles.length) return 'partial';
  if (v.actionIntent && v.successfulTools === 0) return 'failed';
  if (v.requiresNewWindow && v.newWindowCount === 0) return 'unverified';
  if (!v.screenshotOk || !v.imageSent) return 'unverified';
  return 'completed';
}

function runCommandCapture(command, args, timeoutMs) {
  return new Promise(resolve => {
    let done = false;
    const child = spawn(command, args || [], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill('SIGKILL'); } catch (_) {} resolve({ ok: false, error: 'timeout', stdout: out, stderr: err }); } }, timeoutMs || 5000);
    child.stdout.on('data', d => (out += d.toString('utf8')));
    child.stderr.on('data', d => (err += d.toString('utf8')));
    child.on('error', e => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: String((e && e.message) || e), stdout: out, stderr: err }); } });
    child.on('close', code => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: code === 0, code, stdout: out, stderr: err }); } });
  });
}

function readUtf8IfExists(file) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); } catch (_) { return ''; }
}

function stripTomlComment(value) {
  let quote = '';
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && quote === '"') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trim();
  }
  return value.trim();
}

function parseTomlScalar(value) {
  const v = stripTomlComment(String(value || '').trim());
  if (!v) return '';
  if (v[0] === '"' && v.endsWith('"')) {
    try { return JSON.parse(v); } catch (_) { return v.slice(1, -1); }
  }
  if (v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (/^(true|false)$/i.test(v)) return v.toLowerCase() === 'true';
  return v;
}

function parseTomlLite(text) {
  const top = {};
  const sections = {};
  let section = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const table = /^\[([^\]]+)\]$/.exec(line);
    if (table) { section = table[1].trim(); sections[section] = sections[section] || {}; continue; }
    const assignment = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) continue;
    const target = section ? (sections[section] = sections[section] || {}) : top;
    target[assignment[1]] = parseTomlScalar(assignment[2]);
  }
  return { top, sections };
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20);
}

function sanitizeUrl(raw) {
  if (!raw) return '(Codex 默认端点)';
  try {
    const u = new URL(String(raw));
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch (_) { return String(raw).replace(/[?#].*$/, ''); }
}

function redactSensitiveText(value) {
  return String(value == null ? '' : value)
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer ***')
    .replace(/Authorization\s*:\s*(?!\*\*\*)[^\s\r\n]+/gi, 'Authorization: ***')
    .replace(/Cookie\s*:\s*[^\r\n]+/gi, 'Cookie: ***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-***')
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED_TELEGRAM_TOKEN]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, 'gh***')
    .replace(/([?&](?:api[_-]?key|key|token|access_token|refresh_token)=)[^&\s]+/gi, '$1***')
    .replace(/((?:api[_-]?key|botToken|token|secret)\s*=\s*)[^\s&,;]+/gi, '$1***')
    .replace(/(["'](?:api[_-]?key|openai_api_key|botToken|token|secret)["']\s*:\s*["'])[^"']+(["'])/gi, '$1***$2')
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1***:***@');
}

function redactSensitiveValue(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactSensitiveValue(item);
    return out;
  }
  return value;
}

function sanitizeDiagnostic(text) {
  return redactSensitiveText(text).slice(0, 1200);
}

function readCcSwitchProviderId() {
  try {
    const j = JSON.parse(readUtf8IfExists(CC_SWITCH_SETTINGS_FILE));
    return String(j.currentProviderCodex || '').trim();
  } catch (_) { return ''; }
}

function readCodexModelConfig() {
  const configText = readUtf8IfExists(CODEX_CONFIG_FILE);
  if (!configText) {
    return { ok: false, error: '读取不到 Codex config.toml', fingerprint: '', provider: '', providerName: '', model: '', baseUrl: '(未知)', configChangedAt: '', ccProviderId: '' };
  }
  const parsed = parseTomlLite(configText);
  const provider = String(parsed.top.model_provider || 'openai').trim();
  const model = String(parsed.top.model || '(Codex 默认)').trim();
  const providerTable = parsed.sections['model_providers.' + provider] || {};
  const providerName = String(providerTable.name || provider).trim();
  const rawBaseUrl = String(providerTable.base_url || '').trim();
  const ccProviderId = readCcSwitchProviderId();
  const authText = readUtf8IfExists(CODEX_AUTH_FILE);
  let configMtime = '';
  try { configMtime = fs.statSync(CODEX_CONFIG_FILE).mtime.toISOString(); } catch (_) {}
  const fingerprint = shortHash(JSON.stringify({
    provider, model, rawBaseUrl, ccProviderId,
    configHash: shortHash(configText), authHash: shortHash(authText)
  }));
  return {
    ok: true, provider, providerName, model,
    baseUrl: sanitizeUrl(rawBaseUrl), baseUrlRaw: rawBaseUrl,
    configChangedAt: configMtime, ccProviderId, fingerprint
  };
}

function clearChatSessionsForModelChange(config) {
  const state = loadState();
  let cleared = 0;
  const samePersistedModel = !!(state._modelConfig && state._modelConfig.fingerprint === config.fingerprint);
  for (const [key, rec] of Object.entries(state)) {
    if (key === '_global' || key === '_modelConfig' || !rec || typeof rec !== 'object') continue;
    const sessionBelongsToCurrentModel = samePersistedModel && rec.modelFingerprint === config.fingerprint;
    if (!sessionBelongsToCurrentModel) {
      if (rec.sessionId) cleared++;
      rec.sessionId = null;
      rec.turns = 0;
      delete rec.pendingConfirmation;
    }
    rec.modelFingerprint = config.fingerprint;
  }
  state._modelConfig = {
    fingerprint: config.fingerprint, provider: config.provider, providerName: config.providerName,
    model: config.model, baseUrl: config.baseUrl, configChangedAt: config.configChangedAt,
    ccProviderId: config.ccProviderId, syncedAt: new Date().toISOString()
  };
  saveState(state);
  log('模型配置已同步: ' + config.providerName + ' / ' + config.model + ' / ' + config.baseUrl + '，清理旧会话 ' + cleared + ' 个');
  return cleared;
}

function modelStatusText(probe) {
  const p = probe || modelProbe || {};
  const ok = !!p.ok;
  const latency = p.latencyMs ? '，' + (p.latencyMs / 1000).toFixed(1) + ' 秒' : '';
  return '当前模型：**' + (p.model || (currentModelConfig && currentModelConfig.model) || '未知') + '**\n' +
    '供应商：' + ((p.providerName || (currentModelConfig && currentModelConfig.providerName) || '未知')) +
    ' (' + (p.provider || (currentModelConfig && currentModelConfig.provider) || '?') + ')\n' +
    '端点：' + (p.baseUrl || (currentModelConfig && currentModelConfig.baseUrl) || '未知') + '\n' +
    '实调：' + (ok ? '✅ 已真实连通' + latency : '❌ ' + sanitizeDiagnostic(p.error || '尚未验证'));
}

async function notifyModelChange(probe) {
  const text = (probe.ok ? '🔄 **CC Switch API 已切换并连通**\n\n' : '⚠️ **CC Switch API 已切换，但实调失败**\n\n') +
    modelStatusText(probe) + '\n\n' +
    (probe.ok ? '后续飞书和 Telegram 任务会自动使用这个 API。' : '后续任务暂时不会执行，避免在坏 API 上假装完成。请检查 CC Switch 后发送「状态」重试。');
  let feishuSent = false;
  let telegramSent = false;
  try {
    if (!CONFIG.feishu.enabled) {
      log('API 切换通知未发送到飞书: 通道未启用');
    } else {
      const result = await sendTextToChat(NOTIFY_CHAT_ID, text);
      if (!result || !result.ok) throw new Error('飞书发送返回失败');
      feishuSent = true;
      log('API 切换通知已发送到飞书（实调=' + (probe.ok ? 'OK' : 'FAIL') + '）');
    }
  } catch (e) {
    log('API 切换通知发送到飞书失败: ' + sanitizeDiagnostic(e && e.message || e));
  }
  try {
    if (!telegramChannel || typeof telegramChannel.sendText !== 'function') {
      log('API 切换通知未发送到 Telegram: 通道未启动');
    } else {
      const id = NOTIFY_TELEGRAM_CHAT_ID;
      if (!id) throw new Error('未配置 Telegram 通知用户 ID');
      const result = await telegramChannel.sendText(id, null, text);
      if (!result || result.ok === false) throw new Error('Telegram 发送返回失败');
      telegramSent = true;
      log('API 切换通知已发送到 Telegram（实调=' + (probe.ok ? 'OK' : 'FAIL') + '）');
    }
  } catch (e) {
    log('API 切换通知发送到 Telegram 失败: ' + sanitizeDiagnostic(e && e.message || e));
  }
  return { feishuSent, telegramSent };
}

async function notifyTelegramStartupStatus(probe) {
  if (!CONFIG.telegram.enabled || startupTelegramNoticeSent) return;
  const p = probe || {};
  const text = (p.ok ? '✅ **当前 API 启动实调成功**\n\n' : '⚠️ **当前 API 启动实调失败**\n\n') +
    modelStatusText(p) + '\n\n' +
    '本消息用于确认 bridge 启动后的 Telegram 状态通知。';
  try {
    if (!telegramChannel || typeof telegramChannel.sendText !== 'function') throw new Error('Telegram 通道未启动');
    const id = NOTIFY_TELEGRAM_CHAT_ID;
    if (!id) throw new Error('未配置 Telegram 通知用户 ID');
    const result = await telegramChannel.sendText(id, null, text);
    if (!result || result.ok === false) throw new Error('Telegram 发送返回失败');
    startupTelegramNoticeSent = true;
    startupTelegramNoticeAttempts = 0;
    if (startupTelegramNoticeTimer) { clearTimeout(startupTelegramNoticeTimer); startupTelegramNoticeTimer = null; }
    log('启动 API 状态通知已发送到 Telegram（实调=' + (p.ok ? 'OK' : 'FAIL') + '）');
  } catch (e) {
    startupTelegramNoticeAttempts++;
    log('启动 API 状态通知发送到 Telegram 失败（第 ' + startupTelegramNoticeAttempts + ' 次）: ' + sanitizeDiagnostic(e && e.message || e));
    if (!startupTelegramNoticeSent && startupTelegramNoticeAttempts < 3 && !startupTelegramNoticeTimer) {
      startupTelegramNoticeTimer = setTimeout(() => {
        startupTelegramNoticeTimer = null;
        notifyTelegramStartupStatus(probe).catch(err => log('启动 API 状态通知重试异常: ' + sanitizeDiagnostic(err && err.message || err)));
      }, 15000);
      startupTelegramNoticeTimer.unref && startupTelegramNoticeTimer.unref();
    }
  }
}

function buildCodexExecCommand(sessionId, pathPrefix, codexExe) {
  const exe = codexExe || resolveCodexExecutable() || (process.platform === 'win32' ? 'codex.exe' : 'codex');
  const safeExe = String(exe).replace(/'/g, "''");
  return sessionId
    ? `${pathPrefix}& '${safeExe}' exec resume '${sessionId}' --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -o '${REPLY_FILE}' -`
    : `${pathPrefix}& '${safeExe}' exec --json -C '${CODEX_CWD}' --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -o '${REPLY_FILE}' -`;
}

function runModelProbe(config, reason) {
  return new Promise(resolve => {
    const taskId = '_model-probe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const probeDir = path.join(TEMP_ROOT, taskId);
    const replyFile = path.join(probeDir, 'reply.txt');
    try { fs.mkdirSync(probeDir, { recursive: true }); } catch (_) {}
    const started = Date.now();
    const env = Object.assign({}, process.env, {
      USERPROFILE: process.env.USERPROFILE || os.homedir(),
      HOME: process.env.HOME || os.homedir(),
      CODEX_HOME: BRIDGE_CODEX_HOME,
      PATH: (AILY_BIN ? AILY_BIN + path.delimiter : '') + String(process.env.PATH || '')
    });
    const args = ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', CODEX_CWD, '-o', replyFile, '-'];
    const codexExe = resolveCodexExecutable();
    if (!codexExe) {
      const result = { ok: false, stale: false, fingerprint: config.fingerprint, provider: config.provider, providerName: config.providerName, model: config.model, baseUrl: config.baseUrl, at: new Date().toISOString(), atMs: Date.now(), latencyMs: 0, error: '找不到 codex.exe' };
      modelProbe = result;
      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch (_) {}
      log('API 实调 FAIL: 找不到 codex.exe');
      return resolve(result);
    }
    const child = spawn(codexExe, args, { cwd: CODEX_CWD, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false, timedOut = false;
    const finish = code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let reply = '';
      try { reply = fs.readFileSync(replyFile, 'utf8').trim(); } catch (_) {}
      let diagnostic = '';
      if (timedOut) diagnostic = 'API 实调超时';
      if (!diagnostic && code !== 0) diagnostic = sanitizeDiagnostic(err || out || ('Codex 退出码 ' + code));
      const latest = readCodexModelConfig();
      const result = {
        ok: code === 0 && !!reply && !timedOut,
        stale: !!(latest.ok && latest.fingerprint !== config.fingerprint),
        fingerprint: config.fingerprint, provider: config.provider, providerName: config.providerName,
        model: config.model, baseUrl: config.baseUrl, at: new Date().toISOString(), atMs: Date.now(),
        latencyMs: Date.now() - started, replyPreview: reply.slice(0, 40),
        error: code === 0 && reply && !timedOut ? '' : (diagnostic || '模型没有返回有效结果')
      };
      if (!result.stale) modelProbe = result;
      try { fs.rmSync(probeDir, { recursive: true, force: true }); } catch (_) {}
      log('API 实调 ' + reason + ': ' + (result.ok ? 'OK' : 'FAIL') + ' model=' + config.model + ' provider=' + config.providerName + ' latency=' + result.latencyMs + 'ms' + (result.ok ? '' : ' error=' + result.error));
      resolve(result);
    };
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, MODEL_PROBE_TIMEOUT_MS);
    child.stdout.on('data', d => (out += d.toString('utf8')));
    child.stderr.on('data', d => (err += d.toString('utf8')));
    child.on('error', e => { err += '\n' + String((e && e.message) || e); finish(-1); });
    child.on('close', code => finish(code));
    try { child.stdin.write('只回复 OK，不要调用任何工具。'); child.stdin.end(); } catch (_) {}
  });
}

async function ensureCurrentModelReady(reason, options = {}) {
  const force = !!options.force;
  for (let attempt = 0; attempt < 4; attempt++) {
    const cfg = readCodexModelConfig();
    if (!cfg.ok) {
      const failed = { ok: false, fingerprint: '', at: new Date().toISOString(), atMs: Date.now(), provider: '', providerName: '', model: '', baseUrl: '(未知)', error: cfg.error };
      modelProbe = failed;
      return failed;
    }
    currentModelConfig = cfg;
    if (!force && modelProbe.fingerprint === cfg.fingerprint) {
      if (modelProbe.ok) return modelProbe;
      if (Date.now() - Number(modelProbe.atMs || 0) < (Number(options.retryMs) || MODEL_PROBE_RETRY_MS)) return modelProbe;
    }
    if (modelProbePromise) {
      await modelProbePromise;
      continue;
    }
    modelProbePromiseFingerprint = cfg.fingerprint;
    modelProbePromise = runModelProbe(cfg, reason).finally(() => {
      modelProbePromise = null;
      modelProbePromiseFingerprint = '';
    });
    const result = await modelProbePromise;
    if (!result.stale) return result;
    log('API 实调期间配置再次变化，重新验证最新配置');
  }
  return { ok: false, fingerprint: currentModelConfig && currentModelConfig.fingerprint || '', at: new Date().toISOString(), atMs: Date.now(), model: currentModelConfig && currentModelConfig.model || '', provider: currentModelConfig && currentModelConfig.provider || '', providerName: currentModelConfig && currentModelConfig.providerName || '', baseUrl: currentModelConfig && currentModelConfig.baseUrl || '', error: '配置连续变化，未取得稳定实调结果' };
}

function scheduleModelSwitchProbe() {
  clearTimeout(modelSwitchTimer);
  // 这里不能 unref：切换瞬间如果消费者/适配器没有保持引用，Node 会在 2.5 秒等待期结束前退出，
  // 导致“已检测到切换”但永远没有实调和通知。
  modelSwitchTimer = setTimeout(() => {
    modelSwitchTimer = null;
    (async () => {
      if (activeCodexChild) { scheduleModelSwitchProbe(); return; }
      const latest = readCodexModelConfig();
      if (!latest.ok || !currentModelConfig || latest.fingerprint !== currentModelConfig.fingerprint) {
        detectModelConfigChange();
        return;
      }
      const probe = await ensureCurrentModelReady('CC Switch 切换后');
      const key = probe.fingerprint + '|' + (probe.ok ? 'ok' : 'fail');
      if (key !== modelNoticeKey) {
        modelNoticeKey = key;
        await notifyModelChange(probe);
        await runHealthCheck(probe.ok ? 'CC Switch 切换完成' : 'CC Switch 切换失败', false).catch(err => log('切换后的健康状态记录异常: ' + sanitizeDiagnostic(err && err.message || err)));
      }
    })().catch(e => {
      const cfg = currentModelConfig || {};
      const probe = {
        ok: false, stale: false, fingerprint: cfg.fingerprint || '',
        provider: cfg.provider || '', providerName: cfg.providerName || '',
        model: cfg.model || '', baseUrl: cfg.baseUrl || '',
        at: new Date().toISOString(), atMs: Date.now(), latencyMs: 0,
        error: sanitizeDiagnostic(e && e.message || e)
      };
      modelProbe = probe;
      log('API 实调 CC Switch 切换后异常: ' + probe.error);
      const key = probe.fingerprint + '|fail';
      if (key !== modelNoticeKey) {
        modelNoticeKey = key;
        notifyModelChange(probe).catch(err => log('API 切换失败通知异常: ' + sanitizeDiagnostic(err && err.message || err)));
      }
      runHealthCheck('CC Switch 切换异常', false).catch(err => log('切换异常后的健康状态记录异常: ' + sanitizeDiagnostic(err && err.message || err)));
    });
  }, MODEL_SWITCH_SETTLE_MS);
}

function detectModelConfigChange() {
  const next = readCodexModelConfig();
  if (!next.ok) return false;
  if (!currentModelConfig) {
    currentModelConfig = next;
    clearChatSessionsForModelChange(next);
    return false;
  }
  if (next.fingerprint === currentModelConfig.fingerprint) return false;
  currentModelConfig = next;
  modelNoticeKey = '';
  clearChatSessionsForModelChange(next);
  log('检测到 CC Switch/Codex API 配置变化，旧模型会话已作废，等待新配置稳定后实调');
  scheduleModelSwitchProbe();
  return true;
}

function startModelConfigWatcher() {
  detectModelConfigChange();
  modelWatcherTimer = setInterval(() => { try { detectModelConfigChange(); } catch (e) { log('模型配置监控异常: ' + e.message); } }, MODEL_WATCH_MS);
  modelWatcherTimer.unref && modelWatcherTimer.unref();
}

function checkProxy(modelConfig) {
  return new Promise(resolve => {
    const raw = String(modelConfig && modelConfig.baseUrlRaw || '');
    if (!raw) return resolve({ ok: true, skipped: true, error: '' });
    let u;
    try { u = new URL(raw); } catch (e) { return resolve({ ok: true, skipped: true, error: '端点格式无法解析，交由实调验证' }); }
    if (!/^(127\.0\.0\.1|localhost|::1)$/i.test(u.hostname)) {
      return resolve({ ok: true, skipped: true, baseUrl: sanitizeUrl(raw), error: '' });
    }
    const http = require('http');
    const basePath = u.pathname.replace(/\/$/, '');
    const req = http.get({ host: u.hostname, port: u.port || 80, path: basePath + '/models', timeout: 3000 }, res => {
      res.resume();
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode, baseUrl: sanitizeUrl(raw) });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', baseUrl: sanitizeUrl(raw) }); });
    req.on('error', e => resolve({ ok: false, error: e.message, baseUrl: sanitizeUrl(raw) }));
  });
}

function resolveCodexExecutable() {
  const explicit = String(CONFIG.codex.executable || process.env.CODEX_CLI_PATH || '').trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = [];
  const localAppData = String(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
  const appData = String(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'));
  const appBin = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  try {
    for (const name of fs.readdirSync(appBin)) {
      const exe = path.join(appBin, name, process.platform === 'win32' ? 'codex.exe' : 'codex');
      try { if (fs.existsSync(exe)) candidates.push({ exe, mtime: fs.statSync(exe).mtimeMs }); } catch (_) {}
    }
  } catch (_) {}
  candidates.push({ exe: path.join(appData, 'npm', 'node_modules', '@openai', 'codex', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'), mtime: 0 });
  if (AILY_BIN) candidates.push({ exe: path.join(AILY_BIN, process.platform === 'win32' ? 'codex.exe' : 'codex'), mtime: 0 });
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const item of candidates) { try { if (fs.existsSync(item.exe)) return item.exe; } catch (_) {} }
  return '';
}

async function checkCodex() {
  const exe = resolveCodexExecutable();
  if (exe) return { ok: true, path: exe, error: '' };
  const r = await runCommandCapture('where.exe', ['codex'], 4000);
  const first = String(r.stdout || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)[0] || '';
  return { ok: r.ok && !!first, path: first, error: r.error || '' };
}

async function checkLarkEvent() {
  if (!CONFIG.feishu.enabled) return { ok: true, disabled: true, status: 'disabled', activeConsumers: 0, error: '' };
  if (!LARK) return { ok: false, status: 'not_configured', activeConsumers: 0, error: 'Lark CLI path is not configured' };
  const r = await runCommandCapture(LARK, ['event', 'status', '--json'], 8000);
  const j = parseJsonObjectOutput(r.stdout, r.stderr);
  const apps = j && Array.isArray(j.apps) ? j.apps : [];
  const app = (CONFIG.feishu.appId && apps.find(x => x.app_id === CONFIG.feishu.appId)) || apps[0] || null;
  return { ok: !!(app && app.running && Number(app.active_consumers) > 0), status: app && app.status, activeConsumers: app && app.active_consumers, error: r.error || '' };
}

async function checkDesktop() {
  const s = await captureScreen('__health__');
  safeRemoveTaskTemp('__health__');
  return { ok: !!(s && s.ok && !s.locked), screenCount: Number((s && s.screenCount) || 0), width: (s && s.width) || 0, height: (s && s.height) || 0, locked: !!(s && s.locked), error: (s && s.error) || '' };
}

function healthStateText(h) {
  const m = (h.checks && h.checks.model) || {};
  const mc = (h.checks && h.checks.modelConfig) || {};
  const proxy = (h.checks && h.checks.proxy) || {};
  const proxyText = proxy.skipped ? '✅ 非本地代理，由实调验证' : (proxy.ok ? '✅ 可连接' : '❌ ' + sanitizeDiagnostic(proxy.error || '异常'));
  return [
    '📊 **远程助手状态**',
    '- 桥接：' + (h.checks.bridge.ok ? '✅ 运行中' : '❌ 异常') + (h.checks.bridge.pid ? ' (PID ' + h.checks.bridge.pid + ')' : ''),
    '- 飞书消费者：' + (h.checks.consumer.ok ? '✅ 监听中' : '❌ 异常') + (h.checks.consumer.failures ? '，连续失败 ' + h.checks.consumer.failures + ' 次' : ''),
    '- 飞书认证：' + (h.checks.lark.ok ? '✅ 正常' : '❌ 异常') + (h.checks.lark.error ? '：' + h.checks.lark.error : ''),
    '- Codex CLI：' + (h.checks.codex.ok ? '✅ ' + h.checks.codex.path : '❌ 找不到'),
    '- 当前模型：**' + (m.model || mc.model || '未知') + '** / ' + (m.providerName || mc.providerName || m.provider || mc.provider || '未知') + (m.latencyMs ? '（' + (m.latencyMs / 1000).toFixed(1) + ' 秒）' : ''),
    '- API 实调：' + (m.ok ? '✅ 已真实连通' : '❌ ' + sanitizeDiagnostic(m.error || '尚未验证')),
    '- 模型代理：' + proxyText,
    '- CC Switch：' + (mc.ccProviderId ? '✅ 已同步当前配置' : '未检测到配置 ID，按 Codex 配置执行'),
    '- 交互桌面：' + (h.checks.desktop.ok ? '✅ 可截图，' + h.checks.desktop.screenCount + ' 台显示器' : '❌ ' + (h.checks.desktop.locked ? '锁屏' : h.checks.desktop.error)),
    '- Telegram：' + (h.checks.telegram && h.checks.telegram.enabled ? (h.checks.telegram.ok ? '✅ @' + (h.checks.telegram.botUsername || 'bot') : '❌ ' + (h.checks.telegram.lastError || '未轮询')) : '未启用'),
    '- 检查时间：' + h.at
  ].join('\n');
}

function notifyHealth(health) {
  if (!CONFIG.feishu.enabled || !NOTIFY_CHAT_ID) return;
  const now = Date.now();
  const changed = health.state !== lastHealthState;
  const reminder = health.state !== 'healthy' && now - lastHealthAlertAt > HEALTH_ALERT_DEDUP_MS;
  if (!changed && !reminder) return;
  if (!lastHealthState && health.state === 'healthy') { lastHealthState = health.state; return; }
  lastHealthState = health.state;
  lastHealthAlertAt = now;
  const text = health.state === 'healthy'
    ? '✅ 远程助手健康检查已恢复。\n\n' + healthStateText(health)
    : '⚠️ 远程助手健康检查异常。\n\n' + healthStateText(health);
  sendTextToChat(NOTIFY_CHAT_ID, text).catch(() => {});
}

async function runHealthCheck(reason, notify) {
  const checks = {
    bridge: { ok: true, pid: process.pid, uptimeSec: Math.round(process.uptime()) },
    consumer: { enabled: CONFIG.feishu.enabled, ok: !CONFIG.feishu.enabled || !!(consumerChild && consumerChild.exitCode === null), pid: consumerChild && consumerChild.pid, failures: consumerFailures },
    lark: { ok: false }, codex: { ok: false }, model: { ok: false }, modelConfig: {}, proxy: { ok: false }, desktop: { ok: false },
    telegram: telegramChannel && typeof telegramChannel.getStatus === 'function' ? telegramChannel.getStatus() : { enabled: false, ok: true }
  };
  try { checks.lark = await checkLarkEvent(); } catch (e) { checks.lark = { ok: false, error: e.message }; }
  if (!checks.consumer.ok && checks.lark.ok && Number(checks.lark.activeConsumers) > 0) checks.consumer.ok = true;
  try { checks.codex = await checkCodex(); } catch (e) { checks.codex = { ok: false, error: e.message }; }
  try {
    const probe = await ensureCurrentModelReady('健康检查:' + reason, { force: reason === '用户查询' });
    checks.model = {
      ok: !!probe.ok, model: probe.model || (currentModelConfig && currentModelConfig.model) || '',
      provider: probe.provider || '', providerName: probe.providerName || '', baseUrl: probe.baseUrl || '',
      latencyMs: probe.latencyMs || 0, at: probe.at || '', fingerprint: probe.fingerprint || '',
      error: sanitizeDiagnostic(probe.error || '')
    };
    checks.modelConfig = currentModelConfig ? {
      provider: currentModelConfig.provider, providerName: currentModelConfig.providerName,
      model: currentModelConfig.model, baseUrl: currentModelConfig.baseUrl,
      configChangedAt: currentModelConfig.configChangedAt, ccProviderId: currentModelConfig.ccProviderId,
      fingerprint: currentModelConfig.fingerprint
    } : {};
  } catch (e) { checks.model = { ok: false, error: sanitizeDiagnostic(e.message) }; checks.modelConfig = {}; }
  try { checks.proxy = await checkProxy(currentModelConfig); } catch (e) { checks.proxy = { ok: false, error: e.message }; }
  try { checks.desktop = await checkDesktop(); } catch (e) { checks.desktop = { ok: false, error: e.message }; }
  const healthy = !!(checks.bridge.ok && checks.consumer.ok && checks.lark.ok && checks.codex.ok && checks.model.ok && checks.proxy.ok && checks.desktop.ok && (!checks.telegram.enabled || checks.telegram.ok));
  const health = { at: new Date().toISOString(), reason, state: healthy ? 'healthy' : 'degraded', ok: healthy, checks };
  lastHealth = health;
  try { fs.writeFileSync(HEALTH_FILE, JSON.stringify(health, null, 2)); } catch (_) {}
  log('健康检查 ' + reason + ': ' + health.state + ' consumer=' + checks.consumer.ok + ' lark=' + checks.lark.ok + ' codex=' + checks.codex.ok + ' model=' + checks.model.ok + ' proxy=' + checks.proxy.ok + ' desktop=' + checks.desktop.ok + ' telegram=' + (checks.telegram.enabled ? checks.telegram.ok : 'disabled'));
  if (notify) notifyHealth(health);
  return health;
}

function parseJsonEvents(raw) {
  const events = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || !t.startsWith('{')) continue;
    try { events.push(JSON.parse(t)); } catch (_) {}
  }
  return events;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${redactSensitiveText(msg).slice(0, 4000)}`;
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
  console.log(line);
}

// 切换实调或通知链路发生异常时，必须留下证据并保持 bridge 主循环存活。
process.on('unhandledRejection', reason => {
  log('未处理 Promise 拒绝: ' + sanitizeDiagnostic(reason && reason.stack || reason && reason.message || reason));
});
process.on('uncaughtException', error => {
  log('未捕获异常，bridge 继续运行: ' + sanitizeDiagnostic(error && error.stack || error && error.message || error));
});
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (_) { return {}; }
}
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (_) {} }
function getGlobal(state) {
  const today = new Date().toISOString().slice(0, 10);
  const g = state._global || {};
  if (g.day !== today) { g.day = today; g.runsToday = 0; g.consecFails = 0; }
  return g;
}
function readSharedMemory() {
  try {
    const lines = fs.readFileSync(SHARED_MEM_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-8).join('\n');
  } catch (_) { return ''; }
}
function appendSharedMemory(text) {
  try {
    const safeText = redactSensitiveText(text);
    const lines = fs.readFileSync(SHARED_MEM_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    lines.push(...safeText.split(/\r?\n/));
    const kept = lines.slice(-60);
    fs.writeFileSync(SHARED_MEM_FILE, kept.join('\n') + '\n');
  } catch (_) { try { fs.writeFileSync(SHARED_MEM_FILE, redactSensitiveText(text) + '\n'); } catch (_) {} }
}

function asText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function collectToolEvidence(events) {
  const calls = new Map();
  const outputs = new Map();
  const noteCall = (id, data) => {
    const key = id || ('call-' + calls.size);
    const prev = calls.get(key) || {};
    calls.set(key, Object.assign({}, prev, data));
  };
  const noteOutput = (id, data) => {
    const key = id || ('out-' + outputs.size);
    const prev = outputs.get(key) || {};
    outputs.set(key, Object.assign({}, prev, data));
  };
  for (const ev of Array.isArray(events) ? events : []) {
    const candidates = [ev, ev && ev.payload, ev && ev.item, ev && ev.payload && ev.payload.item].filter(x => x && typeof x === 'object');
    for (const q of candidates) {
      const type = String(q.type || '');
      const id = q.call_id || q.callId || q.id || '';
      if ((type === 'item.started' || type === 'item.completed') && q.item && typeof q.item === 'object') {
        const item = q.item;
        const itemType = String(item.type || '');
        if (itemType === 'agent_message' || itemType === 'reasoning') continue;
        noteCall(item.id || id, {
          name: item.name || item.tool_name || item.command || itemType,
          args: asText(item.arguments || item.input || item.command || item.code || item),
          status: item.status || '',
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          output: asText(item.aggregated_output || item.output || item.result || item.text || '')
        });
        continue;
      }
      if (type === 'function_call' || type === 'custom_tool_call' || type === 'local_shell_call') {
        noteCall(id, { name: q.name || q.tool_name || type, args: asText(q.arguments || q.input || q.command || q.code) });
      } else if (type === 'function_call_output' || type === 'custom_tool_call_output' || type === 'local_shell_call_output') {
        noteOutput(id, { output: asText(q.output || q.result || q.text || q.content || '') });
      }
    }
  }
  const items = [];
  for (const [id, call] of calls) {
    const output = call.output || (outputs.get(id) || {}).output || '';
    const failed = isFailedToolOutput(output, call);
    items.push({ id, name: call.name, args: call.args, output, failed, status: call.status || '', exitCode: call.exitCode });
  }
  const total = items.length;
  const failed = items.filter(x => x.failed).length;
  return { total, successful: total - failed, failed, items };
}


function wasFileSentByTool(filePath, evidence) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  if (!base) return false;
  return ((evidence && evidence.items) || []).some(x => !x.failed && /--file/i.test(String(x.args || '')) && String(x.args || '').toLowerCase().includes(base));
}
function isFailedToolOutput(output, call) {
  if (call && call.status && /failed|error|cancelled|canceled/i.test(call.status)) return true;
  if (call && typeof call.exitCode === 'number' && call.exitCode !== 0) return true;
  const t = asText(output);
  if (!t) return false;
  if (/rejected:\s*blocked by policy/i.test(t)) return true;
  if (/node_repl kernel uncaught exception/i.test(t)) return true;
  if (/spawn .* ENOENT/i.test(t)) return true;
  if (/"ok"\s*:\s*false/i.test(t)) return true;
  const m = /Exit code:\s*(-?\d+)/i.exec(t);
  if (m && Number(m[1]) !== 0) return true;
  return false;
}

function extractLinks(text) {
  const found = [];
  const re = /https?:\/\/[^\s<>)"'，。；]+/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const link = m[0].replace(/[\]，。；、]+$/, '');
    if (!found.includes(link)) found.push(link);
  }
  return found;
}

function detectHighRisk(text) {
  let t = String(text || '').replace(/删除(?:本次|任务)?(?:临时)?(?:截图|文件|目录|项|缓存|垃圾)/g, '清理临时项');
  t = t.replace(/发送成功|回传成功/g, '交付成功');
  if (/付款|支付|转账|充值|购买|下单|退款|提现/.test(t)) return '支付/交易';
  if (/删除|清空|格式化|卸载|注销|封禁|停机|关机|重启电脑/.test(t)) return '删除/系统变更';
  if (/提交|发布|公开|上传到|报名|签署|同意协议|授权|解绑|绑定/.test(t)) return '外部提交/发布';
  if (/发给|发送给|发消息给|发邮件|群发|转发给/.test(t)) return '对外发送';
  if (/安装|下载并运行|执行安装包/.test(t)) return '安装软件';
  return '';
}

function isConfirmation(text) {
  return /^(确认执行|确认|同意|同意执行|可以执行|执行吧|继续执行|批准)$/i.test(String(text || '').trim());
}

function isCancellation(text) {
  return /^(取消|不执行|算了|停止|不要执行)$/i.test(String(text || '').trim());
}

function normalizeWindowList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function windowKey(w) {
  return [w && w.Id, w && w.MainWindowHandle, w && w.MainWindowTitle].join('|');
}

function getVisibleWindows() {
  return new Promise(resolve => {
    const ps = "$items=@(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id,ProcessName,MainWindowHandle,MainWindowTitle); if($items.Count -eq 0){'[]'}else{$items|ConvertTo-Json -Depth 3 -Compress}";
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => (out += d.toString('utf8')));
    child.on('error', () => resolve([]));
    child.on('close', () => {
      try { resolve(normalizeWindowList(JSON.parse(out.trim()))); } catch (_) { resolve([]); }
    });
  });
}

function parseLastJson(text) {
  const lines = String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch (_) {}
  }
  return null;
}

function captureScreen(taskId) {
  return new Promise(resolve => {
    const dir = path.join(TEMP_ROOT, taskId);
    const outPath = path.join(dir, 'desktop.png');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CAPTURE_SCRIPT, '-OutputPath', outPath, '-DelayMs', '600'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d.toString('utf8')));
    child.stderr.on('data', d => (err += d.toString('utf8')));
    child.on('error', e => resolve({ ok: false, path: outPath, error: String(e), visibleWindows: [] }));
    child.on('close', () => {
      const j = parseLastJson(out);
      if (j && j.ok) { j.visibleWindows = normalizeWindowList(j.visibleWindows); resolve(j); }
      else resolve({ ok: false, path: outPath, error: (j && j.error) || err || out || 'screenshot failed', visibleWindows: [] });
    });
  });
}

function sendImageReply(messageId, imagePath) {
  return new Promise(resolve => {
    const cwd = path.dirname(imagePath);
    const name = path.basename(imagePath);
    const child = spawn(LARK, ['im', '+messages-reply', '--as', 'bot', '--message-id', messageId, '--image', name], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d.toString('utf8')));
    child.stderr.on('data', d => (err += d.toString('utf8')));
    child.on('error', e => resolve({ ok: false, error: String((e && e.message) || e) }));
    child.on('close', () => {
      try { const j = parseJsonObjectOutput(out, err); resolve({ ok: !!(j && j.ok), raw: j }); }
      catch (_) { resolve({ ok: false, error: out || err }); }
    });
  });
}

function sendImageToChat(chatId, imagePath) {
  return new Promise(resolve => {
    const cwd = path.dirname(imagePath);
    const name = path.basename(imagePath);
    const child = spawn(LARK, ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--image', name], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d.toString('utf8')));
    child.stderr.on('data', d => (err += d.toString('utf8')));
    child.on('error', e => resolve({ ok: false, error: String((e && e.message) || e) }));
    child.on('close', () => {
      try { const j = parseJsonObjectOutput(out, err); resolve({ ok: !!(j && j.ok), raw: j }); }
      catch (_) { resolve({ ok: false, error: out || err }); }
    });
  });
}

function parseJsonObjectOutput(out, err) {
  const text = String(out || '').trim();
  try { return JSON.parse(text); } catch (_) {}
  const start = text.indexOf('{');
  const finish = text.lastIndexOf('}');
  if (start >= 0 && finish > start) {
    try { return JSON.parse(text.slice(start, finish + 1)); } catch (_) {}
  }
  const e = String(err || '').trim();
  if (e) {
    const es = e.indexOf('{');
    const ee = e.lastIndexOf('}');
    if (es >= 0 && ee > es) { try { return JSON.parse(e.slice(es, ee + 1)); } catch (_) {} }
  }
  return null;
}

function safeRemoveTaskTemp(taskId) {
  try {
    const root = path.resolve(TEMP_ROOT) + path.sep;
    const target = path.resolve(TEMP_ROOT, String(taskId || ''));
    if (!target.startsWith(root) || target === path.resolve(TEMP_ROOT)) return false;
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function cleanupStaleTemp() {
  try {
    const root = path.resolve(TEMP_ROOT) + path.sep;
    for (const name of fs.readdirSync(TEMP_ROOT)) {
      const target = path.resolve(TEMP_ROOT, name);
      if (!target.startsWith(root)) continue;
      try { if (Date.now() - fs.statSync(target).mtimeMs > 60 * 60 * 1000) fs.rmSync(target, { recursive: true, force: true }); } catch (_) {}
    }
  } catch (_) {}
}

function loadDeliveredFiles() {
  try { return JSON.parse(fs.readFileSync(DELIVERED_FILES_FILE, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return {}; }
}

function recordDeliveredFiles(paths) {
  const data = loadDeliveredFiles();
  const now = Date.now();
  for (const p of paths || []) data[path.resolve(p)] = { deliveredAt: now, name: path.basename(p) };
  try { fs.writeFileSync(DELIVERED_FILES_FILE, JSON.stringify(data, null, 2)); } catch (_) {}
}

function cleanupDeliveredFiles() {
  const data = loadDeliveredFiles();
  let changed = false;
  const allowed = [path.resolve(OUT_DIR), path.resolve(CODEX_CWD)];
  for (const [file, info] of Object.entries(data)) {
    const resolved = path.resolve(file);
    const inside = allowed.some(root => resolved === root || resolved.startsWith(root + path.sep));
    const deliveredAt = Number(info && info.deliveredAt) || 0;
    if (!inside || !deliveredAt || Date.now() - deliveredAt < ARTIFACT_RETENTION_MS) continue;
    try { if (!fs.existsSync(resolved)) { delete data[file]; changed = true; continue; } if (Date.now() - deliveredAt >= ARTIFACT_RETENTION_MS) { fs.unlinkSync(resolved); delete data[file]; changed = true; } } catch (_) {}
  }
  if (changed) { try { fs.writeFileSync(DELIVERED_FILES_FILE, JSON.stringify(data, null, 2)); } catch (_) {} }
}

function writeAudit(entry) {
  try { fs.appendFileSync(AUDIT_FILE, JSON.stringify(redactSensitiveValue(entry)) + '\n'); } catch (_) {}
}

function buildVerification(userText, evidence, windowsBefore, screen) {
  const before = new Set((windowsBefore || []).map(windowKey));
  const after = normalizeWindowList(screen && screen.visibleWindows);
  const newWindows = after.filter(w => !before.has(windowKey(w)));
  return {
    actionIntent: ACTION_INTENT_RE.test(userText),
    guiIntent: GUI_INTENT_RE.test(userText),
    closeIntent: CLOSE_INTENT_RE.test(userText),
    requiresNewWindow: NEW_WINDOW_INTENT_RE.test(userText),
    claimed: COMPLETION_RE.test(String(userText || '')),
    totalTools: evidence.total,
    successfulTools: evidence.successful,
    failedTools: evidence.failed,
    newWindowCount: newWindows.length,
    newWindows,
    screenshotOk: !!(screen && screen.ok),
    screenCount: Number((screen && screen.screenCount) || 0),
    screenshotError: (screen && screen.error) || '',
    locked: !!(screen && screen.locked),
    imageSent: false
  };
}

function sanitizeCompletionText(text, unverified) {
  let out = String(text || '').trim();
  if (!unverified) return out;
  out = out.replace(/完美完成/g, '执行结果未完全核验');
  out = out.replace(/已经完成|已完成|任务完成|大功告成/g, '执行结果未完全核验');
  return out;
}

function gateReply(reply, v, channel = 'feishu') {
  let text = redactSensitiveText(reply).trim();
  const channelLabel = channel === 'telegram' ? 'Telegram' : '飞书';
  const links = extractLinks(text);
  const delivered = (v.deliveredFiles || []).map(x => path.basename(x));
  const failedFiles = (v.failedFiles || []).map(x => path.basename(x));
  const windows = (v.newWindows || []).map(w => [w && w.ProcessName, w && w.MainWindowTitle].filter(Boolean).join(' - ')).filter(Boolean);
  const warnings = [];
  if (v.actionIntent && v.successfulTools === 0) warnings.push('没有检测到成功的工具执行记录');
  if (v.requiresNewWindow && v.newWindowCount === 0) warnings.push('没有检测到新增的可见窗口');
  if (!v.screenshotOk) warnings.push('没有取得桌面截图');
  if (v.locked) warnings.push('桌面处于锁屏状态');
  if (!v.imageSent) warnings.push('截图未能发送到' + channelLabel);
  if (failedFiles.length) warnings.push('有 ' + failedFiles.length + ' 个文件未成功回传到' + channelLabel);
  const unverified = warnings.length > 0;
  text = sanitizeCompletionText(text, unverified);
  let prefix = '';
  if (unverified) {
    const label = v.actionIntent && v.successfulTools === 0 ? '❌ 未执行或无法确认' : '⚠️ 结果未完全核验';
    prefix = '**' + label + '**\n\n' + warnings.map(x => '- ' + x).join('\n') + '\n\n';
  }
  const userView = [];
  userView.push(channelLabel + '图片：' + (v.imageSent ? '本条消息下方已附完整桌面截图' + (v.screenCount ? '（' + v.screenCount + ' 台显示器）' : '') : '桌面截图未发送成功'));
  userView.push('结果链接：' + (links.length ? links.join('、') : '本轮没有可点击链接'));
  userView.push('结果文件：' + (delivered.length ? delivered.join('、') : '本轮没有文件产物'));
  if (windows.length) userView.push('电脑窗口：' + windows.slice(0, 4).join('；'));
  else if (v.closeIntent) userView.push('电脑状态：目标程序应已关闭，请结合截图确认');
  else userView.push('电脑状态：请查看截图里的桌面状态');
  userView.push('验收顺序：先看飞书截图，再点链接或文件，最后看电脑窗口/目标状态');
  const evidenceLines = [
    '- 工具执行：' + v.totalTools + ' 次调用，' + v.successfulTools + ' 次成功，' + v.failedTools + ' 次失败',
    '- 用户侧怎么看：' + userView.join('；'),
    '- 飞书交付：截图' + (v.imageSent ? '已发送' : '未发送') + '；文件' + (delivered.length ? delivered.join('、') + '已发送' : '无'),
    '- 正式文件保留：回传成功后保留 24 小时，然后自动清理',
    '- 临时文件：截图发送成功后立即删除'
  ];
  return prefix + text + '\n\n**【用户视角验收】**\n' + userView.map(x => '- ' + x).join('\n') + '\n\n**【机器核验】**\n' + evidenceLines.join('\n');
}

function readReplyFile() {
  try {
    let t = fs.readFileSync(REPLY_FILE, 'utf8').trim();
    if (t.length > MAX_REPLY) t = t.slice(0, MAX_REPLY) + '\n…（内容过长已截断）';
    return t;
  } catch (_) { return ''; }
}

function chooseTaskModel() {
  return (currentModelConfig && currentModelConfig.model) || readCodexModelConfig().model || '';
}

function runCodex(sessionId, promptText) {
  return new Promise((resolve, reject) => {
    try { fs.unlinkSync(REPLY_FILE); } catch (_) {}
    const safeCodexHome = BRIDGE_CODEX_HOME.replace(/'/g, "''");
    const safeUserProfile = String(process.env.USERPROFILE || os.homedir()).replace(/'/g, "''");
    const safeHome = String(process.env.HOME || os.homedir()).replace(/'/g, "''");
    const safeAilyBin = String(AILY_BIN || '').replace(/'/g, "''");
    const pathPrefix = `$env:USERPROFILE='${safeUserProfile}'; $env:HOME='${safeHome}'; $env:CODEX_HOME='${safeCodexHome}'; $env:PATH='${safeAilyBin};'+$env:PATH; `;
    const runStartFt = (Date.now() + 11644473600000) * 10000;
    const guardTimer = setInterval(() => {
      const gCmd = "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(Telegram|WeChat|Weixin|WXWork|DingTalk|TIM|QQ)(\\.exe)?$' -and $_.CreationDate.ToFileTimeUtc() -ge " + runStartFt + " } | ForEach-Object { $ppid = $_.ParentProcessId; $par = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ppid) -ErrorAction SilentlyContinue; if ($par -and $par.Name -match 'powershell|cmd|codex') { 'pid=' + $_.ProcessId + ';name=' + $_.Name } }";
      const g = spawn(PS, ['-NoProfile', '-Command', gCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
      let go = '';
      g.stdout.on('data', d => (go += d.toString('utf8')));
      g.on('close', () => {
        for (const line of go.split(/\r?\n/)) {
          const m = /pid=(\d+);name=([^;\r\n]+)/.exec(line);
          if (m) {
            log(`防护：终止运行中被启动的受限应用 ${m[2]} (pid=${m[1]})`);
            try { process.kill(Number(m[1])); } catch (_) {}
          }
        }
      });
      g.on('error', () => {});
    }, 5000);
    const codexExe = resolveCodexExecutable();
    if (!codexExe) { clearInterval(guardTimer); reject(new Error('找不到 codex.exe')); return; }
    const psCmd = buildCodexExecCommand(sessionId, pathPrefix, codexExe);
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', psCmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    activeCodexChild = child;
    let out = '', err = '';
    child.stdout.on('data', d => (out += d.toString('utf8')));
    child.stderr.on('data', d => (err += d.toString('utf8')));
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, EXEC_TIMEOUT_MS);
    child.on('error', e => { clearTimeout(timer); clearInterval(guardTimer); activeCodexChild = null; reject(e); });
    child.on('close', code => {
      activeCodexChild = null;
      clearTimeout(timer); clearInterval(guardTimer);
      const events = parseJsonEvents(out);
      let threadId = sessionId;
      for (const ev of events) { if (ev && ev.type === 'thread.started' && ev.thread_id) threadId = ev.thread_id; if (ev && ev.threadId && !threadId) threadId = ev.threadId; }
      resolve({ threadId, reply: readReplyFile(), code, err: err.slice(0, 500), events });
    });
    try { child.stdin.write(promptText); child.stdin.end(); } catch (_) {}
  });
}

function sendReply(messageId, text) {
  return new Promise(resolve => {
    const child = spawn(LARK, ['im', '+messages-reply', '--as', 'bot', '--message-id', messageId, '--markdown', text], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d.toString('utf8')));
    child.stderr.on('data', d => (err += d.toString('utf8')));
    child.on('error', e => resolve({ ok: false, error: String((e && e.message) || e) }));
    child.on('close', () => {
      try { const j = parseJsonObjectOutput(out, err); resolve({ ok: !!(j && j.ok), raw: j }); }
      catch (_) { resolve({ ok: false, error: out || err }); }
    });
  });
}

function sendTextToChat(chatId, text) {
  return new Promise(resolve => {
    const child = spawn(LARK, ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--markdown', text], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => (out += d.toString('utf8')));
    child.stderr.on('data', d => (err += d.toString('utf8')));
    child.on('error', e => resolve({ ok: false, error: String((e && e.message) || e) }));
    child.on('close', () => {
      try { const j = parseJsonObjectOutput(out, err); resolve({ ok: !!(j && j.ok), raw: j }); }
      catch (_) { resolve({ ok: false, error: out || err }); }
    });
  });
}

function notifyBridgeUp(reason) {
  if (!CONFIG.feishu.enabled || !NOTIFY_CHAT_ID) return;
  const now = Date.now();
  if (now - lastNotifyTs < NOTIFY_DEDUP_MS) return;
  lastNotifyTs = now;
  const text = reason === '重连' ? '✅ 桥接已重新连接，随时待命～' : '✅ 桥接成功，随时待命～';
  sendTextToChat(NOTIFY_CHAT_ID, text).then(r => {
    if (r.ok) log('已发送桥接成功通知（' + reason + '\uff09');
    else log('桥接通知发送失败: ' + JSON.stringify(r).slice(0, 200));
  });
}

function sendFileToChat(chatId, filePath) {
  return new Promise(resolve => {
    const cwd = path.dirname(filePath);
    const name = path.basename(filePath);
    const child = spawn(LARK, ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId, '--file', name], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    child.stdout.on('data', d => (o += d.toString('utf8')));
    child.stderr.on('data', d => (e += d.toString('utf8')));
    child.on('error', err => resolve({ ok: false, error: String(err) }));
    child.on('close', () => {
      try { const j = parseJsonObjectOutput(o, e); resolve({ ok: !!(j && j.ok), raw: j }); }
      catch (_) { resolve({ ok: false, error: o || e }); }
    });
  });
}

function getDelivery(channel, chatId, messageId) {
  if (channel === 'telegram') {
    if (!CONFIG.telegram.enabled) throw new Error('Telegram 通道未启用');
    if (!telegramChannel) throw new Error('Telegram 通道未启动');
    const tgChatId = Number(String(chatId).replace(/^tg:/, ''));
    return {
      text: async text => {
        try { return await telegramChannel.sendText(tgChatId, messageId, text); }
        catch (e) { return { ok: false, error: String(e.message || e) }; }
      },
      image: async filePath => {
        try { return await telegramChannel.sendDocument(tgChatId, messageId, filePath, '桌面截图'); }
        catch (e) { return { ok: false, error: String(e.message || e) }; }
      },
      file: async filePath => {
        try { return await telegramChannel.sendDocument(tgChatId, messageId, filePath); }
        catch (e) { return { ok: false, error: String(e.message || e) }; }
      }
    };
  }
  if (!CONFIG.feishu.enabled) throw new Error('Feishu 通道未启用');
  return {
    text: async text => {
      let r = await sendReply(messageId, text);
      if (!r.ok) r = await sendTextToChat(chatId, text);
      return r;
    },
    image: async filePath => {
      let r = await sendImageReply(messageId, filePath);
      if (!r.ok) r = await sendImageReply(messageId, filePath);
      if (!r.ok) r = await sendImageToChat(chatId, filePath);
      return r;
    },
    file: filePath => sendFileToChat(chatId, filePath)
  };
}

async function handleTelegramMessage(msg) {
  const chatId = 'tg:' + msg.chatId;
  const event = {
    type: 'im.message.receive_v1',
    sender_type: 'user',
    chat_id: chatId,
    message_id: String(msg.messageId),
    content: String(msg.text || '')
  };
  return enqueue(chatId, () => processChat(chatId, [event], 'telegram'));
}
function downloadResources(messageId, content) {
  return new Promise(resolve => {
    const keys = [];
    const re = /<(?:file|img|image)\s+key="([^"]+)"/g;
    let m; while ((m = re.exec(content))) keys.push(m[1]);
    if (!keys.length) return resolve([]);
    fs.mkdirSync(DL_DIR, { recursive: true });
    const outPaths = [];
    let i = 0;
    const next = () => {
      if (i >= keys.length) return resolve(outPaths);
      const key = keys[i++];
      const type = key.startsWith('img') ? 'image' : 'file';
      const outName = `${messageId}_${key.replace(/[^\w.-]/g, '_')}`;
      const child = spawn(LARK, ['im', '+messages-resources-download', '--as', 'bot', '--message-id', messageId, '--file-key', key, '--type', type, '--output', outName], { cwd: DL_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
      let o = '', e = '';
      child.stdout.on('data', d => (o += d.toString('utf8')));
      child.stderr.on('data', d => (e += d.toString('utf8')));
      child.on('close', () => {
        try {
          const j = parseJsonObjectOutput(o, e);
          let saved = null;
          if (j && j.data) saved = j.data.file_path || j.data.path || j.data.output || j.data.name || null;
          if (!saved && j && j.ok && typeof j.data === 'string') saved = j.data;
          if (saved) outPaths.push(path.join(DL_DIR, saved));
          else {
            const found = fs.readdirSync(DL_DIR).filter(f => f.startsWith(outName));
            if (found.length) outPaths.push(path.join(DL_DIR, found[0]));
            else log(`下载失败 msg=${messageId} key=${key} out=${o} err=${e}`);
          }
        } catch (_) { log(`下载解析失败 msg=${messageId} key=${key}`); }
        next();
      });
    };
    next();
  });
}

function extractDocText(filePath) {
  return new Promise(resolve => {
    const ps1 = path.join(WORK, 'extract-doc.ps1');
    const child = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-DocPath', filePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    child.stdout.on('data', d => (o += d.toString('utf8')));
    child.stderr.on('data', d => (e += d.toString('utf8')));
    child.on('close', () => {
      const txt = filePath + '.extracted.txt';
      if (fs.existsSync(txt)) resolve(txt);
      else { log(`doc提取失败 ${path.basename(filePath)}: ${(o + e).trim().slice(0, 200)}`); resolve(null); }
    });
  });
}

function stripPlaceholders(content) {
  return content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function describeFile(f) {
  const txt = f + '.extracted.txt';
  return fs.existsSync(txt) ? `已提取为文本: ${txt}（原始文件: ${f}）` : f;
}

const chatBuf = {};
const chatTimers = {};
const chatQueues = {};
let activeCodexChild = null;
let pausedByUser = false;

function enqueue(chatId, work) {
  const prev = chatQueues[chatId] || Promise.resolve();
  const run = prev.then(work, work);
  chatQueues[chatId] = run.catch(() => {});
  return run;
}

function onEvent(ev) {
  if (!ev || ev.type !== 'im.message.receive_v1') return;
  if (ev.sender_type === 'bot') return;
  const chatId = ev.chat_id;
  if (!chatId) return;
  const cleanNow = stripPlaceholders((ev.content || '').trim());
  if (/^(状态|健康|health|status)$/i.test(cleanNow)) {
    enqueue(chatId, async () => {
      try { const h = await runHealthCheck('用户查询', false); await sendReply(ev.message_id, healthStateText(h)); }
      catch (e) { await sendReply(ev.message_id, '健康检查失败：' + e.message); }
    });
    return;
  }
  if (/^暂停$/i.test(cleanNow)) {
    pausedByUser = true;
    if (activeCodexChild) { try { activeCodexChild.kill('SIGKILL'); } catch (_) {} }
    const st0 = loadState(); const g0 = getGlobal(st0); g0.paused = true; st0._global = g0; saveState(st0);
    sendReply(ev.message_id, '已暂停，正在执行的任务已停止；回复「继续」恢复。').catch(() => {});
    log('用户要求暂停（即时停止）');
    return;
  }
  if (/^(继续|恢复|resume)$/i.test(cleanNow)) {
    const st0 = loadState(); const g0 = getGlobal(st0); g0.paused = false; g0.consecFails = 0; st0._global = g0; saveState(st0);
    sendReply(ev.message_id, '已恢复，继续处理～').catch(() => {});
    log('用户要求恢复');
    return;
  }
  if (!chatBuf[chatId]) chatBuf[chatId] = [];
  chatBuf[chatId].push(ev);
  clearTimeout(chatTimers[chatId]);
  chatTimers[chatId] = setTimeout(() => {
    const id = chatId;
    clearTimeout(chatTimers[id]);
    delete chatTimers[id];
    const batch = (chatBuf[id] || []).splice(0);
    delete chatBuf[id];
    if (batch.length) enqueue(id, () => processChat(id, batch));
  }, BATCH_WAIT_MS);
}

async function processChat(chatId, batch, channel = 'feishu') {
  if (!batch || !batch.length) return;
  const earlyMsgId = [...batch].reverse().find(ev => ev && ev.message_id)?.message_id || null;
  const modelReady = await ensureCurrentModelReady('任务前验证', { retryMs: 30000 });
  if (!modelReady.ok) {
    if (earlyMsgId) {
      const failedDelivery = getDelivery(channel, chatId, earlyMsgId);
      await failedDelivery.text('⚠️ **当前 CC Switch API 未连通，任务没有执行**\n\n' + modelStatusText(modelReady) + '\n\n请检查 CC Switch 后发送「状态」重试。');
    }
    appendTaskHistory({
      at: new Date().toISOString(), taskId: 'api-failed-' + Date.now(), chatId, channel,
      userText: batch.map(ev => stripPlaceholders(ev.content || '')).filter(Boolean).join('\n').slice(0, 500),
      status: 'failed', summary: '当前 API 实调失败，任务未执行', links: [], artifacts: [],
      model: modelReady.model || '', error: sanitizeDiagnostic(modelReady.error || '')
    });
    log('任务被 API 验证门禁拦截: ' + sanitizeDiagnostic(modelReady.error || ''));
    return;
  }
  const taskModel = modelReady.model || chooseTaskModel();
  syncAgentRules();
  const state = loadState();
  const rec = state[chatId] || {};
  const sessionMatchesModel = !!rec.sessionId && rec.modelFingerprint === modelReady.fingerprint;
  let sessionId = sessionMatchesModel ? rec.sessionId : null;
  const turns = (sessionMatchesModel ? (rec.turns || 0) : 0) + 1;

  const texts = [];
  const allFiles = [];
  let lastMsgId = null;
  for (const ev of batch) {
    lastMsgId = ev.message_id;
    const content = (ev.content || '').trim();
    if (!content) continue;
    const clean = stripPlaceholders(content);
    const files = await downloadResources(ev.message_id, content);
    if (files.length) log(`下载附件 msg=${ev.message_id}: ${files.map(f => path.basename(f)).join(', ')}`);
    if (clean) texts.push(clean);
    allFiles.push(...files);
  }
  if (!lastMsgId) return;
  const delivery = getDelivery(channel, chatId, lastMsgId);

  const pending = (rec.pendingFiles || []).filter(f => fs.existsSync(f));
  const archive = (rec.archive || []).filter(f => fs.existsSync(f));
  const seen = new Set();
  const combined = [];
  for (const f of pending.concat(allFiles)) { if (!seen.has(f)) { seen.add(f); combined.push(f); } }

  for (const f of combined) { if (!archive.includes(f)) archive.push(f); }
  while (archive.length > MAX_ARCHIVE) archive.shift();

  const prepared = [];
  for (const f of combined) {
    const ext = path.extname(f).toLowerCase();
    if (ext === '.doc' || ext === '.docx') {
      const txt = await extractDocText(f);
      prepared.push(txt ? `已提取为文本: ${txt}（原始文件: ${f}）` : f);
    } else prepared.push(f);
  }

  let userText = texts.join('\n');
  const historyBlock = getTaskHistoryBlock(userText);
  let pendingConfirmation = rec.pendingConfirmation || null;

  if (!userText) {
    state[chatId] = { sessionId, pendingFiles: prepared, archive, turns, lastMsgId, lastAt: Date.now(), modelFingerprint: modelReady.fingerprint };
    saveState(state);
    const names = allFiles.map(f => path.basename(f)).join('、');
    await delivery.text(`已收到文件：**${names}**。想让我做什么？直接说就行（比如"总结"、"做成 PPT"）。`);
    log(`已存附件待处理 chat=${chatId} files=${prepared.length}`);
    return;
  }

  const g = getGlobal(state);

  if (pendingConfirmation) {
    if (isConfirmation(userText)) {
      userText = pendingConfirmation.task + '\n\n[用户本人已明确确认执行上述高风险操作]';
      pendingConfirmation = null;
    } else if (isCancellation(userText)) {
      state[chatId] = { sessionId, pendingFiles: [], archive, turns, lastMsgId, lastAt: Date.now(), modelFingerprint: modelReady.fingerprint };
      state._global = g;
      saveState(state);
      await delivery.text('已取消，高风险操作没有执行。');
      log('用户取消高风险任务');
      return;
    } else {
      await delivery.text('当前有一条高风险任务等待确认。请回复「确认执行」或「取消」，确认前不会执行。');
      return;
    }
  } else {
    const risk = detectHighRisk(userText);
    if (risk) {
      state[chatId] = { sessionId, pendingFiles: prepared, archive, turns, lastMsgId, lastAt: Date.now(), modelFingerprint: modelReady.fingerprint, pendingConfirmation: { task: userText, risk, at: Date.now() } };
      state._global = g;
      saveState(state);
      await delivery.text('⚠️ 高风险操作需要你本人确认\n\n类型：**' + risk + '**\n任务：' + userText.slice(0, 300) + '\n\n确认执行请回复「确认执行」；取消请回复「取消」。');
      log('高风险任务等待用户确认: ' + risk);
      return;
    }
  }

  if (g.paused) {
    if (/^(恢复|继续|resume)$/i.test(userText.trim())) {
      g.paused = false; g.consecFails = 0;
      state._global = g; saveState(state);
      await delivery.text('已恢复，继续处理～');
      log('用户已恢复处理');
      return;
    }
    await delivery.text('当前已暂停自动处理以节省额度。发「恢复」继续。');
    log('暂停中，跳过处理');
    return;
  }
  if (g.runsToday >= DAILY_RUN_LIMIT) {
    await delivery.text(`今日处理次数已达上限（${DAILY_RUN_LIMIT} 次），明天再试；如需调整额度告诉我。`);
    log('达到每日上限，跳过');
    return;
  }
  if (sessionId && turns > MAX_TURNS_PER_SESSION) {
    log(`会话轮次 ${turns} 超过 ${MAX_TURNS_PER_SESSION}，开启新会话`);
    sessionId = null;
  }

  state[chatId] = { sessionId, pendingFiles: [], archive, turns, lastMsgId, lastAt: Date.now(), modelFingerprint: modelReady.fingerprint };
  state._global = g;
  saveState(state);

  const shared = readSharedMemory();
  const sharedBlock = shared ? `【跨端对话记忆（最近与用户的交流背景，供参考，不要提及本段来源）】\n${shared}\n\n` : '';
  const channelBlock = channel === 'telegram' ? '【当前通道：Telegram。用户视角验收要写 Telegram，不要写飞书。】\n' : '【当前通道：飞书。】\n';
  let prompt = sharedBlock + channelBlock + getTaskProtocolPrompt() + historyBlock + (sessionId ? `${SAFETY_RULES}用户: ${userText}` : `${ROLE_PROMPT}\n\n${SAFETY_RULES}用户: ${userText}`);
  let fileDesc = prepared;
  let fileNote = '';
  if (prepared.length) {
    fileNote = `用户发送了附件文件：\n${prepared.map(p => '- ' + p).join('\n')}\n\n`;
  } else if (archive.length && TASK_HINTS.test(userText)) {
    fileDesc = archive.map(describeFile);
    fileNote = `用户之前在本聊天中发送过的文件（用户已确认这些是给助手使用的资料，请直接读取使用）：\n${fileDesc.map(p => '- ' + p).join('\n')}\n\n`;
  }
  if (fileNote) prompt = fileNote + prompt;
  log(`处理 ${channel} chat=${chatId} session=${sessionId || 'NEW'} text=${userText.slice(0, 60)} files=${prepared.length} arch=${fileDesc.length} (batch=${batch.length})`);

  await delivery.text('收到，正在处理，稍等～（复杂任务可能需要几分钟）').catch(() => {});

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const DOC_EXT_STRICT = /\.(pptx|ppt|docx|doc|xlsx|xls|csv|pdf)$/i;
  const DOC_EXT_LOOSE = /\.(pptx|ppt|docx|doc|xlsx|xls|csv|pdf|txt|md)$/i;
  const snapshotDocs = () => {
    const m = new Map();
    const scan = (d, re) => { try { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); try { const st = fs.statSync(p); if (st.isFile() && re.test(f)) m.set(p, st.mtimeMs); } catch (_) {} } } catch (_) {} };
    scan(OUT_DIR, DOC_EXT_LOOSE);
    return m;
  };
  const docsBefore = snapshotDocs();
  const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const windowsBefore = await getVisibleWindows();

  let res;
  try {
    res = await runCodex(sessionId, prompt);
    if (res.code !== 0 && !pausedByUser) {
      log(`codex 首次失败 code=${res.code}，重试（新会话）`);
      res = await runCodex(null, `${channelBlock}${historyBlock}${SAFETY_RULES}${ROLE_PROMPT}\n\n用户: ${userText}\n\n${fileNote ? fileNote + '\n' : ''}`);
    }
  } catch (e) {
    log(`codex 启动失败: ${e}`);
    try { res = await runCodex(null, `${channelBlock}${historyBlock}${SAFETY_RULES}${ROLE_PROMPT}\n\n用户: ${userText}${fileNote ? '\n\n' + fileNote : ''}`); }
    catch (e2) {
      log(`重试仍失败: ${e2}`);
      await delivery.text(`处理失败（无法启动 Codex）：${e2}。请稍后重试。`);
      return;
    }
  }

  if (res.code !== 0) {
    if (pausedByUser) { pausedByUser = false; return; }
    log(`codex 重试后仍失败 code=${res.code} err=${res.err}`);
    await delivery.text(`处理失败（Codex 异常退出 code=${res.code}），请稍后重试。`);
    return;
  }
  if (res.threadId) {
    state[chatId] = { sessionId: res.threadId, pendingFiles: [], archive, turns, lastMsgId, lastAt: Date.now(), modelFingerprint: modelReady.fingerprint };
    state._global = g;
    saveState(state);
  }
  const rawReply = res.reply || '(处理完成，但没有输出文本)';
  const toolEvidence = collectToolEvidence(res.events || []);
  const screen = await captureScreen(taskId);
  let imageSent = false;
  let imageResult = { ok: false, error: 'no screenshot' };
  if (screen.ok && fs.existsSync(screen.path)) {
    imageResult = await delivery.image(screen.path);
    imageSent = !!imageResult.ok;
  }

  const docsNow = snapshotDocs();
  const delivered = [];
  const failedFiles = [];
  for (const [filePath, mtime] of docsNow) {
    if (docsBefore.has(filePath) && docsBefore.get(filePath) === mtime) continue;
    if (wasFileSentByTool(filePath, toolEvidence)) { delivered.push(filePath); log('跳过重复回传 ' + path.basename(filePath) + '：模型已直接发送'); continue; }
    const sent = await delivery.file(filePath);
    if (sent.ok) delivered.push(filePath); else failedFiles.push(filePath);
    log('回传文件 ' + path.basename(filePath) + ': ' + (sent.ok ? 'OK' : 'FAIL ' + JSON.stringify(sent).slice(0, 200)));
  }
  if (delivered.length) recordDeliveredFiles(delivered);

  const verification = buildVerification(userText, toolEvidence, windowsBefore, screen);
  verification.imageSent = imageSent;
  verification.deliveredFiles = delivered;
  verification.failedFiles = failedFiles;
  const taskStatus = classifyTaskStatus(verification);
  const reply = gateReply(rawReply, verification, channel);
  let sr = await delivery.text(reply);
  const textSent = !!sr.ok;
  log('模型=' + taskModel + ' 回复 chat=' + chatId + ' 长度=' + reply.length + ' tools=' + toolEvidence.successful + '/' + toolEvidence.total + ' newWindows=' + verification.newWindowCount + ' screenshot=' + (screen.ok ? 'OK' : 'FAIL') + ' imageSent=' + imageSent + ' textSent=' + textSent);
  appendSharedMemory('用户(' + channel + '): ' + userText.slice(0, 200) + '\nCodex: ' + rawReply.slice(0, 500));
  try { fs.appendFileSync(path.join(WORK, 'reports.md'), '## ' + new Date().toLocaleString('zh-CN') + '\n**任务**: ' + redactSensitiveText(userText).slice(0, 200) + '\n**执行结果**: ' + redactSensitiveText(reply).slice(0, 1400) + '\n\n'); } catch (_) {}

  const cleanupDone = safeRemoveTaskTemp(taskId);
  appendTaskHistory({
    at: new Date().toISOString(), taskId, chatId, channel, userText: userText.slice(0, 500), status: taskStatus,
    summary: rawReply.slice(0, 500), links: extractLinks(reply), artifacts: delivered.map(f => path.basename(f)), artifactPaths: delivered,
    replyMessageId: sr.messageId || (sr.raw && sr.raw.data && sr.raw.data.message_id) || '', imageMessageId: imageResult.messageId || (imageResult.raw && imageResult.raw.data && imageResult.raw.data.message_id) || '',
    model: taskModel, screenshotHash: screen.hash || '', screenshotSent: imageSent, textSent, toolSuccessful: toolEvidence.successful, toolTotal: toolEvidence.total,
    newWindowCount: verification.newWindowCount, failedFiles: failedFiles.map(f => path.basename(f))
  });
  writeAudit({
    at: new Date().toISOString(), taskId, chatId, userText: userText.slice(0, 500), rawReply: rawReply.slice(0, 2000),
    toolTotal: toolEvidence.total, toolSuccessful: toolEvidence.successful, toolFailed: toolEvidence.failed,
    newWindowCount: verification.newWindowCount, screenshotOk: screen.ok, screenCount: verification.screenCount, screenshotHash: screen.hash || '', imageSent,
    textSent, deliveredFiles: delivered, failedFiles, screenshotError: screen.error || '', cleanup: cleanupDone
  });
  cleanupDeliveredFiles();
}

function scheduleConsumerRestart(reason) {
  if (!CONFIG.feishu.enabled || !LARK || consumerRestartTimer) return;
  consumerFailures += 1;
  const delay = Math.min(10000 * Math.pow(2, Math.max(0, consumerFailures - 1)), 300000);
  log('consumer 异常退出，' + Math.round(delay / 1000) + ' 秒后第 ' + consumerFailures + ' 次重启' + (reason ? '：' + reason : ''));
  if (consumerFailures === 1 || consumerFailures === 3 || consumerFailures % 10 === 0) {
    sendTextToChat(NOTIFY_CHAT_ID, '⚠️ 飞书事件消费者异常，已进入自动恢复。连续失败：' + consumerFailures + ' 次。').catch(() => {});
  }
  consumerRestartTimer = setTimeout(() => { consumerRestartTimer = null; startConsumer('重连'); }, delay).unref();
}

function scheduleTelegramRestart(reason) {
  if (telegramRestartTimer) return;
  const delay = Math.min(60000, 5000 * Math.pow(2, Math.min(telegramFailures, 4)));
  telegramRestartTimer = setTimeout(() => {
    telegramRestartTimer = null;
    startTelegramAdapter(reason).catch(() => {});
  }, delay);
  telegramRestartTimer.unref && telegramRestartTimer.unref();
  log('Telegram ' + delay / 1000 + ' 秒后重试启动');
}

async function startTelegramAdapter(reason = '启动') {
  if (!CONFIG.telegram.enabled) return null;
  if (telegramChannel && typeof telegramChannel.getStatus === 'function' && telegramChannel.getStatus().ok) return telegramChannel;
  try {
    const mod = await import(pathToFileURL(TELEGRAM_CHANNEL_PATH).href);
    telegramChannel = await mod.startTelegramChannel({
      config: {
        botToken: CONFIG.telegram.botToken,
        allowedUserIds: CONFIG.telegram.allowedUserIds,
        proxyUrl: CONFIG.telegram.proxyUrl
      },
      offsetPath: CONFIG.telegram.offsetFile,
      onLog: message => log('Telegram: ' + message),
      onMessage: handleTelegramMessage,
      onStatus: async () => {
        const health = await runHealthCheck('Telegram 状态', false);
        return healthStateText(health);
      },
      onReset: async chatId => {
        const st = loadState();
        delete st['tg:' + chatId];
        saveState(st);
      }
    });
    telegramFailures = 0;
    log('Telegram 通道已启动: @' + (telegramChannel.botUsername || 'bot'));
  } catch (e) {
    telegramFailures++;
    const cause = e && e.cause ? (e.cause.code || e.cause.message || '') : '';
    log('Telegram 通道启动失败(' + telegramFailures + '/' + reason + '): ' + sanitizeDiagnostic(e.message + (cause ? ' / ' + cause : '')));
    scheduleTelegramRestart(reason);
  }
}
function startConsumer(reason) {
  if (!CONFIG.feishu.enabled || !LARK) {
    log('Feishu consumer 未启动: 通道未启用或 LARK CLI 路径为空');
    return null;
  }
  if (consumerRestartTimer) { clearTimeout(consumerRestartTimer); consumerRestartTimer = null; }
  const consumer = spawn(LARK, ['event', 'consume', 'im.message.receive_v1', '--as', 'bot', '--quiet'], { stdio: ['pipe', 'pipe', 'pipe'] });
  consumerChild = consumer;
  let buf = '';
  consumer.stdout.on('data', d => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      try { onEvent(JSON.parse(line)); } catch (e) { log('事件解析失败: ' + e); }
    }
  });
  consumer.stderr.on('data', d => log('consumer stderr: ' + d.toString('utf8').trim().slice(0, 300)));
  let handled = false;
  const restart = () => {
    if (handled) return;
    handled = true;
    if (consumerChild === consumer) consumerChild = null;
    scheduleConsumerRestart(reason);
  };
  consumer.once('exit', restart);
  consumer.once('error', restart);
  const stableTimer = setTimeout(() => {
    if (consumer.exitCode === null) {
      consumerFailures = 0;
      runHealthCheck('消费者稳定', true).catch(() => {});
    }
  }, 15000).unref();
  consumer.once('close', () => clearTimeout(stableTimer));
  log('consumer PID=' + consumer.pid);
  setTimeout(() => { if (consumer.exitCode === null) notifyBridgeUp(reason); }, 4000).unref();
  return consumer;
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`feishu-telegram-codex-bridge ${VERSION}

Commands:
  node bridge.js                 Start the bridge
  node bridge.js --selftest      Run local self-tests
  node bridge.js --model-check   Probe the current Codex/CC Switch model
  node bridge.js --health-check  Run one health check
  node bridge.js --sync-rules    Sync the remote task protocol
  node bridge.js --history       Show recent task history
  node bridge.js --version       Print version`);
  process.exit(0);
} else if (process.argv.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
} else if (process.argv.includes('--sync-rules')) {
  syncAgentRules();
  console.log('RULES_SYNCED');
  process.exit(0);
} else if (process.argv.includes('--test-telegram')) {
  const ti = process.argv.indexOf('--test-telegram');
  const tgChatId = Number(process.argv[ti + 1]);
  const testText = process.argv[ti + 2] || 'Telegram 链路测试：只读获取当前时间，完成后附桌面截图。';
  (async () => {
    await startTelegramAdapter();
    if (!telegramChannel || typeof telegramChannel.sendText !== 'function') throw new Error('Telegram 通道未启动');
    const sent = await telegramChannel.sendText(tgChatId, null, testText);
    const event = { type: 'im.message.receive_v1', sender_type: 'user', chat_id: 'tg:' + tgChatId, message_id: String(sent.messageId), content: testText };
    await enqueue('tg:' + tgChatId, () => processChat('tg:' + tgChatId, [event], 'telegram'));
    if (telegramChannel.stop) telegramChannel.stop();
    process.exit(0);
  })().catch(e => { console.error(e); try { if (telegramChannel?.stop) telegramChannel.stop(); } catch (_) {} process.exit(1); });
} else if (process.argv.includes('--test-message')) {
  const ti = process.argv.indexOf('--test-message');
  const realMessageId = process.argv[ti + 1] || '';
  const testText = process.argv[ti + 2] || '飞书真实消息链路测试';
  const testEvent = { type: 'im.message.receive_v1', sender_type: 'user', chat_id: NOTIFY_CHAT_ID, message_id: realMessageId, content: '<text>' + testText + '</text>' };
  processChat(NOTIFY_CHAT_ID, [testEvent]).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else if (process.argv.includes('--model-check')) {
  detectModelConfigChange();
  ensureCurrentModelReady('CLI', { force: true }).then(p => {
    console.log(JSON.stringify({ ok: p.ok, model: p.model, provider: p.provider, providerName: p.providerName, baseUrl: p.baseUrl, latencyMs: p.latencyMs, fingerprint: p.fingerprint, error: p.error }, null, 2));
    process.exit(p.ok ? 0 : 2);
  }).catch(e => { console.error(sanitizeDiagnostic(e.message)); process.exit(1); });
} else if (process.argv.includes('--health-check')) {
  runHealthCheck('CLI', false).then(h => { console.log(JSON.stringify(h, null, 2)); process.exit(h.ok ? 0 : 2); }).catch(e => { console.error(e); process.exit(1); });
} else if (process.argv.includes('--history-search')) {
  const hi = process.argv.indexOf('--history-search');
  const query = process.argv[hi + 1] || '';
  console.log(getTaskHistoryBlock(query));
  process.exit(0);
} else if (process.argv.includes('--history')) {
  console.log(JSON.stringify(loadTaskHistory(20), null, 2));
  process.exit(0);
} else if (process.argv.includes('--test-task')) {
  const idx = process.argv.indexOf('--test-task');
  const testText = process.argv[idx + 1] || '端到端测试：只读获取当前北京时间，不修改电脑。';
  const testEvent = {
    type: 'im.message.receive_v1', sender_type: 'user', chat_id: NOTIFY_CHAT_ID,
    message_id: 'om_test_' + Date.now(), content: '<text>' + testText + '</text>'
  };
  processChat(NOTIFY_CHAT_ID, [testEvent]).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else if (process.argv.includes('--selftest')) {
  (async () => {
    fs.mkdirSync(WORK, { recursive: true });
    fs.mkdirSync(DL_DIR, { recursive: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(TEMP_ROOT, { recursive: true });
    fs.mkdirSync(CODEX_CWD, { recursive: true });
    console.log('=== SELFTEST START ===');
    const sh0 = readSharedMemory();
    if (!fs.existsSync(SHARED_MEM_FILE)) fs.writeFileSync(SHARED_MEM_FILE, '', 'utf8');
    console.log('[1] shared memory file:', fs.existsSync(SHARED_MEM_FILE) ? 'OK' : 'FAIL');
    const marker = '__SELFTEST__' + Date.now();
    appendSharedMemory(marker);
    const sh1 = readSharedMemory();
    console.log('[2] ??????:', sh1.includes(marker) ? 'OK' : 'FAIL');
    try {
      const cleaned = sh1.split(/\r?\n/).filter(l => !l.includes(marker)).join('\n');
      fs.writeFileSync(SHARED_MEM_FILE, cleaned + '\n');
      console.log('[2] ???????');
    } catch (e) { console.log('[2] ????:', e.message); }
    try {
      const os = require('os');
      const tmp = path.join(os.tmpdir(), 'feishu-selftest-' + Date.now() + '.md');
      fs.appendFileSync(tmp, '## SELFTEST\nok\n');
      console.log('[3] ??????(????):', fs.existsSync(tmp) ? 'OK' : 'FAIL');
      fs.unlinkSync(tmp);
      console.log('[3] ???????');
    } catch (e) { console.log('[3] FAIL:', e.message); }
    const shared = readSharedMemory();
    const prompt = getTaskProtocolPrompt() + `${SAFETY_RULES}用户: 测试`;
    console.log('[4] protocol injected:', prompt.includes('Clarify before acting') && prompt.includes('Evidence gate') ? 'OK' : 'FAIL');
    console.log('[4] safety rules:', prompt.includes('没有实际工具证据') ? 'OK' : 'FAIL');
    console.log('[5] protocol file:', readTaskProtocol().length > 100 ? 'OK' : 'FAIL');
    console.log('[6] high-risk gate:', detectHighRisk('把文件发送给同事') ? 'OK' : 'FAIL');
    console.log('[7] low-risk cleanup:', detectHighRisk('删除临时截图') ? 'FAIL' : 'OK');
    try {
      fs.mkdirSync(OUT_DIR, { recursive: true });
      const testFile = path.join(OUT_DIR, '__retention_selftest__.txt');
      fs.writeFileSync(testFile, 'retention test');
      const data = loadDeliveredFiles();
      data[path.resolve(testFile)] = { deliveredAt: Date.now() - ARTIFACT_RETENTION_MS - 1000, name: path.basename(testFile) };
      fs.writeFileSync(DELIVERED_FILES_FILE, JSON.stringify(data, null, 2));
      cleanupDeliveredFiles();
      const pass = !fs.existsSync(testFile);
      const clean = loadDeliveredFiles();
      delete clean[path.resolve(testFile)];
      fs.writeFileSync(DELIVERED_FILES_FILE, JSON.stringify(clean, null, 2));
      console.log('[8] retention cleanup:', pass ? 'OK' : 'FAIL');
    } catch (e) { console.log('[8] retention cleanup: FAIL', e.message); }
    try {
      const tmpId = '__selftest_temp__';
      const tmpDir = path.join(TEMP_ROOT, tmpId);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'x.txt'), 'x');
      const removed = safeRemoveTaskTemp(tmpId);
      console.log('[9] temp cleanup:', removed && !fs.existsSync(tmpDir) ? 'OK' : 'FAIL');
    } catch (e) { console.log('[9] temp cleanup: FAIL', e.message); }
    try {
      const ev = collectToolEvidence([
        { type: 'response_item', payload: { type: 'function_call', call_id: 'x1', name: 'shell_command', arguments: '{}' } },
        { type: 'response_item', payload: { type: 'function_call_output', call_id: 'x1', output: 'Exit code: 0\nOK' } }
      ]);
      console.log('[10] tool evidence:', ev.successful === 1 && ev.total === 1 ? 'OK' : 'FAIL');
    } catch (e) { console.log('[10] tool evidence: FAIL', e.message); }
    try {
      const sample = gateReply('**已完成**', { actionIntent: true, guiIntent: true, closeIntent: false, requiresNewWindow: true, successfulTools: 1, totalTools: 1, failedTools: 0, newWindowCount: 0, screenshotOk: true, screenCount: 2, locked: false, imageSent: true, deliveredFiles: [], failedFiles: [], newWindows: [] });
      console.log('[11] user acceptance:', sample.includes('用户视角验收') && sample.includes('结果未完全核验') ? 'OK' : 'FAIL');
    } catch (e) { console.log('[11] user acceptance: FAIL', e.message); }
    try {
      const historyPrompt = getTaskHistoryBlock('上次那个文件');
      console.log('[12] task history context:', historyNeedsContext('上次那个文件') && historyPrompt.includes('任务历史索引') ? 'OK' : 'FAIL');
    } catch (e) { console.log('[12] task history context: FAIL', e.message); }
    try {
      const fakeHealth = { at: new Date().toISOString(), reason: 'selftest', state: 'healthy', ok: true, checks: { bridge: { ok: true, pid: process.pid }, consumer: { ok: true, failures: 0 }, lark: { ok: true }, codex: { ok: true, path: 'codex' }, proxy: { ok: true }, desktop: { ok: true, screenCount: 2 } } };
      console.log('[13] health card:', healthStateText(fakeHealth).includes('远程助手状态') ? 'OK' : 'FAIL');
    } catch (e) { console.log('[13] health card: FAIL', e.message); }
    try {
      const cfg = readCodexModelConfig();
      console.log('[14] dynamic model config:', cfg.ok && cfg.fingerprint.length === 20 && chooseTaskModel() === cfg.model ? 'OK' : 'FAIL');
    } catch (e) { console.log('[14] dynamic model config: FAIL', e.message); }
    try {
      appendTaskHistory({ at: new Date().toISOString(), taskId: 'selftest-history', chatId: 'selftest', channel: 'selftest', userText: '开源桥接历史检索测试', summary: 'history fixture', status: 'completed', links: [], artifacts: [] });
      const found = getTaskHistoryBlock('上次那个开源桥接历史检索测试');
      console.log('[15] history search:', found.includes('开源桥接历史检索测试') ? 'OK' : 'FAIL');
    } catch (e) { console.log('[15] history search: FAIL', e.message); }
    try {
      const viewOnly = gateReply('已附桌面截图', { actionIntent: false, guiIntent: true, closeIntent: false, requiresNewWindow: false, successfulTools: 0, totalTools: 0, failedTools: 0, newWindowCount: 0, screenshotOk: true, screenCount: 2, locked: false, imageSent: true, deliveredFiles: [], failedFiles: [], newWindows: [] });
      console.log('[16] view-only screenshot:', !viewOnly.includes('结果未完全核验') ? 'OK' : 'FAIL');
    } catch (e) { console.log('[16] view-only screenshot: FAIL', e.message); }
    try {
      const sentEvidence = { items: [{ failed: false, args: 'lark-cli im +messages-send --file test.docx' }] };
      console.log('[17] file dedupe:', wasFileSentByTool('C:/x/test.docx', sentEvidence) ? 'OK' : 'FAIL');
    } catch (e) { console.log('[17] file dedupe: FAIL', e.message); }
    try {
      const cmd = buildCodexExecCommand(null, '');
      console.log('[18] no hardcoded model:', !/--model/i.test(cmd) ? 'OK' : 'FAIL');
    } catch (e) { console.log('[18] no hardcoded model: FAIL', e.message); }
    try {
      const cfg = readCodexModelConfig();
      const card = healthStateText({ at: new Date().toISOString(), checks: { bridge: { ok: true, pid: process.pid }, consumer: { ok: true }, lark: { ok: true }, codex: { ok: true, path: 'codex' }, model: { ok: true, model: cfg.model, providerName: cfg.providerName, provider: cfg.provider, latencyMs: 1200 }, modelConfig: { model: cfg.model, providerName: cfg.providerName, ccProviderId: cfg.ccProviderId }, proxy: { ok: true, skipped: true }, desktop: { ok: true, screenCount: 2 }, telegram: { enabled: false } } });
      console.log('[19] API health card:', card.includes('API 实调') && card.includes(cfg.model) ? 'OK' : 'FAIL');
    } catch (e) { console.log('[19] API health card: FAIL', e.message); }
    try {
      const exe = resolveCodexExecutable();
      console.log('[20] codex executable:', exe && fs.existsSync(exe) ? 'OK' : 'SKIP (Codex CLI not installed)');
    } catch (e) { console.log('[20] codex executable: FAIL', e.message); }
    try {
      const exe = resolveCodexExecutable();
      const expected = exe || (process.platform === 'win32' ? 'codex.exe' : 'codex');
      const cmd = buildCodexExecCommand(null, '', exe);
      console.log('[21] resolved command:', cmd.includes(expected) && !/--model/i.test(cmd) ? 'OK' : 'FAIL');
    } catch (e) { console.log('[21] resolved command: FAIL', e.message); }
    try {
      const sample = 'Bearer ' + 'test-token-value apiKey=secret-value sk-' + '1234567890abcdef';
      const redacted = redactSensitiveText(sample);
      console.log('[22] credential redaction:', !/test-token-value|secret-value|1234567890abcdef/.test(redacted) ? 'OK' : 'FAIL');
    } catch (e) { console.log('[22] credential redaction: FAIL', e.message); }
    try {
      const testData = path.resolve(CONFIG.storage.dataDir);
      const fixtureRoot = path.resolve(APP_ROOT, 'tests', '.selftest-data') + path.sep;
      if ((testData + path.sep).startsWith(fixtureRoot)) fs.rmSync(testData, { recursive: true, force: true });
    } catch (_) {}
    console.log('=== SELFTEST DONE ===');
    process.exit(0);
  })();
} else {
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(DL_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
  fs.mkdirSync(CODEX_CWD, { recursive: true });
  try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch (_) {}
  process.on('exit', () => { try { if (String(fs.readFileSync(PID_FILE, 'utf8')).trim() === String(process.pid)) fs.unlinkSync(PID_FILE); } catch (_) {} });
  cleanupStaleTemp();
  syncAgentRules();
  cleanupDeliveredFiles();
  startModelConfigWatcher();
  setInterval(() => { cleanupStaleTemp(); cleanupDeliveredFiles(); syncAgentRules(); }, 15 * 60 * 1000).unref();
  log('=== feishu-telegram-codex-bridge ===');
  startConsumer('启动');
  startTelegramAdapter().catch(e => log('Telegram 适配器异常: ' + e.message));
  setTimeout(() => {
    runHealthCheck('启动', true).then(health => {
      notifyTelegramStartupStatus(health && health.checks && health.checks.model).catch(e => log('启动 Telegram API 状态通知异常: ' + sanitizeDiagnostic(e && e.message || e)));
    }).catch(e => log('启动健康检查失败: ' + e.message));
  }, 20000).unref();
  setInterval(() => { runHealthCheck('周期', true).catch(e => log('周期健康检查失败: ' + e.message)); }, HEALTH_CHECK_MS).unref();
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}
