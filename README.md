# Feishu + Telegram + Codex Bridge

[**English**](README.md) | [简体中文](README.zh-CN.md)

![Feishu + Telegram + Codex Bridge](assets/banner.svg)

<p>
  <img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="Node.js 22.19+" src="https://img.shields.io/badge/node-%3E%3D22.19-blue">
  <img alt="Platform: Windows 10/11" src="https://img.shields.io/badge/platform-Windows%2010%2F11-lightgrey">
</p>

**Control Codex from Feishu or Telegram, without losing sight of what actually happened on the machine.**

This project bridges chat apps and a local Codex installation. You send a task from your phone; the bridge runs it on your PC, verifies the result, captures the desktop, and sends the outcome back with enough evidence for you to check it yourself.

> **Security warning:** this is a full-access assistant for a trusted personal machine. It is not a hosted service, a remote desktop, or a sandbox. Do not expose it to untrusted users or run it on a shared host.

## What it does

```text
Feishu / Telegram
        ↓
Unified task kernel
        ↓
Codex CLI on your local machine
        ↓
Tool evidence + visible results + full-desktop screenshot
        ↓
Chat reply with files, links, and acceptance steps
```

The bridge is built around one rule: **"the model says it worked" is not evidence that it worked.**

It inspects tool calls, file creation, delivery receipts, visible windows, and screenshot capture before allowing a task to be described as complete. If the evidence is incomplete, the result is downgraded instead of being reported as a clean success.

## Why this exists

Most remote AI assistants stop at the interesting part:

- the job runs in the background, but you cannot see the window, file, or link;
- switching API providers leaves the assistant stuck on an old model or session;
- the model claims success even though nothing ran;
- screenshots and preview files pile up locally;
- secrets leak into logs, history, or the chat transcript;
- destructive actions run without a second confirmation.

This bridge treats those as part of the task model, not as edge cases.

## Highlights

- **Two chat front ends, one execution kernel.** Feishu and Telegram share the same queue, evidence gate, screenshot pipeline, delivery logic, task history, and cleanup.
- **Provider-agnostic.** Use the official API, a self-hosted OpenAI-compatible gateway, a third-party relay, or a local proxy.
- **Live provider switching.** No hard-coded `--model`. The bridge follows the current Codex configuration and CC Switch provider selection.
- **Real switch verification.** When the provider configuration changes, old model sessions are invalidated and a minimal live model call is made before new tasks are accepted.
- **User-facing acceptance.** Every task explains where to look, what to open, and what remains unverified.
- **Evidence-gated completion.** Tool activity, files, visible windows, screenshots, and delivery receipts are checked independently of the model's wording.
- **Full virtual-desktop capture.** Multi-monitor and DPI-aware screenshots are delivered as files, then cleaned up after confirmed upload.
- **Credential redaction.** Logs, task history, audits, shared memory, reports, and final replies are passed through a credential-redaction layer.
- **High-risk confirmation.** Deletion, payments, outbound messages, publishing, authorization changes, and installers require an explicit confirmation.
- **Health monitoring and retries.** Feishu consumers, Telegram polling, Codex, the live API probe, and desktop capture are checked separately.

## What a run looks like

A user sends:

```text
Take a look at the current desktop state. Read-only, and send me the result with a screenshot.
```

The bridge then:

1. verifies that the active model really responds;
2. asks Codex to inspect the desktop and window state;
3. parses the actual tool calls and outputs;
4. captures the full virtual desktop;
5. sends the report and screenshot to Feishu or Telegram;
6. tells the user where to look and how to verify the result;
7. removes task-scoped temporary files;
8. writes a redacted task record.

If the current API is broken, the task is blocked. The bridge does not fall back to the previous provider or pretend the task completed.

## Architecture

```text
┌──────────────┐       ┌─────────────────────────────┐
│ Feishu/Lark  │──────▶│                             │
└──────────────┘       │   bridge.js                 │
                       │   unified execution kernel  │
┌──────────────┐       │                             │
│  Telegram    │──────▶│   messages · queues         │
└──────────────┘       │   confirmations · evidence  │
                       │   delivery · cleanup        │
                       └──────────────┬──────────────┘
                                      │
                       ┌──────────────▼──────────────┐
                       │ Codex CLI                   │
                       │ active provider + model     │
                       │ config.toml / auth / CC Switch│
                       └──────────────┬──────────────┘
                                      │
                 ┌────────────────────┼────────────────────┐
                 ▼                    ▼                    ▼
          local apps/browser      files/folders      full desktop capture
```

For a deeper design review, see [Architecture](docs/ARCHITECTURE.md).

## Requirements

### Core

- Node.js **22.19+**
- Codex CLI, already signed in or configured with an API provider
- Windows 10/11 for the full desktop, screenshot, and Office automation feature set
- PowerShell (`powershell.exe` or `pwsh`)

### Feishu

- `lark-cli` with a configured Feishu application identity
- the app ID and target chat ID
- a working `lark-cli event` consumer

### Telegram

- a bot created through BotFather
- its bot token
- an allowlist of numeric Telegram user IDs
- a proxy if your network requires one

### CC Switch (optional)

- CC Switch configured to take over or hot-switch Codex providers
- the path to its `settings.json`
- `codex.home` pointing at the Codex configuration and authentication directory

