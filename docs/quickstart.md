---
title: "Initialize And Run Suzumio Projects"
eyebrow: "Run Projects"
heroTitle: "Render YAML, initialize state, start agents"
lead: "This chapter covers local setup, project initialization, terminal control, WebUI usage, runtime inspection, artifacts, secrets, proxies, and basic cleanup."
---

## Prerequisites

| Requirement | Used by | Check |
|-------------|---------|-------|
| Node.js 24+ | CLI, server, runner build, built-in SQLite module. | `node --version` |
| npm | Install TypeScript and runtime dependencies. | `npm --version` |
| Docker | Every agent activation runs in a container. | `docker ps` |
| Model gateway credentials | AI runner provider endpoint and API key. | Provider-specific. |

## Build Suzumio

```bash
git clone git@github.com:OmegaCombinator/suzumio.git
cd suzumio
npm install
npm run build
docker build -t suzumio-runner:dev .
```

The default runner image includes Node.js, `python3`, `curl`, and `git`.

## Runtime Root

```bash
export SUZUMIO_ROOT=/tmp/suzumio-root
```

The runtime root contains project databases, activation inputs, agent workspaces, artifacts, and logs.

```text
$SUZUMIO_ROOT/project-name/
  suzumio.sqlite      durable project database
  source.yaml         original project config
  resolved.yaml       fully resolved config
  agents/             per-agent workspaces
  artifacts/          per-agent shared files
  activations/        activation input directories
  logs/               reserved runtime logs
```

## Secrets And Provider Environment

Use environment variables for provider keys and local, untracked config for private gateway URLs.

```bash
export SUZUMIO_GATEWAY_API_KEY=...
export SUZUMIO_GATEWAY_BASE_URL=...
```

The process that launches an activation must have the configured provider environment variables. This can be the long-running server or a CLI command that directly triggers a scheduler tick.

Run these with the same provider/proxy environment:

```bash
suzumio serve --host 0.0.0.0 --port 39400
suzumio start project-name
suzumio send project-name pm P1 "Start."
suzumio tick
```

## Proxy Environment

Suzumio passes standard proxy variables into runner containers when they exist: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, and lowercase variants.

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

Bridge-network containers cannot reach host loopback directly. With `rewriteLocalhost: true`, Suzumio rewrites loopback proxy hosts to `host.docker.internal` for bridge-network containers.

```yaml
backend:
  docker:
    proxy:
      inheritEnv: true
      rewriteLocalhost: true
      https: ${HTTPS_PROXY}
      http: ${HTTP_PROXY}
```

Linux host networking keeps `127.0.0.1` proxy URLs unchanged and uses a host-local controller URL.

```yaml
backend:
  controllerUrl: http://127.0.0.1:39400
  docker:
    network: host
```

## Example Project YAML

Save this as `/tmp/suzumio-tutorial.yaml`.

```yaml
name: yaml-tutorial
task: |
  Produce a short note about one small Ramsey-number example.
  Have the worker run a tiny Python check and save the script/output
  under /artifacts/researcher. Have the PM summarize the result.

backend:
  kind: docker-chat
  image: suzumio-runner:dev
  controllerUrl: http://host.docker.internal:39400
  runner:
    mode: ai
    model: main
    models:
      providers:
        gateway:
          type: openai-compatible
          baseURLEnv: SUZUMIO_GATEWAY_BASE_URL
          apiKeyEnv: SUZUMIO_GATEWAY_API_KEY
          timeoutMs: 300000
      presets:
        main:
          provider: gateway
          model: gpt-5.5
          maxOutputTokens: 8000
          temperature: 0.2
          toolChoice: auto

tools:
  toolpacks:
    - core
    - shell

agents:
  pm:
    role: project-manager
    displayName: Yuki
    prompt: |
      Coordinate the task. Ask researcher for one small executable check.
      Treat your request as outstanding until researcher replies.
      If you are waiting, call coordination.wait_for_signal.
      Submit only after you have incorporated the worker result.
    model: main
    tools:
      - messages.send
      - coordination.wait_for_signal
      - completion.submit

  researcher:
    role: researcher
    displayName: Akari
    prompt: |
      Run a small Python experiment when useful. Save durable files under
      /artifacts/researcher. Send pm a concise report with the path.
      After reporting, if waiting for follow-up, call coordination.wait_for_signal
      with notifyPm:false.
    model: main
    tools:
      - messages.send
      - coordination.wait_for_signal
      - shell.exec
```

## Render And Initialize

```bash
suzumio config render /tmp/suzumio-tutorial.yaml
suzumio init /tmp/suzumio-tutorial.yaml
suzumio status yaml-tutorial
```

