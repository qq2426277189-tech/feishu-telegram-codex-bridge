# Official, Self-Hosted, and Relay APIs

[简体中文](API_PROVIDERS.zh-CN.md) | **English**


The bridge does not contain a model-provider implementation. It invokes the Codex CLI using the active Codex configuration. That means the same bridge can work with:

- an official OpenAI/ChatGPT/Codex login;
- a self-hosted OpenAI-compatible gateway;
- a third-party relay service;
- a local proxy managed by CC Switch or another provider manager.

The bridge follows the provider and model selected in Codex/CC Switch; it does not force a built-in model.

## Requirements for any provider

Before the bridge can use an API, the current Codex configuration must:

1. contain a valid provider and model;
2. have working authentication/API credentials;
3. support the API protocol expected by the installed Codex CLI;
4. expose the exact model name configured for the thread;
5. be reachable from the computer running the bridge.

For relay services, copy the Base URL and model names exactly as provided by the service. The relay must support the protocol required by your Codex version, not merely expose a generic chat UI.

## Recommended setup

Use CC Switch to create a separate provider entry for each API:

```text
Official API
Own API / self-hosted gateway
Relay A
Relay B
```

For each entry, configure:

- provider name;
- Base URL;
- model slug;
- API credential;
- the wire/API compatibility option required by Codex or the relay.

Prefer the CC Switch UI or the provider's documented Codex configuration. Do not guess a `wire_api` value: relays may implement Responses API, Chat Completions, or only a subset of either.

A typical concept looks like this, but the exact fields and values depend on the Codex version and the relay:

```toml
model_provider = "relay"
model = "your-relay-model"

[model_providers.relay]
name = "My Relay"
base_url = "https://relay.example.com/v1"
wire_api = "responses"
```

Keep the credential in CC Switch, Codex authentication storage, or an environment variable. Do not put it in this repository.

## Verify a provider

After configuring it, run from the repository:

```powershell
npm run model-check
```

The command makes a minimal real Codex call using the current configuration and prints:

- provider name;
- model;
- sanitized Base URL;
- latency;
- a sanitized error if the probe fails.

A port check or HTTP 200 is not enough. The model must return a valid response.

## Switching between your API and a relay

1. Select the other provider in CC Switch.
2. CC Switch updates Codex configuration, authentication, or its current provider ID.
3. The bridge sees a changed configuration fingerprint.
4. It invalidates sessions tied to the previous model.
5. It waits for the configuration to settle.
6. It performs a new live model call.
7. Only after success does it accept the next task.
8. It reports the result to Feishu and Telegram when those channels are enabled.

You do not need to edit `bridge.js` or restart the bridge for a normal provider switch.

If the new relay is misconfigured, tasks are blocked and health is degraded. The bridge does not reuse the previous provider's successful probe as evidence for the new provider.

## Security and privacy

A relay can see prompts, files that the model sends as context, and model responses. Use only a provider you trust for the data you plan to process.

- Keep keys out of task text and Git.
- Prefer a per-provider key so it can be revoked independently.
- Review a relay's logging, retention, and privacy terms.
- The bridge redacts common credential patterns in its local records, but redaction is not a substitute for not sending secrets to a model.
- Treat vendor and relay settings as external security boundaries.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 401/403 | Wrong or expired provider credential |
| 404 model | Model slug does not exist at the relay |
| Unsupported endpoint | Relay does not implement the required Codex protocol |
| Timeout | Proxy, DNS, firewall, or relay outage |
| Session failure after switching | Old session was not invalidated; the bridge clears it automatically |
| `model-check` succeeds but a task fails | The task itself failed; check tool evidence and the task report |

After changing a provider, always use `npm run model-check` and then send a simple read-only task before relying on it for important work.