CC Switch is optional. Without it, the bridge still follows the active `codex.home/config.toml` provider and model.

## Quick start

```powershell
git clone https://github.com/your-name/feishu-telegram-codex-bridge.git
cd feishu-telegram-codex-bridge
npm install
Copy-Item config.example.json config.json
# edit config.json with your own Feishu and Telegram settings
npm run selftest
npm run security:scan
npm run model-check
npm start
```

`config.json` is ignored by Git. Never commit real tokens, cookies, authorization headers, or private chat content.

To start automatically at sign-in:

```powershell
.\scripts\install-autostart.ps1
```

The script creates a per-user Startup shortcut. It does not install a service or require administrator access.

## Configuration

The example configuration is in [config.example.json](config.example.json).

### Feishu

```json
{
  "feishu": {
    "enabled": true,
    "larkCliPath": "C:\\path\\to\\lark-cli.exe",
    "appId": "cli_your_feishu_app_id",
    "chatId": "oc_your_feishu_chat_id"
  }
}
```

Set `feishu.enabled` to `false` to run only the Telegram channel. Feishu credentials are managed by `lark-cli`; this repository does not store them.

### Telegram

```json
{
  "telegram": {
    "enabled": true,
    "botToken": "YOUR_TELEGRAM_BOT_TOKEN",
    "allowedUserIds": [123456789],
    "proxyUrl": "http://127.0.0.1:7890"
  }
}
```

An empty allowlist rejects every Telegram user. Polling failures are retried with exponential backoff and reported in the health card.

### Codex

```json
{
  "codex": {
    "executable": "",
    "home": "~/.codex",
    "cwd": "./data/workspace",
    "timeoutMs": 1200000,
    "probeTimeoutMs": 90000
  }
}
```

Leave `executable` empty to auto-detect Codex. The bridge does not hard-code a model.

## Official, self-hosted, and relay APIs

The bridge does not care which provider you use, as long as the active Codex configuration can reach a real model. Supported setups include:

- an official OpenAI/ChatGPT/Codex login;
- a self-hosted or internal OpenAI-compatible gateway;
- a third-party relay service;
- a local provider or proxy managed by CC Switch.

To add a relay, configure its Base URL, model slug, and credential in CC Switch or Codex, then verify it:

```powershell
npm run model-check
```

When you switch between your own API and a relay:

1. CC Switch updates the Codex configuration or provider ID;
2. the bridge detects the fingerprint change;
3. sessions tied to the old model are invalidated;
4. the new provider gets a real minimal probe;
5. only a successful probe allows the next task;
6. the result is reported to Feishu and Telegram.

No code edit or bridge restart is required. See [API providers](docs/API_PROVIDERS.md) for the full setup and security notes.

> A relay can see the prompts and responses sent through it. Use a provider you trust, and keep its key in CC Switch, Codex auth storage, or a local environment variable — never in the repository or a task message.

## Commands

```powershell
npm start                 # start the bridge
npm run selftest          # run the local self-test suite
npm run model-check       # make a minimal live call to the active model
npm run security:scan     # scan the repository for common credential patterns
npm run sync-rules        # sync the remote task protocol to configured AGENTS.md files
```

## Data and cleanup

Runtime data is written under `data/` by default:

```text
data/
  workspace/
  downloads/
  outputs/
  temp/
  state.json
  health.json
  task-history.jsonl
  audit.jsonl
  shared-memory.md
  bridge.log
```

`data/` is ignored by Git. Official artifacts are retained for the configured period, while task-level screenshots and temporary files are removed after delivery is confirmed.

## Security model

- Telegram access is restricted to the configured allowlist.
- High-risk actions require explicit confirmation from the user.
- API keys, bot tokens, authorization headers, cookies, and private keys are redacted before being written to local records or delivered in final text.
- Screenshots, temporary files, and official artifacts are handled separately.
- `config.json`, `.env`, `data/`, logs, history, screenshots, QR codes, and caches are ignored.
- Run `npm run security:scan` before publishing changes. Public GitHub repositories should also enable secret scanning.

Read the full [security policy](SECURITY.md).

## Known limitations

- GUI tasks cannot complete while the PC is off, asleep, locked, or disconnected; the bridge reports that the result cannot be verified.
- Feishu support depends on the external `lark-cli`; commands and permissions may vary by version.
- CC Switch settings are version-dependent; the path and fingerprinting can be disabled or changed in config.
- Screenshot and desktop automation are Windows-first. Other platforms need a different capture adapter.
- This is not a remote desktop or a security sandbox. Codex runs with the current user's permissions. Use a dedicated user profile or VM for stronger isolation.
- Do not expose the bridge to untrusted users or public groups.

## Troubleshooting

### The live model check fails

Run:

```powershell
npm run model-check
```

Inspect the provider, model, endpoint, and sanitized error. Restarting the bridge will not fix a bad provider configuration.

### Telegram receives no messages

Check the bot token, allowlist, proxy, and polling status. Send `status` for the health card. Polling failures are retried automatically.

### Feishu does not reply

Check `lark-cli`, the application identity, and `lark-cli event status`.

### Screenshots fail

Make sure Windows is unlocked, an interactive desktop exists, and the bridge and screenshot helper run in the same user session.

## Contributing and license

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes. Never upload real configuration, logs, screenshots, or credentials.

MIT licensed. See [LICENSE](LICENSE).
