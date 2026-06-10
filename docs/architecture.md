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
      Appends docker-chat agent history through support routes
      POSTs /activation-output with final text

## Core Process

The core process is the authority for project-level records. Data visible in CLI, HTTP, WebUI, or audit logs belongs in SQLite through the core store.

| Module         | Responsibility                                                                                                                          |
|----------------|-----------------------------------------------------------------------------------------------------------------------------------------|
| `config.ts`    | Loads YAML, resolves imports, applies `extends`, validates config, and renders final YAML.                                              |
| `store.ts`     | Creates and queries SQLite tables for projects, agents, messages, signals, agent history, activations, events, and tool calls.          |
| `scheduler.ts` | Implements signal delivery, including `P0` interruption, `P1` tool-boundary delivery, and local toolpack scheduler hooks.              |
| `tools.ts`     | Resolves built-in and local toolpacks, serves controller support with token/allowlist checks, exposes trusted WebUI entries, and runs scheduler hooks. |
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
      history?: AgentHistoryMessage[]
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
- `host.docker.internal` mapping for runner calls to Suzumio support routes and `/activation-output` on the host.

Completed containers are currently kept for early debugging. Cleanup policy is planned as a Docker backend setting.

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

The model does not receive arbitrary host tools by default. Tools are configured per agent. `file.read`, `file.write`, `file.patch`, `shell.exec`, and `web.fetch` run inside the Docker runner; message, completion, and coordination tools use Suzumio support APIs.

Toolpacks can also register WebUI entries. These are user-facing project controls rendered by the WebUI Tools panel and invoked through public project APIs, not model-facing tools and not runner-internal routes. Local controller modules can additionally export scheduler hooks; the core scheduler passes current agent state, including whether each agent has a live running activation, and the hook may create messages or signals before built-in nudge rules run.

## Agent History

Agent continuity is stored as append-only history rows in SQLite, not as a container-local session file. Before starting an activation, the backend snapshots the target agent's active history into `/activation/input.json`. The docker-chat runner turns that history into model messages, then appends visible assistant output and audited tool records through runner-internal support routes.

Compaction is decided by the docker-chat runner only after the model provider reports that the request exceeds the available context window. The runner generates the summary, then calls a runner-internal persistence route. Suzumio-side docker-chat support archives the raw compacted range, appends a compaction marker, and then retries. The scheduler does not assign or decide compaction.

## Signal Delivery

Agents do not poll for work. Suzumio appends pending signals into the target agent history and records which activation received each signal. The scheduling record remains explicit and auditable.

Priority controls when a pending signal becomes model-visible. `P0` cancels the current activation and restarts the agent with the new signal. `P1` is injected after the next completed tool call when possible, otherwise it waits for the next activation. `P2` waits until the current activation completes and is delivered before routine backlog. `P3` is ordinary queued work and is delivered after any pending `P2` signal.

Messages create `message.created` signals. Shared artifact files are ordinary durable files and do not wake agents by themselves. Custom toolpacks can call `recordSignal` to create pending coordination work or closed useful effects.

## SQLite as Project Truth

Each project has one SQLite file. The container runner does not maintain the project database. Durable project state must flow through authenticated HTTP submissions or controller support calls.

| Table           | Purpose                                                            |
|-----------------|--------------------------------------------------------------------|
| `projects`      | Project status, task, resolved config JSON, submitted report path. |
| `agents`        | Agent roster, prompts, tool allowlists, token, active activation.  |
| `messages`      | Direct and channel messages.                                       |
| `signals`       | Scheduler inputs, delivered signal records, and useful effects.    |
| `agent_history_messages` | Per-agent model-visible history records.                  |
| `agent_history_parts` | Structured text/tool/compaction parts for history records.     |
| `agent_history_compactions` | Raw archive metadata for compacted history ranges.      |
| `activations`   | Activation execution records and output text.                      |
| `events`        | Append-style event timeline.                                       |
| `tool_calls`    | Audited tool execution records.                                    |

## Boundary Result

Keeping project truth in the core runtime makes agent execution disposable. A runner can fail, be replaced, or be upgraded while the project database, agent histories, shared artifact files, and user-control surface remain stable.

<div class="footer">Source: <a href="https://github.com/OmegaCombinator/suzumio">OmegaCombinator/suzumio</a>.</div>
