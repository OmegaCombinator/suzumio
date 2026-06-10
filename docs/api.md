---
title: "Suzumio HTTP API"
eyebrow: "Reference"
heroTitle: "HTTP API and Tool Support"
lead: "The HTTP server exposes project observability, user control actions, SSE event streaming, and controller support routes for the Docker runner."
---

## Server

    suzumio serve --host 0.0.0.0 --port 39400

The current API is intended for local or trusted-network use. User-facing API authentication is not implemented in the first version. The container-facing tool route uses per-agent tokens.

## Conventions

| Topic       | Behavior                                                                             |
|-------------|--------------------------------------------------------------------------------------|
| Base URL    | `http://127.0.0.1:39400` by default.                                                 |
| Body format | JSON for POST routes except no-body lifecycle actions.                               |
| List limits | `?limit=n`, capped at 500.                                                           |
| Errors      | Validation and runtime errors return plain text or JSON depending on the route path. |
| Tokens      | Agent tokens are redacted from project and agent listing responses.                  |

## Health

    GET /health

    {
      "healthy": true
    }

## Projects

| Method | Path                     | Description                                                              |
|--------|--------------------------|--------------------------------------------------------------------------|
| `GET`  | `/api/projects`          | List projects under `SUZUMIO_ROOT`. Each entry is a project summary.     |
| `GET`  | `/api/projects/:project` | Project summary with redacted agents, recent activations, and recent messages. |

    curl http://127.0.0.1:39400/api/projects/demo

## Project Objects

| Method | Path                                          | Description                                                    |
|--------|-----------------------------------------------|----------------------------------------------------------------|
| `GET`  | `/api/projects/:project/agents`               | Agent records with tokens redacted.                            |
| `GET`  | `/api/projects/:project/agents/:agent/history?limit=100` | Paged per-agent model history.                         |
| `GET`  | `/api/projects/:project/agents/:agent/history-archive/:compaction` | Raw local archive for one history compaction.     |
| `GET`  | `/api/projects/:project/messages?limit=100`   | Recent messages.                                               |
| `GET`  | `/api/projects/:project/events?limit=200`     | Recent events.                                                 |
| `GET`  | `/api/projects/:project/activations?limit=100` | Recent activations.                                            |
| `GET`  | `/api/projects/:project/activations/:id/context` | Scheduler prompt plus the model message context snapshot for one activation. |
| `GET`  | `/api/projects/:project/tool-calls?limit=100` | Recent tool calls.                                             |
| `GET`  | `/api/projects/:project/tool-ui`            | WebUI entries registered by configured toolpacks.               |
| `POST` | `/api/projects/:project/tool-ui/:toolpackId/:entryId` | Invoke one registered WebUI tool entry.                  |
| `GET`  | `/api/projects/:project/config/resolved`      | Resolved YAML config as plain text.                            |
| `GET`  | `/api/projects/:project/report`               | Final report text if submitted, otherwise a short placeholder. |

## User Control Actions

| Method | Path                                     | Body                                                     | Description                                                                |
|--------|------------------------------------------|----------------------------------------------------------|----------------------------------------------------------------------------|
| `POST` | `/api/projects/:project/start`           | Empty                                                    | Set project status to `running` and tick scheduler.                        |
| `POST` | `/api/projects/:project/stop`            | Empty                                                    | Set project status to `stopped`.                                           |
| `POST` | `/api/projects/:project/approve`         | Empty                                                    | Set project status to `completed`.                                         |
| `POST` | `/api/projects/:project/request-changes` | `{ "recipient": "pm", "body": "..." }`                   | Return project to `running`, send a `P2` user message, and tick scheduler. |
| `POST` | `/api/projects/:project/messages`        | `{ "recipient": "pm", "priority": "P1", "body": "..." }` | Create a message and tick scheduler.                                       |

    curl -X POST http://127.0.0.1:39400/api/projects/demo/messages \
      -H 'content-type: application/json' \
      -d '{"recipient":"pm","priority":"P1","body":"Start."}'

For `/messages`, body may include `sender`, `recipient`, `channel`, `priority`, and `body`. Use either `recipient` or `channel`. Priority defaults to `P2`.

## SSE Stream

The event stream sends SQLite events as Server-Sent Events. It emits existing recent events first and polls for new events every two seconds.

    GET /api/projects/:project/stream

    event: message.created
    data: { ...event row... }

