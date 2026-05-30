---
title: "Suzumio Quickstart"
eyebrow: "Quickstart"
heroTitle: "Your first YAML multi-agent project"
lead: "This tutorial starts from a project YAML file, renders it, initializes runtime state, starts the Docker-backed scheduler, and sends the first message."
---

## What You Are Building

You will create a small project with two agents:

- `pm`, the coordinator that receives the user request and decides when to submit;
- `researcher`, a worker that can run Python in Docker and write shared files under `/artifacts/researcher`.

This is intentionally small, but it contains the core pattern used by larger teams: the PM delegates, the worker reports, the PM waits or submits.

## Prerequisites

| Requirement | Why it is needed | Check |
|-------------|------------------|-------|
| Node.js 24+ | CLI, server, runner build, built-in SQLite module. | `node --version` |
| npm | Install TypeScript and runtime dependencies. | `npm --version` |
| Docker | Every agent activation runs in a container. | `docker ps` |
| Model gateway credentials | The AI runner needs a provider endpoint and API key. | provider-specific |

## 1. Build Suzumio

```bash
git clone git@github.com:OmegaCombinator/suzumio.git
cd suzumio
npm install
npm run build
docker build -t suzumio-runner:dev .
```

The default runner image includes Node.js, `python3`, and `curl`.

## 2. Write The YAML

Save this as `/tmp/suzumio-tutorial.yaml` and replace the gateway URL if needed.

```yaml
name: yaml-tutorial
task: |
  Produce a short note about one small Ramsey-number example.
  The worker should run a tiny Python check and save the script/output
  under /artifacts/researcher. The PM should summarize the result.

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
          baseURL: https://your-gateway.example/v1
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

This YAML does four important things:

- it gives `pm` the authority to submit, but not shell access;
- it gives `researcher` shell access, but not submit authority;
- it tells the worker where to write shared files;
- it tells both agents how to wait without polling.

## 3. Configure Secrets Locally

Do not commit real keys or private gateway URLs.

```bash
export SUZUMIO_ROOT=/tmp/suzumio-root
export SUZUMIO_GATEWAY_API_KEY=...
```

If Docker containers need an HTTP proxy, either export proxy env vars before running commands that may launch activations, or put `backend.docker.proxy` in a local untracked YAML file.

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

On Linux, if the proxy only listens on host loopback, use `backend.docker.network: host` and set `backend.controllerUrl` to `http://127.0.0.1:<port>`.

## 4. Render Before Running

```bash
suzumio config render /tmp/suzumio-tutorial.yaml
```

Rendering shows imports, environment substitutions, defaults, and the exact YAML shape that will be stored with the project.

## 5. Initialize And Serve

```bash
suzumio init /tmp/suzumio-tutorial.yaml
suzumio serve --host 0.0.0.0 --port 39400
```

Open another terminal with the same env vars:

```bash
export SUZUMIO_ROOT=/tmp/suzumio-root
export SUZUMIO_GATEWAY_API_KEY=...
suzumio start yaml-tutorial
suzumio send yaml-tutorial pm P1 "Run the small Ramsey example and submit a short note."
```

`start` and `send` can run scheduler ticks directly, so they need the same provider/proxy environment as the server.

## 6. Inspect The Run

```bash
suzumio status yaml-tutorial
suzumio messages yaml-tutorial --limit 20
suzumio activations yaml-tutorial --limit 20
suzumio events yaml-tutorial --limit 40
```

Files written by the worker appear on the host under:

```text
$SUZUMIO_ROOT/yaml-tutorial/artifacts/researcher/
```

Inside containers, agents see shared artifact paths like:

```text
/artifacts/pm          read-write for pm, read-only for others
/artifacts/researcher  read-write for researcher, read-only for others
```

## 7. What To Look For

A healthy run usually contains this sequence:

1. User message wakes `pm`.
2. `pm` sends a request to `researcher`.
3. `pm` calls `coordination.wait_for_signal`.
4. `researcher` runs `shell.exec`, writes `/artifacts/researcher/...`, and sends a report to `pm`.
5. `pm` gets a new activation with the worker report in conversation history.
6. `pm` calls `completion.submit` with the final Markdown report.

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Activation fails before submitting a result. | Runner image not built, wrong image name, Docker startup failure, or model/provider error. | Run `docker build -t suzumio-runner:dev .` and inspect `suzumio activations` plus `docker logs <container>`. |
| Support tool connection refused. | Container cannot reach the Suzumio server. | Run server with `--host 0.0.0.0` and use `http://host.docker.internal:39400`, or use host networking with `127.0.0.1`. |
| Agent does not start. | Project is not `running` or no pending signal targets that agent. | Run `suzumio start project` and send a direct message to an agent. |
| API key missing inside Docker. | The process that launched the activation did not have the provider env var. | Export the key before `serve`, `start`, `send`, and `tick`. |

<div class="footer">Next: <a href="configuration.html">YAML Configuration</a>.</div>
