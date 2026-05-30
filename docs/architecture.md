---
title: "Suzumio Architecture"
eyebrow: "Architecture"
heroTitle: "Core owns coordination. Containers run activations."
lead: "Suzumio separates orchestration from execution. The core process owns project truth and scheduling; the Docker runner performs one isolated activation and exits."
---

## Layer Map

    CLI / HTTP / WebUI
            |
            v
    Suzumio Core
      Config loader
      SQLite store
      Signal router
      Shared artifact mounts
      Tool support routes
      Non-preemptive scheduler
            |
            v
    Docker backend
      Creates activation input JSON
      Starts one container per activation
      Monitors container exit
            |
            v
    Container runner
      Reads /activation/input.json
      Runs AI mode
      Runs model-facing tools
      Calls Suzumio support routes for stateful tools
      POSTs /activation-output with final text

## Core Process

The core process is the authority for project-level records. If data should be visible in CLI, HTTP, WebUI, or audit logs, it belongs in SQLite through the core store.

| Module         | Responsibility                                                                                                                          |
|----------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| `config.ts`    | Loads YAML, resolves imports, applies `extends`, validates config, and renders final YAML.                                              |
| `store.ts`     | Creates and queries SQLite tables for projects, agents, messages, signals, activations, events, and tool calls.                         |
| `scheduler.ts` | Implements the signal-driven non-preemptive scheduling rule.                                                                            |
| `tools.ts`     | Resolves built-in and local toolpacks and serves controller support with token and allowlist checks.                                    |
| `server.ts`    | HTTP API, SSE stream, controller support route, activation result route, and static WebUI asset serving.                                 |
| `webui/`       | Preact + Vite project for the browser control room served at `/`.                                                                        |
| `backend.ts`   | Docker container creation, configured bind mounts, runner input, and activation completion monitoring.                                  |
| `runner.ts`    | Container entrypoint for model-backed activations and runner-local tool execution.                                                      |

## Runner Contract

The runner receives context through one read-only input file and reports completion back over HTTP. This keeps execution replaceable without letting a model-editable file become the output authority.

    type RunnerActivationInput = {
      project: string
      agent: { id: string; role: string; prompt: string; model?: string }
      activation: { id: string; prompt: string }
      workspace: string
      controllerUrl: string
      token: string
      runner: RunnerConfig
      tools: ToolDefinition[]
      toolpacks: RunnerToolpackSpec[]
    }

    type RunnerActivationOutput = {
      text: string
      usage?: Record<string, unknown>
    }

## Docker Isolation

Each activation container receives a small, explicit environment:

- A read-only bind mount for `/activation/input.json`.
- A bind mount for the agent workspace at `/workspace`.
- Configured host files or directories mounted at explicit non-reserved targets.
- Environment variables for project id, agent id, activation id, token, and configured model-provider key variables.
- `host.docker.internal` mapping so the runner can call Suzumio support routes and `/activation-output` on the host.

Completed containers are currently kept for early debugging. Cleanup policy should become configurable as the Docker backend hardens.

## Tool Flow

    Model asks for tool
      runner converts model tool call
      runner POSTs /runner/tool-calls/start
      runner executes the runner-side tool handler
      if the tool needs project state:
        runner POSTs /toolpacks/:toolpackId/support
        controller verifies token, activation ownership, toolpack membership, and allowlist
        controller updates SQLite, messages, signals, or submission state
      runner POSTs /runner/tool-calls/finish
      runner returns tool output to model

The model does not receive arbitrary host tools by default. Tools are configured per agent. `shell.exec` and `web.fetch` run inside the Docker runner; message, completion, and coordination tools use Suzumio support APIs.

## Signal Delivery

Agents do not poll for work. Suzumio renders pending signals into the next activation prompt and records which activation received each signal. This avoids polling loops and makes scheduling decisions auditable.

Messages create `message.created` signals. Shared artifact files are ordinary durable files and do not wake agents by themselves. Custom toolpacks can call `recordSignal` to create pending coordination work or closed useful effects.

## SQLite as Project Truth

Each project has one SQLite file. The container runner does not maintain the project database. Durable project state must flow through authenticated HTTP submissions or controller support calls.

| Table           | Purpose                                                            |
|-----------------|--------------------------------------------------------------------|
| `projects`      | Project status, task, resolved config JSON, submitted report path. |
| `agents`        | Agent roster, prompts, tool allowlists, token, active activation.  |
| `messages`      | Direct and channel messages.                                       |
| `signals`       | Scheduler inputs, delivered signal records, and useful effects.    |
| `activations`   | Activation execution records and output text.                      |
| `events`        | Append-style event timeline.                                       |
| `tool_calls`    | Audited tool execution records.                                    |

## Why the Boundary Matters

Keeping project truth in the core runtime makes agent execution disposable. A runner can fail, be replaced, or be upgraded while the project database, message history, shared artifact files, and user-control surface remain stable.

<div class="footer">Next: <a href="operations.html">Operations</a>.</div>
