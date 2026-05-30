# Suzumio

Suzumio is a YAML-based multi-agent system that runs non-preemptive agent activations in Docker.

Documentation: https://suzumio.aixmath.org/

Core principles:

- Projects are declared in YAML: task, agents, prompts, tools, scheduler, Docker backend, and model presets.
- Agents run in isolated Docker activations managed by the backend.
- The scheduler never interrupts a running agent.
- Agents are only woken by pending signals or explicit user/system control.
- Suzumio owns project state, messages, signals, shared artifact directories, tool audit logs, and observability.
- The Docker runner executes one agent activation and presents runner-side model-facing tools.
- Stateful tools call Suzumio support APIs for messages, signals, permissions, and final submission.

This repository is an early build. The first implementation includes:

- YAML config loading with whole-field `@import(path)`, top-level `extends`, and copyable multi-agent patterns.
- SQLite project storage using Node's built-in SQLite module.
- A Docker-first chat backend and container runner.
- Configured toolpacks for `core`, `shell`, and `web` tools.
- Runner-local `shell.exec` and `web.fetch`, plus support-backed message, coordination, and completion tools.
- A signal-driven non-preemptive scheduler.
- CLI, HTTP API, SSE stream, and a Preact-based WebUI control room.

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

The default scheduler is `nonpreemptive-signals`. `nonpreemptive-mailbox` remains as a compatibility alias:

- Running agents are never interrupted or prompted again.
- Messages and coordination events become pending signals.
- Idle agents with pending signals are started for exactly one activation.
- Idle agents without pending signals remain quiet.
- Activations with no useful effect receive one no-effect nudge unless they were already nudge-driven.
- Use `coordination.wait_for_signal` when an agent intentionally has to wait for future signals.

Each activation also gets shared artifact directories under `/artifacts/<agent-id>`. The current agent's directory is writable and other agents' directories are read-only, so agents can use ordinary shell commands to write scripts, logs, notes, and experiment outputs.

## Secrets

Do not put API keys in committed config. Use `apiKeyEnv` and pass the key through the environment when starting `suzumio serve`.

```yaml
backend:
  runner:
    mode: ai
    model: worker-with-fallback
    models:
      providers:
        gateway:
          type: openai-compatible
          baseURL: https://example.invalid/v1
          apiKeyEnv: SUZUMIO_GATEWAY_API_KEY
      presets:
        worker-main:
          provider: gateway
          model: gpt-5.5
        pm-main:
          provider: gateway
          model: gpt-5.5
        worker-with-fallback:
          model-list:
            - worker-main
            - pm-main

tools:
  toolpacks:
    - core
    - shell
    - web

agents:
  worker:
    count: 2
    names: [Akari, Ren]
    model: worker-with-fallback
```
