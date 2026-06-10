---
title: "Suzumio Custom Tools"
eyebrow: "Custom Tools"
heroTitle: "Add project tools with local toolpacks"
lead: "Tools are registered at the project level and allowlisted per agent. Built-ins cover messaging, waiting, submission, file access, shell, and web fetch; local toolpacks add project-specific model-facing tools."
---

## Registration And Allowlists

```yaml
tools:
  toolpacks:
    - core
    - shell
    - web
    - path: ./toolpacks/scheduler
      id: scheduler
    - path: ./toolpacks/review
      id: review-tools

agents:
  reviewer:
    tools:
      - messages.send
      - coordination.wait_for_signal
      - schedule.*
      - review.summarize
```

`tools.toolpacks` registers tool definitions. `agents.<id>.tools` decides which registered tools an agent can see. Agent allowlists support exact names, namespace wildcards such as `file.*`, and `*`.

## Built-In Toolpacks

| Toolpack | Registered tools | Execution |
|----------|------------------|-----------|
| `core` | `messages.send`, `coordination.wait_for_signal`, `completion.submit`, `file.read`, `file.write`, `file.patch` | Runner container + Suzumio support API |
| `shell` | `shell.exec` | Docker runner container |
| `web` | `web.fetch` | Docker runner container |

`file.read` reads from `/workspace`, `/artifacts`, or `/mnt`. `file.write` and `file.patch` write under `/workspace` or the current agent's own `/artifacts/<agent-id>` directory.

Mounted inputs are host files or directories exposed at configured container paths. The current agent's artifact directory is read-write; other agents' artifact directories are read-only.

## Local Toolpack Layout

```text
toolpacks/review/
  suzumio.toolpack.json
  runner.mjs
  controller.mjs
```

Local toolpacks are directories on the controller host. Suzumio mounts them read-only into runner containers.

Only local toolpacks that expose at least one allowed model-facing tool for the current agent are mounted into that agent's activation container. WebUI-only toolpacks and toolpacks hidden by an agent allowlist stay on the controller side.

```yaml
tools:
  toolpacks:
    - core
    - path: ./toolpacks/review
      id: review-tools
```

## Manifest

```json
{
  "id": "review-tools",
  "runner": "runner.mjs",
  "controller": "controller.mjs",
  "webui": [
    {
      "id": "review.stats",
      "title": "Review statistics",
      "description": "Show cached review counts.",
      "kind": "panel"
    }
  ],
  "tools": [
    {
      "name": "review.summarize",
      "description": "Summarize review findings.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "summary": { "type": "string" }
        },
        "required": ["summary"],
        "additionalProperties": false
      }
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Toolpack id. It matches the optional config `id` when one is provided. |
| `runner` | No | Runner-side module path, relative to the toolpack root. Defaults to `runner.mjs`. Required only when `tools` is non-empty. |
| `controller` | No | Controller-side module path, relative to the toolpack root. Defaults to `controller.mjs`. |
| `tools` | Yes | Array of tool definitions with `name`, `description`, and JSON-schema-like `inputSchema`. |
| `webui` | No | Optional WebUI entries rendered in the Tools panel. Each entry has `id`, `title`, `kind`, and optional `description`, `inputSchema`, and `submitLabel`. |

The id contains only letters, digits, `.`, `_`, and `-`. HTTP(S) toolpack paths are rejected. Module paths stay inside the toolpack directory and end in `.mjs`. The controller module must exist. The runner module must exist when model-facing tools are declared. Duplicate toolpack ids and duplicate tool names across registered toolpacks are rejected.

Runtime TypeScript transpilation is not provided. Toolpack modules are JavaScript ESM `.mjs` files.

## Packaged Scheduler Toolpack

The repository includes `toolpacks/scheduler` as a local, non-kernel toolpack for scheduled messages. Register it by path and allowlist its tools for agents that may create or manage schedules:

```yaml
tools:
  toolpacks:
    - core
    - path: ./toolpacks/scheduler
      id: scheduler

agents:
  pm:
    tools:
      - messages.send
      - schedule.*
