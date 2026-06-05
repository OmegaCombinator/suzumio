---
title: "Suzumio Toolpacks"
eyebrow: "Toolpacks"
heroTitle: "Register tools, then allowlist them per agent"
lead: "Toolpacks define model-visible tools. Project config registers toolpacks, and each agent config allowlists the registered tools it can call."
---

## Project Registration

```yaml
tools:
  toolpacks:
    - core
    - shell
    - web
```

`tools.toolpacks` registers available tool definitions for the project. `agents.<id>.tools` is the per-agent allowlist. A tool listed in an agent allowlist still fails when no registered toolpack provides it.

Agent allowlists support exact names, namespace wildcards such as `file.*`, and `*`.

## Built-in Toolpacks

| Toolpack | Registered tools | Execution |
|----------|------------------|-----------|
| `core` | `messages.send`, `coordination.wait_for_signal`, `completion.submit`, `file.read`, `file.write`, `file.patch` | Runner container + Suzumio support API |
| `shell` | `shell.exec` | Docker runner container |
| `web` | `web.fetch` | Docker runner container |

## File And Artifact Access

`file.read` reads from `/workspace`, `/artifacts`, or `/mnt`. `file.write` and `file.patch` write under `/workspace` or the current agent's own `/artifacts/<agent-id>` directory.

Mounted inputs are host files or directories exposed at configured container paths. Suzumio renders those paths into the activation prompt. The current agent's artifact directory is read-write; other agents' artifact directories are read-only.

Built-in file tools can be granted with `file.*` or exact names such as `file.read`, `file.write`, and `file.patch`.

## Local Toolpacks

Local toolpacks are directories on the controller host. They are mounted read-only into runner containers.

```yaml
tools:
  toolpacks:
    - core
    - path: ./toolpacks/review
      id: review-tools
```

Each local directory contains `suzumio.toolpack.json` and ESM `.mjs` modules:

```json
{
  "id": "review-tools",
  "runner": "runner.mjs",
  "controller": "controller.mjs",
  "tools": [
    {
      "name": "review.summarize",
      "description": "Summarize review findings.",
      "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
    }
  ]
}
```

The id contains only letters, digits, `.`, `_`, and `-`. HTTP(S) toolpack paths are rejected. Runtime TypeScript transpilation is not provided; modules are JavaScript `.mjs` files.

## Manifest Fields

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Toolpack id. It matches the optional config `id` when one is provided. |
| `runner` | No | Runner-side module path, relative to the toolpack root. Defaults to `runner.mjs`. |
| `controller` | No | Controller-side module path, relative to the toolpack root. Defaults to `controller.mjs`. |
| `tools` | Yes | Array of tool definitions with `name`, `description`, and JSON-schema-like `inputSchema`. |

Runner and controller module paths stay inside the toolpack directory, end in `.mjs`, and point to existing files. Duplicate toolpack ids and duplicate tool names across registered toolpacks are rejected.

## Runner Module

Runner modules implement model-facing tools in the container. Export `createRunnerToolpack(context)` or a default factory. Return a tool map directly or `{ tools: { ... } }`; every declared tool name has a handler. A runner handler receives model input and returns `{ output, title?, metadata? }`.

```js
export function createRunnerToolpack(context) {
  return {
    tools: {
      "review.ready": async (input) => {
        await context.recordSignal({
          kind: "review.ready",
          targetAgent: "pm",
          priority: "P1",
          payload: { summary: input.summary },
        });
        return { output: "PM notified." };
      },
    },
  };
}
```

Runner context fields are `project`, `agentId`, `activationId`, `workspace`, `toolpackId`, `callSupport(tool, input)`, and `recordSignal(signal)`.

`callSupport` invokes the controller module for the same toolpack after the controller verifies token, activation ownership, toolpack membership, and the agent allowlist.

## Controller Module

Controller modules implement support for tools that need project state. Export `createControllerToolpack(context)` or a default factory. Return `{ support(tool, input) { ... } }`, `{ tools: { ... } }`, or a direct handler map. A controller handler returns `{ output, title?, metadata? }`.

```js
export function createControllerToolpack(context) {
  return {
    async support(tool, input) {
      context.recordSignal({
        kind: "review.cached",
        payload: { cacheKey: input.cacheKey },
        usefulEffect: true,
      });
      return { output: `Handled ${tool}.` };
    },
  };
}
```

Controller context fields are `store`, `agent`, `activationId`, and `recordSignal(signal)`.

`recordSignal` can create pending schedulable work with `targetAgent` or `targetChannel`. With no target and `usefulEffect: true`, it records a closed useful effect without waking an agent.

<div class="footer">Next: <a href="cli.html">CLI Reference</a>.</div>
