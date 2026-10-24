# Contributing

## Before opening a PR

1. Do not include real credentials, personal IDs, chat logs, screenshots, or downloaded files.
2. Run `npm run selftest`.
3. Run `npm run security:scan`.
4. Keep platform-specific behavior behind configuration or explicit platform checks.
5. Update `README.md` and `config.example.json` when adding a setting.
6. Add a test or extend the self-test when changing a safety gate.

## Commit style

Use short, descriptive commits:

```text
feat: add configurable Telegram proxy
fix: redact authorization headers from history
docs: explain CC Switch live probe
```

## Pull request checklist

- [ ] No secrets or private runtime files are included.
- [ ] Self-test passes.
- [ ] Security scan passes.
- [ ] Configuration remains backward compatible or the change is documented.
- [ ] Failure states remain explicit; no new false-success path was introduced.
- [ ] User-visible evidence is still required for GUI/file tasks.

## Development setup

```powershell
npm install
Copy-Item config.example.json config.json
npm run selftest
npm run security:scan
```

For a live model check, configure Codex/CC Switch in a local runtime config:

```powershell
npm run model-check
```

Do not commit the resulting `config.json` or `data/` directory.
