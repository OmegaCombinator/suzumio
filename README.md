# Suzumio

Suzumio is a Docker-first, non-preemptive multi-agent coordination runtime.

Documentation: https://omegacombinator.github.io/suzumio/

Core principles:

- Agents run in isolated Docker turns managed by the backend.
- The scheduler never interrupts a running agent.
- Agents are only woken by inbound mailbox messages or explicit user/system control.
- Suzumio owns project state, messages, artifacts, tool audit logs, and observability.
- The container runner is only a single-agent turn executor.

This repository is an early build. The first implementation includes:

- YAML config loading with whole-field `@import(path)` and top-level `extends`.
- SQLite project storage using Node's built-in SQLite module.
- A Docker-first chat backend and container runner.
- Built-in tools: `messages.send`, `artifacts.publish`, `artifacts.list`, `artifacts.read`, `completion.submit`, `web.fetch`.
- A non-preemptive mailbox scheduler.
- CLI, HTTP API, SSE stream, and a minimal flat WebUI.

The documentation site is committed under `docs/` and deployed to GitHub Pages by `.github/workflows/pages.yml`.

## Quick Sketch

```bash
npm install
npm run build
docker build -t suzumio-runner:dev .

export SUZUMIO_ROOT=/tmp/suzumio-root
export SUZUMIO_GATEWAY_API_KEY=...
suzumio init examples/demo.yaml
suzumio serve --host 127.0.0.1 --port 39400
```

Open `http://127.0.0.1:39400` for the WebUI.

## Configuration

Suzumio config is YAML. A scalar field whose whole value is `@import(path)` is replaced with the imported file. YAML, JSON, and text files are supported. Top-level `extends` performs object deep-merge after imports are resolved.

```yaml
extends:
  - @import(profiles/base.yaml)

task: @import(tasks/task.md)
agents:
  pm: @import(agents/pm.yaml)
```

Arrays are replaced, not concatenated. HTTP imports are disabled for reproducibility.

## Scheduler Semantics

The first scheduler is `nonpreemptive-mailbox`:

- Running agents are never interrupted or prompted again.
- Inbound messages are queued until the current turn finishes.
- Idle agents with unread inbound messages are started for exactly one turn.
- Idle agents without unread inbound messages remain quiet.
- There are no heartbeat nudges or automatic "still waiting" prompts.

## Secrets

Do not put API keys in committed config. Use `apiKeyEnv` and pass the key through the environment when starting `suzumio serve`.

```yaml
backend:
  runner:
    mode: ai
    model: main
    models:
      default: main
      providers:
        gateway:
          type: openai-compatible
          baseURL: https://example.invalid/v1
          apiKeyEnv: GATEWAY_API_KEY
      presets:
        main:
          provider: gateway
          displayName: Main agent model
          model: gpt-5.5
```