## Runner Support Routes

The Docker runner presents all model-facing tools. The controller provides support APIs for permissions, state, persistence, tool-call audit records, and custom toolpack support. Runner-local tools such as `file.read`, `file.write`, `file.patch`, `shell.exec`, and `web.fetch` execute inside the Docker container. These routes are not public user APIs.

| Method | Path                                  | Purpose                                                            |
|--------|---------------------------------------|--------------------------------------------------------------------|
| `POST` | `/runner/tool-calls/start`            | Authenticate agent/activation, verify tool membership and allowlist, and create a running `tool_calls` row. |
| `POST` | `/runner/tool-calls/finish`           | Mark a tool call completed or failed after verifying it belongs to this agent activation.                  |
| `POST` | `/runner/signals`                     | Let runner-side or local toolpack code create a pending signal or closed effect.                     |
| `POST` | `/runner/history/messages`            | Append visible assistant/history records for the current activation.                                  |
| `POST` | `/runner/history/compact`             | Archive old agent history and append a compaction summary marker.                                    |
| `POST` | `/toolpacks/:toolpackId/support`      | Dispatch controller-side support for built-in or local toolpacks.                                    |
| `POST` | `/activation-context`                 | Submit the model message context snapshot for a running activation.                                  |
| `POST` | `/activation-output`                  | Submit final activation text and usage metadata.                                                        |

Support requests include `project`, `agentId`, `activationId`, and the agent private `token`. Toolpack support also includes the tool name and input:

    POST /toolpacks/core/support
    {
      "project": "demo",
      "agentId": "pm",
      "activationId": "act_...",
      "token": "agent-private-token",
      "tool": "messages.send",
      "input": {
        "recipient": "user",
        "priority": "P1",
        "body": "Done."
      }
    }

The support host verifies token, activation ownership, toolpack membership, and agent allowlist before invoking controller support.

### `POST /runner/signals`

    {
      "project": "demo",
      "agentId": "worker-1",
      "activationId": "act_...",
      "token": "agent-private-token",
      "kind": "review.ready",
      "targetAgent": "pm",
      "priority": "P1",
      "payload": { "artifactId": "art_..." }
    }

Set `targetAgent` or `targetChannel` to create schedulable work. Omit the target and set `usefulEffect: true` to record a closed useful effect without waking any agent. Targeted signals cannot be explicitly closed.

## Tool WebUI Routes

Configured toolpacks can register user-facing WebUI entries. These routes are project APIs, not runner-internal routes, so they do not use agent activation tokens. They are intended for the trusted WebUI/control-room surface.

    GET /api/projects/demo/tool-ui

    [
      {
        "toolpackId": "core",
        "toolpackKind": "builtin",
        "id": "project.stats",
        "title": "Project statistics",
        "kind": "panel"
      }
    ]

    POST /api/projects/demo/tool-ui/core/project.stats
    {}

    {
      "title": "Project statistics",
      "output": "Status: running\nAgents: 3 ...",
      "metadata": { "metrics": [] }
    }

`kind: "panel"` entries are read-style controls that the WebUI can refresh. `kind: "action"` entries render a generic form from `inputSchema` and submit the result to the same POST route.

## Custom Toolpack Signals

Local runner modules and controller modules receive a context with `recordSignal`. Custom tools use it to produce work for another agent or record a useful effect.

    export function createRunnerToolpack(context) {
      return {
        tools: {
          "review.ready": async (input) => {
            await context.recordSignal({
              kind: "review.ready",
              targetAgent: "pm",
              priority: "P1",
              payload: { summary: input.summary }
            });
            return { output: "PM notified." };
          }
        }
      };
    }

    export function createControllerToolpack(context) {
      return {
        async support(tool, input) {
          context.recordSignal({
            kind: "review.cached",
            payload: { cacheKey: input.cacheKey },
            usefulEffect: true
          });
          return { output: "Cached review state." };
        }
      };
    }

The first example creates pending work for `pm`. The second records a closed useful effect without scheduling anyone.

### `POST /activation-output`

    {
      "project": "demo",
      "agentId": "pm",
      "activationId": "act_...",
      "token": "agent-private-token",
      "output": {
        "text": "Activation result text",
        "usage": { "model": "worker-main" }
      }
    }

