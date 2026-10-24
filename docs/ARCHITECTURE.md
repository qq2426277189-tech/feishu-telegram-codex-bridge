# Architecture

[简体中文](ARCHITECTURE.zh-CN.md) | **English**


## Goals

The bridge is designed around four invariants:

1. A remote task must produce a user-observable result.
2. The model's claim is not evidence; tool output and delivery receipts are evidence.
3. Provider/model changes must be detected and live-tested before the next task.
4. Secrets must not enter logs, history, reports, prompts stored on disk, or Git.

## Components

### `bridge.js`

The unified execution kernel. It owns:

- Feishu event normalization and delivery;
- Telegram message normalization and delivery;
- per-chat queues;
- high-risk confirmation state;
- Codex CLI invocation;
- tool evidence extraction;
- screenshot capture and file delivery;
- health checks and retries;
- task history, audit, shared memory, and cleanup;
- CC Switch/Codex configuration fingerprinting.

### `src/config.js`

Loads `config.json`, supports environment-variable overrides, expands relative and home-relative paths, and validates required channel settings. Runtime data is written under `storage.dataDir`, not the repository root.

### `src/telegram-channel.mjs`

Small Telegram adapter. It owns only:

- long polling;
- allowlist checks;
- text/file/photo sending;
- `/status` and `/reset`;
- proxy and backoff handling.

It calls back into `bridge.js` for task execution.

### `scripts/capture-screen.ps1`

Windows screenshot adapter. Captures the full virtual desktop, computes a SHA-256 hash, and reports monitor and window metadata.

### `docs/REMOTE_TASK_PROTOCOL.md`

The safety and verification rules injected into each remote task. It can optionally be synchronized into configured `AGENTS.md` files.

## Task flow

```text
inbound message
  -> normalize chat + attachments
  -> per-chat queue
  -> high-risk gate
  -> ensure current model is live
  -> run codex exec
  -> parse JSONL tool events
  -> build machine verification
  -> capture full desktop
  -> deliver text + screenshot + files
  -> redact and persist history
  -> clean task temp files
```

## Evidence gate

The bridge parses Codex JSONL events into tool calls and outputs. It tracks:

- total, successful, and failed calls;
- command exit status and error signatures;
- whether a visible window was added;
- screenshot success and lock state;
- text and image delivery success;
- successfully and unsuccessfully delivered files.

A completion claim is downgraded when the user-visible checks fail. This prevents a process, HTTP 200, or PID from being treated as proof of a user-facing result.

## CC Switch and model changes

The bridge computes a non-secret fingerprint from:

- current Codex `config.toml` content hash;
- current auth file content hash;
- current provider and model;
- provider base URL;
- CC Switch's current provider ID.

The watcher compares this fingerprint every `limits.modelWatchMs`.

```text
fingerprint changed
  -> persist config snapshot
  -> clear chat sessions tied to the old model
  -> wait modelSwitchSettleMs
  -> run a minimal ephemeral Codex call
  -> success: allow tasks and refresh health
  -> failure: block tasks, mark health degraded, notify channels
```

The minimal probe uses:

```text
codex exec --ephemeral --json --sandbox read-only
```

The bridge never passes a hard-coded `--model` flag. The provider may be an official API, a self-hosted compatible gateway, a relay, or a local proxy; the bridge follows the active Codex/CC Switch configuration rather than maintaining a provider allowlist.

## Health model

Health is a combination of independent checks:

- bridge process;
- Feishu event consumer;
- Lark authentication/status;
- Codex executable discovery;
- live model probe;
- local proxy or configured endpoint;
- desktop screenshot;
- Telegram polling.

The live model probe is authoritative for API connectivity. A local proxy port check is only a supporting signal.

## Delivery and cleanup

- Temporary task files live under a task-scoped temp directory.
- Screenshots are uploaded first; local deletion happens only after upload success.
- Official files live under the configured outputs directory.
- Delivered artifacts are retained for the configured retention period.
- History does not store screenshot bodies.

## Credential handling

`redactSensitiveText()` and `redactSensitiveValue()` are applied before writing:

- logs;
- task history;
- audit records;
- shared memory;
- report summaries;
- final user-facing text.

They recognize common API-key, bearer, authorization, GitHub-token, Telegram-token, private-key, and query-parameter patterns. Redaction is defense in depth, not permission to place secrets in prompts.

## Failure semantics

The bridge prefers explicit failure over a false success:

- API probe failure: task is not started;
- screenshot failure: result is “not fully verified”;
- image delivery failure: result is downgraded;
- file delivery failure: result is partial;
- missing visible window: GUI task is unverified;
- Telegram polling failure: retry with exponential backoff and report degraded health after the check interval.