```

It provides `schedule.once`, `schedule.recurring`, `schedule.list`, and `schedule.cancel`, plus WebUI controls under the scheduler tool page. Jobs are stored in the project directory at `toolpack-state/scheduler/jobs.json`. Due jobs create ordinary messages through the project store, default to `P3`, and can set `waitForQuiet: true` to wait while the direct recipient has a live model activation. Weekly recurring jobs use UTC `weekday` plus `time`.

## Runner Module

Runner modules implement model-facing tools inside the container. Export `createRunnerToolpack(context)` or a default factory. Return a tool map directly or `{ tools: { ... } }`. Every declared tool name has a handler.

```js
export function createRunnerToolpack(context) {
  return {
    tools: {
      "review.summarize": async (input) => {
        await context.callSupport("review.summarize", input);
        return { output: `Review summary recorded: ${input.summary}` };
      },
    },
  };
}
```

Runner handler input is the model-provided JSON. Runner handler output is `{ output, title?, metadata? }`.

Runner context fields:

| Field | Description |
|-------|-------------|
| `project` | Project id. |
| `agentId` | Current agent id. |
| `activationId` | Current activation id. |
| `workspace` | Container workspace path. |
| `toolpackId` | Current toolpack id. |
| `callSupport(tool, input)` | Calls the controller module for this toolpack. |
| `recordSignal(signal)` | Records a pending or closed signal through Suzumio support routes. |

## Controller Module

Controller modules run on the Suzumio controller side and access project state. Export `createControllerToolpack(context)` or a default factory. Return `{ support(tool, input) { ... } }`, `{ tools: { ... } }`, or a direct handler map.

```js
export function createControllerToolpack(context) {
  return {
    async support(tool, input) {
      context.recordSignal({
        kind: "review.summarized",
        targetAgent: "pm",
        priority: "P2",
        payload: { summary: input.summary },
      });
      return { output: `Handled ${tool}.` };
    },
  };
}
```

Controller handler output is `{ output, title?, metadata? }`.

Controller context fields:

| Field | Description |
|-------|-------------|
| `store` | Project store for SQLite-backed state. |
| `agent` | Current agent record. |
| `activationId` | Current activation id. |
| `recordSignal(signal)` | Creates pending schedulable work or records a closed useful effect. |

`callSupport` verifies token, activation ownership, toolpack membership, and the agent allowlist before invoking controller support.

## Scheduler Hooks

Local controller modules can export `schedulerTick(context)` or `createSchedulerToolpack(context)`. The core scheduler calls these hooks once per running project tick after delivering existing pending signals and before built-in nudge/monitor rules.

```js
export async function schedulerTick(context) {
  if (context.agents.some((agent) => agent.id === "pm" && agent.modelAlive)) return [];
  return [{ kind: "plan.continuation_nudge", targetAgent: "pm", priority: "P2", payload: { message: "Continue the active plan." }, usefulEffect: false }];
}
```

Scheduler context includes `store`, `project`, `toolpackId`, `now`, `agents`, `recordSignal`, `hasPendingSignals`, and `hasPendingSignalsForAgent`. Each `agents` entry includes `id`, `displayName`, `role`, `status`, `activeActivationId`, `updatedAt`, and `modelAlive`. Hooks may return signal requests or directly use trusted controller-side store APIs such as `store.sendMessage`.

## WebUI Registration

Toolpacks can register user-facing controls in the WebUI without writing browser code. The server exposes the registered entries through `GET /api/projects/:project/tool-ui`, and the WebUI Tools panel renders them as generic panels or action forms.

```json
{
  "webui": [
    {
      "id": "review.stats",
      "title": "Review statistics",
      "kind": "panel"
    },
    {
      "id": "review.rebuild",
      "title": "Rebuild review cache",
      "kind": "action",
      "submitLabel": "Rebuild",
      "inputSchema": {
        "type": "object",
        "properties": {
          "scope": { "type": "string", "enum": ["all", "recent"], "default": "recent" }
        }
      }
    }
  ]
}
```

Built-in toolpacks register these WebUI controls when enabled in `tools.toolpacks`:

| Toolpack | WebUI entry | Purpose |
|----------|-------------|---------|
| `core` | `project.stats` | Project, agent, message, activation, history, and tool-call counts. |
| `core` | `messages.conversation` | View direct conversation history between two participants. |
| `core` | `messages.send` | Send a user-facing message to an agent or channel. |
| `core` | `coordination.signals` | Inspect pending, delivered, and closed scheduler signals. |
| `core` | `completion.report` | Show `completion.submit` status and the submitted report path/content. |
| `core` | `file.activity` | Aggregate file.read, file.write, and file.patch calls without exposing file contents. |
| `shell` | `shell.activity` | Aggregate shell.exec calls, recent commands, failures, and running commands. |
| `web` | `web.activity` | Aggregate web.fetch calls, recent URLs, failures, and running fetches. |

The built-in controls are rendered in the WebUI's per-tool workspace. Agent-facing fields in those controls are dropdowns populated from the current project roster: `sender`, `recipient`, `agentA`, `agentB`, and `targetAgent`. Free-form text remains available for message bodies, channels, paths, and other values that are not known from the project summary.

The controller module handles WebUI entries by exporting `createWebuiToolpack(context)`, a `webui` handler map, or a default handler map. Handlers return the same `{ output, title?, metadata? }` shape as tool support handlers.

```js
export function createWebuiToolpack(context) {
  return {
    webui: {
      "review.stats": async () => {
        const stats = context.store.projectStats();
        return { output: JSON.stringify(stats, null, 2), metadata: { stats } };
      },
    },
  };
}
```

WebUI handlers run on the controller side and are user-facing project APIs, not model-facing tools. They do not require an agent activation token. Treat local toolpacks as trusted code and do not expose Suzumio's HTTP server to untrusted networks.

## Recording Signals

Custom tools use `recordSignal` to connect tool execution back to scheduling.

```js
context.recordSignal({
  kind: "review.ready",
  targetAgent: "pm",
  priority: "P1",
  payload: { artifact: "/artifacts/reviewer/report.md" },
});
```

| Signal shape | Scheduler result |
|--------------|------------------|
| `targetAgent` set | Creates pending work for that agent. |
| `targetChannel` set | Creates pending channel work. |
| No target and `usefulEffect: true` | Records a closed useful effect without waking an agent. |
| No target and no useful effect | Records an audit event without scheduling work. |

## Validation Checklist

| Check | Command or location |
|-------|---------------------|
| Project config renders. | `suzumio config render project.yaml` |
| Toolpack path resolves under the config directory. | Rendered `tools.toolpacks` output. |
| Manifest id matches configured id. | `suzumio.toolpack.json` and YAML. |
| Tool name is unique across registered toolpacks. | Toolpack resolution during activation startup, support calls, or WebUI tool loading. |
| WebUI entry has a controller-side handler. | Open the Tools panel or call `POST /api/projects/:project/tool-ui/:toolpack/:entry`. |
| Agent allowlist includes the tool. | `agents.<id>.tools` in YAML. |
| Runner module is ESM `.mjs`. | Toolpack directory. |
| Controller support returns `{ output }`. | Toolpack tests or a local activation. |

<div class="footer">Next: <a href="cli.html">CLI Reference</a>.</div>
