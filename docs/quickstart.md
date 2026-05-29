---
title: "Suzumio Quickstart"
eyebrow: "Quickstart"
heroTitle: "Run the runtime end to end"
lead: "This guide runs an AI-backed agent turn in Docker. It verifies the core path: config, SQLite, scheduler, Docker backend, runner tools, controller support routes, HTTP API, and WebUI."
---

## Prerequisites

| Requirement | Why it is needed                                   | Check            |
|-------------|----------------------------------------------------|------------------|
| Node.js 24+ | CLI, server, runner build, built-in SQLite module. | `node --version` |
| npm         | Install TypeScript and runtime dependencies.       | `npm --version`  |
| Docker      | Every agent turn runs in a container.              | `docker ps`      |
| Git         | Clone repository and manage local changes.         | `git --version`  |

## 1. Clone and Build

    git clone git@github.com:OmegaCombinator/suzumio.git
    cd suzumio
    npm install
    npm run build

## 2. Build the Runner Image

    docker build -t suzumio-runner:dev .

The example configs use `suzumio-runner:dev`. If you use a different tag, set `backend.image` in the project config.

## 3. Choose a Runtime Root

    export SUZUMIO_ROOT=/tmp/suzumio-root
    mkdir -p "$SUZUMIO_ROOT"

`SUZUMIO_ROOT` stores project databases, turn input files, workspaces, and artifacts. Keep it outside the Git repository.

## 4. Configure Model Credentials

The committed examples are sanitized. Copy an example config to a local untracked file if you need to replace the placeholder gateway URL, then export the configured API key environment variable.

    cp examples/demo.yaml /tmp/suzumio-demo.yaml
    # edit /tmp/suzumio-demo.yaml locally if you need a private gateway URL
    export SUZUMIO_GATEWAY_API_KEY=...

## 5. Inspect the Config

    suzumio config render /tmp/suzumio-demo.yaml

Rendering config before running is recommended. It shows imported content, default values, and the final shape stored in SQLite.

## 6. Initialize the Project

    suzumio init /tmp/suzumio-demo.yaml
    suzumio status demo

After initialization, the project is not scheduled yet. Start it explicitly when the server is running.

## 7. Start the Server

    suzumio serve --host 0.0.0.0 --port 39400

This starts the HTTP API, controller support routes, WebUI, SSE stream, and scheduler loop. Open `http://127.0.0.1:39400` in a browser.

## 8. Send the First Message

Open another terminal with the same `SUZUMIO_ROOT`.

    export SUZUMIO_ROOT=/tmp/suzumio-root
    suzumio start demo
    suzumio send demo pm P1 "Send one short status update to the user."

The message creates a pending `message.created` signal for `pm`. The scheduler will deliver that signal into one turn and start one Docker container.

## 9. Inspect Results

    suzumio turns demo --limit 5
    suzumio messages demo --limit 10
    suzumio events demo --limit 20

A successful run shows a completed turn, plus any messages, artifacts, or submission state the model created through Suzumio support routes.

## 10. Verify Non-preemptive Behavior

If an agent is already `running`, sending another message does not interrupt the current turn. The new message creates a pending signal that waits until the current turn completes. This is the expected default behavior.

## Optional Alternate AI Config

`examples/ai-demo.yaml` is also sanitized. Copy it to a local untracked file before adding private endpoints.

    cp examples/ai-demo.yaml /tmp/suzumio-ai-demo.yaml
    # edit /tmp/suzumio-ai-demo.yaml locally
    export SUZUMIO_GATEWAY_API_KEY=...
    suzumio init /tmp/suzumio-ai-demo.yaml

<div class="notice danger">

Do not commit real API keys, private gateway URLs, or private provider names. Keep them in local config and environment variables.

</div>

## Troubleshooting

| Symptom                                  | Cause                                                                                                        | Action                                                                            |
|------------------------------------------|--------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------|
| Turn fails before submitting a result.   | Runner image not built, wrong image name, container startup failure, or controller support connection issue. | Run `docker build -t suzumio-runner:dev .` and inspect `docker logs <container>`. |
| Support tool connection refused.         | Container cannot reach Suzumio server for stateful tools or turn output.                                     | Run server with `--host 0.0.0.0` and use `http://host.docker.internal:39400`.     |
| Agent does not start.                    | Project is not `running` or agent has no pending signal.                                                     | Run `suzumio start project` and send a direct message to the agent.               |
| GitHub Pages custom domain is HTTP only. | Certificate is still provisioning.                                                                           | Wait for GitHub Pages certificate issuance, then enable HTTPS enforcement.        |

<div class="footer">Next: <a href="concepts.html">Core Concepts</a>.</div>
