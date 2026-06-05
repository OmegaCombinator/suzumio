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
    - path: ./toolpacks/review
      id: review-tools

agents:
  reviewer:
    tools:
      - messages.send
      - coordination.wait_for_signal
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
| `runner` | No | Runner-side module path, relative to the toolpack root. Defaults to `runner.mjs`. |
| `controller` | No | Controller-side module path, relative to the toolpack root. Defaults to `controller.mjs`. |
| `tools` | Yes | Array of tool definitions with `name`, `description`, and JSON-schema-like `inputSchema`. |

The id contains only letters, digits, `.`, `_`, and `-`. HTTP(S) toolpack paths are rejected. Module paths stay inside the toolpack directory, end in `.mjs`, and point to existing files. Duplicate toolpack ids and duplicate tool names across registered toolpacks are rejected.

Runtime TypeScript transpilation is not provided. Toolpack modules are JavaScript ESM `.mjs` files.

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
| Tool name is unique across registered toolpacks. | Config render validation. |
| Agent allowlist includes the tool. | `agents.<id>.tools` in YAML. |
| Runner module is ESM `.mjs`. | Toolpack directory. |
| Controller support returns `{ output }`. | Toolpack tests or a local activation. |

<div class="footer">Next: <a href="cli.html">CLI Reference</a>.</div>
