---
title: "Suzumio Architecture"
eyebrow: "Architecture"
heroTitle: "Core owns coordination. Containers run turns."
lead: "Suzumio separates orchestration from execution. The core process owns project truth and scheduling; the Docker runner performs one isolated turn and exits."
---

## Layer Map

    CLI / HTTP / WebUI
            |
            v
    Suzumio Core
      Config loader
      SQLite store
      Message router
      Artifact registry
      Tool support routes
      Non-preemptive scheduler
            |
            v
    Docker backend
      Creates turn input JSON
      Starts one container per turn
      Monitors container exit
            |
            v
    Container runner
      Reads /turn/input.json
      Runs AI mode
      Runs model-facing tools
      Calls Suzumio support routes for stateful tools
      POSTs /turn-output with final text

## Core Process

The core process is the authority for project-level records. If data should be visible in CLI, HTTP, WebUI, or audit logs, it belongs in SQLite through the core store.

| Module         | Responsibility                                                                                                                          |
|----------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| `config.ts`    | Loads YAML, resolves imports, applies `extends`, validates config, and renders final YAML.                                              |
| `store.ts`     | Creates and queries SQLite tables for projects, agents, messages, reads, turns, events, controller-supported tool calls, and artifacts. |
| `scheduler.ts` | Implements the `nonpreemptive-mailbox` scheduling rule.                                                                                 |
| `tools.ts`     | Defines tool metadata and executes controller-supported tool calls with token and allowlist checks.                                     |
| `server.ts`    | HTTP API, SSE stream, controller support route, turn result route, and embedded WebUI.                                                  |
| `backend.ts`   | Docker container creation, configured bind mounts, runner input, and turn completion monitoring.                                        |
| `runner.ts`    | Container entrypoint for model-backed turns and runner-local tool execution.                                                            |

## Runner Contract

The runner receives all context through one read-only input file and reports completion back over HTTP. This keeps execution replaceable without letting a model-editable file become the output authority.

    type RunnerTurnInput = {
      project: string
      agent: { id: string; role: string; prompt: string; model?: string }
      turn: { id: string; prompt: string }
      workspace: string
      controllerUrl: string
      token: string
      runner: RunnerConfig
      tools: ToolDefinition[]
    }

    type RunnerTurnOutput = {
      text: string
      usage?: Record<string, unknown>
    }

## Docker Isolation

Each turn container receives a small, explicit environment:

- A read-only bind mount for `/turn/input.json`.
- A bind mount for the agent workspace at `/workspace`.
- Configured host files or directories mounted at explicit non-reserved targets.
- Environment variables for project id, agent id, turn id, token, and configured model-provider key variables.
- `host.docker.internal` mapping so the runner can call Suzumio support routes and `/turn-output` on the host.

Completed containers are currently kept for early debugging. Cleanup policy should become configurable as the Docker backend hardens.

## Tool Flow

    Model asks for tool
      runner converts model tool call
      if the tool is runner-local:
        runner executes it inside the Docker container
      if the tool needs project state:
        runner POSTs /tool to Suzumio
        controller verifies token and tool allowlist
        controller updates SQLite, messages, artifacts, or submission state
      runner returns tool output to model

The model does not receive arbitrary host tools by default. Tools are configured per agent. `shell.exec` and `web.fetch` run inside the Docker runner; message, artifact, and completion tools use Suzumio support APIs.

## Message Delivery

Agents do not poll for messages. Suzumio renders unread inbound messages into the next turn prompt and records which turn consumed which message. This avoids polling loops and makes scheduling decisions auditable.

## SQLite as Project Truth

Each project has one SQLite file. The container runner does not maintain the project database. Durable project state must flow through authenticated HTTP submissions or controller support calls.

| Table           | Purpose                                                            |
|-----------------|--------------------------------------------------------------------|
| `projects`      | Project status, task, resolved config JSON, submitted report path. |
| `agents`        | Agent roster, prompts, tool allowlists, token, active turn.        |
| `messages`      | Direct and channel messages.                                       |
| `message_reads` | Which turn consumed which inbound message.                         |
| `turns`         | Turn execution records and output text.                            |
| `events`        | Append-style event timeline.                                       |
| `tool_calls`    | Audited tool execution records.                                    |
| `artifacts`     | Published file artifacts with hashes and metadata.                 |

## Why the Boundary Matters

Keeping project truth in the core runtime makes agent execution disposable. A runner can fail, be replaced, or be upgraded while the project database, message history, artifacts, and user-control surface remain stable.

<div class="footer">Next: <a href="operations.html">Operations</a>.</div>