The backend marks the activation complete only after this authenticated submission. `/activation/input.json` is a read-only input/debug contract; activation output is not read from a container-writable file.

### `POST /activation-context`

The Docker chat runner submits a context snapshot immediately before the main model call. The public activation context API uses this to show exactly what messages were sent to the model. Older activations that predate this field fall back to the activation prompt.

### Agent History APIs

`GET /api/projects/:project/agents/:agent/history` returns newest history rows first and accepts `limit`, `before`, and `includeArchived=0`. Each row includes role, kind, activation id, sequence number, metadata, and truncated content. Use `nextBefore` from the response to load older pages.

Compaction rows include a `compactionId` in metadata. `GET /api/projects/:project/agents/:agent/history-archive/:compaction` loads the full raw archive saved before compaction. Normal WebUI refresh does not fetch archived payloads.

## Core Tool Inputs

### `messages.send`

    {
      "recipient": "worker",
      "channel": "#project",
      "priority": "P2",
      "body": "Markdown message"
    }

Use either `recipient` or `channel`, not both. Channels must be declared in project config.

Messages to agents create pending `message.created` signals. Channel messages fan out to other agents. Messages to `recipient: "user"` create closed useful effects and do not wake an agent.

### `coordination.wait_for_signal`

    {
      "reason": "Waiting for worker-2's result.",
      "pm": "pm",
      "notifyPm": true
    }

Declares that useful progress now depends on future signals. This ends the current activation. Non-PM agents notify `pm` by direct message by default. PM calls record a closed useful effect and wait quietly.

### `file.read`

    {
      "path": "/workspace/src/example.txt",
      "offset": 1,
      "limit": 200,
      "maxBytes": 50000
    }

Reads a file or directory from `/workspace`, `/artifacts`, or `/mnt`. Relative paths are resolved under `/workspace`. File output is line-numbered, `offset` is 1-indexed, `limit` defaults to 200 and is capped at 2000, and `maxBytes` defaults to 50000 and is capped at 100000.

### `file.write`

    {
      "path": "/workspace/notes/result.md",
      "content": "Markdown content\n",
      "createDirs": true
    }

Writes a complete file under `/workspace` or the current agent's own `/artifacts/<agent-id>` directory. Relative paths are resolved under `/workspace`. `file.patch` handles targeted edits.

### `file.patch`

    {
      "operations": [
        {
          "op": "update",
          "path": "/workspace/notes/result.md",
          "search": "old text",
          "replace": "new text"
        }
      ]
    }

Applies exact text edits under `/workspace` or the current agent's own `/artifacts/<agent-id>` directory. Operations support `add`, `update`, and `delete`. `update` requires exact `search` text; by default it must match exactly once. Set `replaceAll: true` only when replacing every occurrence is intended.

### `shell.exec`

    {
      "command": "cp -r /mnt/reference ./reference && make test",
      "cwd": "/workspace",
      "timeoutMs": 120000,
      "maxOutputBytes": 40000
    }

Runs bash inside the Docker runner container. Typical operations include copying mounted inputs, compiling code, running binaries, tests, and project-local scripts. Grant it only to agents that execute container commands.

### `completion.submit`

    {
      "report": "# Final Report\n\n..."
    }

This writes `final-report.md`, marks the project `submitted`, and waits for user approval. The submitting agent incorporates the relevant current information and has no outstanding substantive replies it requested.

### `web.fetch`

    {
      "url": "https://example.com/",
      "maxBytes": 20000,
      "timeoutMs": 30000,
      "format": "text"
    }

Fetches an HTTP(S) URL from inside the Docker runner container. `format: "text"` returns cleaned text for HTML responses and raw text for other content types; `format: "raw"` returns the unmodified response text. Grant it only to agents with web access.

## WebUI

The root path `/` serves the Preact-based WebUI built from `webui/`. It calls the API routes above and refreshes periodically. For WebUI development, run `npm run webui:dev` and open `http://127.0.0.1:5173`; Vite proxies `/api` and `/health` to the backend on `39400`. The control room includes project selection, status actions, message composition, agent roster, per-agent history, messages, activations, per-activation model context snapshots, tool calls, event timeline, resolved YAML, and submitted report views. The project overview refreshes as a lightweight summary; large logs, agent histories, config, events, tool calls, archives, and context payloads are loaded on demand.

<div class="footer">Next: <a href="architecture.html">Architecture</a>.</div>
