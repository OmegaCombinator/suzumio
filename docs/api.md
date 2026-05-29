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
| `GET`  | `/api/projects/:project` | Project summary with redacted agents, recent turns, and recent messages. |

    curl http://127.0.0.1:39400/api/projects/demo

## Project Objects

| Method | Path                                          | Description                                                    |
|--------|-----------------------------------------------|----------------------------------------------------------------|
| `GET`  | `/api/projects/:project/agents`               | Agent records with tokens redacted.                            |
| `GET`  | `/api/projects/:project/messages?limit=100`   | Recent messages.                                               |
| `GET`  | `/api/projects/:project/events?limit=200`     | Recent events.                                                 |
| `GET`  | `/api/projects/:project/turns?limit=100`      | Recent turns.                                                  |
| `GET`  | `/api/projects/:project/tool-calls?limit=100` | Recent tool calls.                                             |
| `GET`  | `/api/projects/:project/artifacts?limit=100`  | Artifact registry.                                             |
| `GET`  | `/api/projects/:project/config/resolved`      | Resolved YAML config as plain text.                            |
| `GET`  | `/api/projects/:project/report`               | Final report text if submitted, otherwise a short placeholder. |

## User Control Actions

| Method | Path                                     | Body                                                     | Description                                                                |
|--------|------------------------------------------|----------------------------------------------------------|----------------------------------------------------------------------------|
| `POST` | `/api/projects/:project/start`           | Empty                                                    | Set project status to `running` and tick scheduler.                        |
| `POST` | `/api/projects/:project/stop`            | Empty                                                    | Set project status to `stopped`.                                           |
| `POST` | `/api/projects/:project/approve`         | Empty                                                    | Set project status to `completed`.                                         |
| `POST` | `/api/projects/:project/request-changes` | `{ "recipient": "pm", "body": "..." }`                   | Return project to `running`, send a `P1` user message, and tick scheduler. |
| `POST` | `/api/projects/:project/messages`        | `{ "recipient": "pm", "priority": "P1", "body": "..." }` | Create a message and tick scheduler.                                       |

    curl -X POST http://127.0.0.1:39400/api/projects/demo/messages \
      -H 'content-type: application/json' \
      -d '{"recipient":"pm","priority":"P1","body":"Start."}'

For `/messages`, body may include `sender`, `recipient`, `channel`, `priority`, and `body`. Use either `recipient` or `channel`. Priority defaults to `P1`.

## SSE Stream

The event stream sends SQLite events as Server-Sent Events. It emits existing recent events first and polls for new events every two seconds.

    GET /api/projects/:project/stream

    event: message.created
    data: { ...event row... }

## Runner Support Routes

The Docker runner presents all model-facing tools. The controller provides support APIs for permissions, state, persistence, tool-call audit records, and custom toolpack support. Runner-local tools such as `shell.exec` and `web.fetch` execute inside the Docker container. These routes are not public user APIs.

| Method | Path                                  | Purpose                                                            |
|--------|---------------------------------------|--------------------------------------------------------------------|
| `POST` | `/runner/tool-calls/start`            | Authenticate agent/turn, verify tool membership and allowlist, and create a running `tool_calls` row. |
| `POST` | `/runner/tool-calls/finish`           | Mark a tool call completed or failed after verifying it belongs to this agent turn.                  |
| `POST` | `/runner/signals`                     | Let runner-side or local toolpack code create a pending signal or closed effect.                     |
| `POST` | `/toolpacks/:toolpackId/support`      | Dispatch controller-side support for built-in or local toolpacks.                                    |
| `POST` | `/turn-output`                        | Submit final turn text and usage metadata.                                                              |

Support requests include `project`, `agentId`, `turnId`, and the agent private `token`. Toolpack support also includes the tool name and input:

    POST /toolpacks/core/support
    {
      "project": "demo",
      "agentId": "pm",
      "turnId": "turn_...",
      "token": "agent-private-token",
      "tool": "messages.send",
      "input": {
        "recipient": "user",
        "priority": "P1",
        "body": "Done."
      }
    }

The support host verifies token, turn ownership, toolpack membership, and agent allowlist before invoking controller support.

### `POST /runner/signals`

    {
      "project": "demo",
      "agentId": "worker-1",
      "turnId": "turn_...",
      "token": "agent-private-token",
      "kind": "review.ready",
      "targetAgent": "pm",
      "priority": "P1",
      "payload": { "artifactId": "art_..." }
    }

Set `targetAgent` or `targetChannel` to create schedulable work. Omit the target and set `usefulEffect: true` to record a closed useful effect without waking any agent. Targeted signals cannot be explicitly closed.

## Custom Toolpack Signals

Local runner modules and controller modules receive a context with `recordSignal`. Use it when a custom tool produces work for another agent or records a useful effect.

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

### `POST /turn-output`

    {
      "project": "demo",
      "agentId": "pm",
      "turnId": "turn_...",
      "token": "agent-private-token",
      "output": {
        "text": "Turn result text",
        "usage": { "model": "worker-main" }
      }
    }

The backend marks the turn complete only after this authenticated submission. `/turn/input.json` is a read-only input/debug contract; turn output is not read from a container-writable file.

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

### `coordination.no_valuable_work`

    {
      "reason": "Waiting for worker-2's result.",
      "pm": "pm",
      "notifyPm": true
    }

Declares that the caller has no valuable work to do until future signals arrive. Non-PM agents notify `pm` by direct message by default. PM calls record a closed useful effect and wait quietly.

### `artifacts.publish`

    {
      "path": "relative/path/in/workspace.txt",
      "name": "optional-name.txt",
      "description": "What this artifact contains"
    }

The path is relative to the agent workspace. Suzumio copies the file or directory into the project artifact registry and records a SHA-256 hash. Publishing alone is not a useful effect; agents should also send a message or submit completion when the artifact is ready for someone else.

### `artifacts.list`

    {}

### `artifacts.read`

    {
      "id": "art_...",
      "maxBytes": 20000
    }

Use either `id` or `name`. This reads text file artifacts from the artifact registry. For configured read-only host files or directories, use their mounted paths and `shell.exec`, for example `cp -r /mnt/reference /workspace/reference`.

### `shell.exec`

    {
      "command": "cp -r /mnt/reference ./reference && make test",
      "cwd": "/workspace",
      "timeoutMs": 120000,
      "maxOutputBytes": 40000
    }

Runs bash inside the Docker runner container. Use it for copying mounted inputs, compiling code, running binaries, tests, or project-local scripts. Grant it only to agents that should execute container commands.

### `completion.submit`

    {
      "report": "# Final Report\n\n..."
    }

This writes `final-report.md`, marks the project `submitted`, and waits for user approval.

### `web.fetch`

    {
      "url": "https://example.com/",
      "maxBytes": 20000,
      "timeoutMs": 30000,
      "format": "text"
    }

Fetches an HTTP(S) URL from inside the Docker runner container. `format: "text"` returns cleaned text for HTML responses and raw text for other content types; `format: "raw"` returns the unmodified response text. Grant it only to agents that should have web access.

## WebUI

The root path `/` serves the embedded WebUI. It calls the API routes above and refreshes periodically. The first version is intentionally simple: project selector, message form, agents, messages, turns, events, and artifacts.

<div class="footer">Next: <a href="roadmap.html">Roadmap</a>.</div>
