---
title: "Suzumio Custom Tools"
eyebrow: "Custom Tools"
heroTitle: "用 local toolpacks 添加项目工具"
lead: "Tools 在 project level 注册，并按 agent allowlist 授权。Built-ins 覆盖 messaging、waiting、submission、file access、shell 和 web fetch；local toolpacks 添加 project-specific model-facing tools。"
---

## Registration 和 Allowlists

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

`tools.toolpacks` 注册 tool definitions。`agents.<id>.tools` 决定 agent 可以看到哪些已注册 tools。Agent allowlists 支持 exact names、`file.*` 这类 namespace wildcards 和 `*`。

## Built-In Toolpacks

| Toolpack | Registered tools | Execution |
|----------|------------------|-----------|
| `core` | `messages.send`, `coordination.wait_for_signal`, `completion.submit`, `file.read`, `file.write`, `file.patch` | Runner container + Suzumio support API |
| `shell` | `shell.exec` | Docker runner container |
| `web` | `web.fetch` | Docker runner container |

`file.read` 可以读取 `/workspace`、`/artifacts` 或 `/mnt`。`file.write` 和 `file.patch` 可以写入 `/workspace` 或当前 agent 自己的 `/artifacts/<agent-id>` directory。

Mounted inputs 是通过配置暴露到 container paths 的 host files 或 directories。当前 agent 的 artifact directory 可写；其他 agents 的 artifact directories 只读。

## Local Toolpack Layout

```text
toolpacks/review/
  suzumio.toolpack.json
  runner.mjs
  controller.mjs
```

Local toolpacks 是 controller host 上的 directories。Suzumio 会把它们 read-only mount 到 runner containers。

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
| `id` | Yes | Toolpack id。如果 config 中也写了 `id`，两者必须一致。 |
| `runner` | No | Runner-side module path，相对 toolpack root。默认 `runner.mjs`。 |
| `controller` | No | Controller-side module path，相对 toolpack root。默认 `controller.mjs`。 |
| `tools` | Yes | Tool definitions array，每个 definition 包含 `name`、`description` 和 JSON-schema-like `inputSchema`。 |

Id 只包含 letters、digits、`.`、`_` 和 `-`。HTTP(S) toolpack paths 会被拒绝。Module paths 保持在 toolpack directory 内，以 `.mjs` 结尾，并指向已有文件。重复 toolpack ids 和跨 registered toolpacks 的重复 tool names 会被拒绝。

Runtime 不提供 TypeScript transpilation。Toolpack modules 是 JavaScript ESM `.mjs` files。

## Runner Module

Runner modules 在 container 内实现 model-facing tools。导出 `createRunnerToolpack(context)` 或 default factory。返回 direct tool map 或 `{ tools: { ... } }`。Manifest 中声明的每个 tool name 都有 handler。

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

Runner handler input 是 model-provided JSON。Runner handler output 是 `{ output, title?, metadata? }`。

Runner context fields:

| Field | Description |
|-------|-------------|
| `project` | Project id。 |
| `agentId` | Current agent id。 |
| `activationId` | Current activation id。 |
| `workspace` | Container workspace path。 |
| `toolpackId` | Current toolpack id。 |
| `callSupport(tool, input)` | 调用该 toolpack 的 controller module。 |
| `recordSignal(signal)` | 通过 Suzumio support routes 记录 pending 或 closed signal。 |

## Controller Module

Controller modules 在 Suzumio controller side 运行并访问 project state。导出 `createControllerToolpack(context)` 或 default factory。返回 `{ support(tool, input) { ... } }`、`{ tools: { ... } }` 或 direct handler map。

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

Controller handler output 是 `{ output, title?, metadata? }`。

Controller context fields:

| Field | Description |
|-------|-------------|
| `store` | SQLite-backed project store。 |
| `agent` | Current agent record。 |
| `activationId` | Current activation id。 |
| `recordSignal(signal)` | 创建 pending schedulable work 或记录 closed useful effect。 |

`callSupport` 会先验证 token、activation ownership、toolpack membership 和 agent allowlist，再调用 controller support。

## Recording Signals

Custom tools 用 `recordSignal` 把 tool execution 接回 scheduler。

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
| 设置 `targetAgent` | 为该 agent 创建 pending work。 |
| 设置 `targetChannel` | 创建 pending channel work。 |
| 无 target 且 `usefulEffect: true` | 记录 closed useful effect，不唤醒 agent。 |
| 无 target 且无 useful effect | 记录 audit event，不调度 work。 |

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

<div class="footer">下一步：<a href="cli.html">CLI 参考</a>。</div>