`config render` shows imports, environment substitutions, defaults, merge results, model settings, and the exact YAML stored by `init`.

## Start The Server

```bash
suzumio serve --host 0.0.0.0 --port 39400
```

The server exposes HTTP API routes, controller support routes used by runner containers, Server-Sent Events, and the packaged WebUI.

Use `127.0.0.1` for local-only access. Use `0.0.0.0` when Docker bridge containers need to reach host support routes through `host.docker.internal`.

For a long-running server, use systemd, a container supervisor, or a supervised shell session. Bind only to trusted interfaces until user-facing API authentication is in place.

## Terminal Control

Open another terminal with the same `SUZUMIO_ROOT` and provider/proxy env.

```bash
export SUZUMIO_ROOT=/tmp/suzumio-root
export SUZUMIO_GATEWAY_API_KEY=...

suzumio start yaml-tutorial
suzumio send yaml-tutorial pm P1 "Run the small Ramsey example and submit a short note."
```

Core control commands:

| Command | Effect |
|---------|--------|
| `suzumio status project` | Show project status and agent states. |
| `suzumio start project` | Mark project running and run a scheduler tick. |
| `suzumio stop project` | Stop scheduling for the project. |
| `suzumio send project agent P1 "..."` | Send a direct message and run a scheduler tick. |
| `suzumio tick` | Run scheduler ticks for projects under the root. |
| `suzumio approve project` | Mark a submitted project completed. |
| `suzumio messages project --limit 20` | Show recent messages. |
| `suzumio activations project --limit 20` | Show activation records. |
| `suzumio events project --limit 40` | Show event timeline. |

## WebUI

The packaged WebUI is served from the same server, usually `http://127.0.0.1:39400`.

The WebUI shows:

| View | Contents |
|------|----------|
| Project overview | Status, agents, lightweight counters, controls. |
| Messages | Direct and channel messages. |
| Agent history | Per-agent model-visible history, compaction markers, archives. |
| Tool status | A per-tool workspace with aggregate status, submit report path, and one selected WebUI control page at a time. Built-in message/signal controls use dropdowns populated from the current project agents. |

For WebUI development:

```bash
npm run webui:dev
```

Open `http://127.0.0.1:5173`. Vite proxies `/api` and `/health` to the backend on `39400`.

## Inspect Activations

Each activation directory contains the exact runner input.

```text
$SUZUMIO_ROOT/yaml-tutorial/activations/act_.../
  input.json
```

The input includes the rendered prompt, agent identity, controller URL, token, runner config, history, and tool definitions available to the model. Activation output is submitted through `POST /activation-output` and stored in SQLite.

## Shared Artifacts

Agents see shared artifact paths inside containers.

```text
/artifacts/pm          read-write for pm, read-only for others
/artifacts/researcher  read-write for researcher, read-only for others
```

Host files written by the tutorial worker appear under:

```text
$SUZUMIO_ROOT/yaml-tutorial/artifacts/researcher/
```

File writes do not wake another agent. The writing agent sends a message or submits completion when the artifact is ready.

## Healthy Run Shape

1. User message wakes `pm`.
2. `pm` sends a request to `researcher`.
3. `pm` calls `coordination.wait_for_signal`.
4. `researcher` runs `shell.exec`, writes `/artifacts/researcher/...`, and sends a report to `pm`.
5. `pm` gets a new activation with the worker report in conversation history.
6. `pm` calls `completion.submit` with the final Markdown report.
7. Project status becomes `submitted`.
8. User or operator runs `suzumio approve yaml-tutorial` when accepted.

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Project never starts an activation. | Project is not `running`. | `suzumio start project` |
| Agent stays quiet. | No pending signals target that agent. | `suzumio send project agent P1 "..."` |
| Message exists but no activation starts. | Agent is already `running`, project is stopped, or message targeted `user`. | Wait for completion or send a direct message to an agent. |
| Activation fails before submitting output. | Runner image, mount, Docker daemon, or provider issue. | Inspect `suzumio activations`, activation input, and `docker logs <container>`. |
| Support tool connection refused. | Container cannot reach Suzumio server. | Bind server to a Docker-reachable address and match `backend.controllerUrl`. |
| API key missing inside Docker. | Activation-launching process did not have the provider env var. | Export provider env before `serve`, `start`, `send`, and `tick`. |

## Debug Container Cleanup

Completed activation containers are kept for debugging. Remove only containers that Suzumio created.

```bash
docker ps -a --filter name=suzumio
docker rm <container-name>
```

Do not run broad Docker prune commands on shared machines.

<div class="footer">Next: <a href="toolpacks.html">Custom Tools</a>.</div>
