#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', 'outputs', 'downloads', 'temp', '.selftest-data']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.7z', '.db', '.sqlite', '.dmp']);
const RULES = [
  ['OpenAI-style secret', /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ['Bearer credential', /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi],
  ['Telegram bot token', /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['Authorization header', /Authorization\s*:\s*(?!\*\*\*|\*)[^\s\r\n]+/gi],
  ['JSON secret value', /"(?:api[_-]?key|openai_api_key|botToken|secret)"\s*:\s*"(?!(?:YOUR_|REPLACE_|\*{3}|$))[^"]+"/gi]
];

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

const findings = [];
for (const file of walk(ROOT)) {
  if (SKIP_EXT.has(path.extname(file).toLowerCase())) continue;
  let text;
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) continue;
    text = fs.readFileSync(file, 'utf8');
  } catch { continue; }
  for (const [name, pattern] of RULES) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push({ name, file: path.relative(ROOT, file) });
  }
}

const gitignore = fs.existsSync(path.join(ROOT, '.gitignore')) ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8') : '';
for (const privateFile of ['config.json', '.env']) {
  if (fs.existsSync(path.join(ROOT, privateFile)) && !gitignore.split(/\r?\n/).includes(privateFile)) {
    findings.push({ name: 'Private runtime file is not ignored', file: privateFile });
  }
}

if (findings.length) {
  console.error('Security scan failed:');
  for (const finding of findings) console.error(`- ${finding.name}: ${finding.file} (value intentionally hidden)`);
  process.exit(1);
}
console.log(`Security scan passed: ${walk(ROOT).length} files inspected, no credential patterns found.`);
