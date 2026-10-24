# Security Policy

## Supported deployment

This project is intended for a personal or trusted machine. It can execute commands and GUI actions with the permissions of the account running the bridge. Treat that account as a security boundary.

Recommended deployment:

- a dedicated Windows user profile or VM;
- a private working directory;
- a Telegram allowlist with one trusted user;
- a Feishu app limited to the required bot/chat permissions;
- no untrusted users or public groups.

## Secrets

Never commit or paste into a task:

- API keys;
- provider access tokens;
- Telegram bot tokens;
- Feishu app secrets;
- OAuth refresh tokens;
- cookies;
- Authorization headers;
- private keys.

Runtime secrets belong in `config.json`, environment variables, or the credential store used by `lark-cli`/Codex. `config.json`, `.env`, logs, history, screenshots, outputs, downloads, and caches are ignored by Git.

The bridge applies credential redaction before writing logs/history/audit/shared memory/reports and before final delivery. This is a safety net, not a substitute for keeping secrets out of prompts.

## Network exposure

The bridge is an outbound client. It does not expose a public HTTP server. Do not add a public webhook or bind an unauthenticated control service without an authentication and authorization review.

## High-risk actions

The runtime protocol requires explicit user confirmation before:

- deletion or destructive system changes;
- payments and purchases;
- sending content to third parties;
- publishing or submitting forms;
- account authorization or credential changes;
- installing software.

A message forwarded by another person is not authorization.

## Repository checks

Run:

```powershell
npm run security:scan
npm run selftest
```

The security scanner fails on common credential patterns and on unignored private runtime files. It intentionally hides the matching value in its output.

## Reporting a vulnerability

Please report security issues privately through GitHub Security Advisories for this repository. Include:

- affected version/commit;
- impact;
- reproduction steps;
- whether credentials or user data may be exposed.

Do not open a public issue containing live credentials or private screenshots.

## Known limitations

- A local desktop bridge cannot protect a machine from malware already running as the same user.
- Screenshot redaction is not automatic; avoid displaying secrets on screen during a remote task.
- Codex and CC Switch are external components with their own security models.
- Agent output can still be wrong; the evidence gate reduces but does not eliminate risk.
