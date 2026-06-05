---
title: "Suzumio Toolpacks"
eyebrow: "Toolpacks"
heroTitle: "先注册工具，再按 agent 授权"
lead: "Toolpacks 定义模型可见工具。项目配置注册 toolpacks，每个 agent 配置 allowlist 决定它能调用哪些已注册工具。"
---

## 项目注册

```yaml
tools:
  toolpacks:
    - core
    - shell
    - web
```

`tools.toolpacks` 注册项目可用 tool definitions。`agents.<id>.tools` 是 per-agent allowlist。如果 agent allowlist 中写了某个工具，但没有任何已注册 toolpack 提供它，调用仍会失败。

Agent allowlist 支持精确名称、`file.*` 这类 namespace wildcard 和 `*`。

## 内置 Toolpacks

| Toolpack | 注册工具 | 执行位置 |
|----------|----------|----------|
| `core` | `messages.send`, `coordination.wait_for_signal`, `completion.submit`, `file.read`, `file.write`, `file.patch` | Runner container + Suzumio support API |
| `shell` | `shell.exec` | Docker runner container |
| `web` | `web.fetch` | Docker runner container |

## File 和 Artifact 访问

`file.read` 可以读取 `/workspace`、`/artifacts` 或 `/mnt`。`file.write` 和 `file.patch` 可以写入 `/workspace` 或当前 agent 自己的 `/artifacts/<agent-id>` 目录。

Mounted inputs 是通过配置暴露到容器路径的 host 文件或目录。Suzumio 会把这些路径渲染进 activation prompt。当前 agent 的 artifact 目录可写；其他 agent 的 artifact 目录只读。

内置 file tools 可以授权 `file.*`，也可以写精确名称如 `file.read`、`file.write`、`file.patch`。

## Local Toolpacks

Local toolpack 是 controller host 上的目录，会只读挂载进 runner containers。

```yaml
tools:
  toolpacks:
    - core
    - path: ./toolpacks/review
      id: review-tools
```

每个 local 目录包含 `suzumio.toolpack.json` 和 ESM `.mjs` 模块：

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

id 只包含字母、数字、`.`、`_` 和 `-`。HTTP(S) toolpack path 会被拒绝。Runtime 不提供 TypeScript transpilation；模块是 JavaScript `.mjs` 文件。

## Manifest 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | Toolpack id。如果配置里也写了 `id`，两者必须一致。 |
| `runner` | 否 | Runner-side module 路径，相对 toolpack root。默认 `runner.mjs`。 |
| `controller` | 否 | Controller-side module 路径，相对 toolpack root。默认 `controller.mjs`。 |
| `tools` | 是 | Tool definitions 数组，每个 definition 包含 `name`、`description` 和 JSON-schema-like `inputSchema`。 |

Runner 和 controller module 路径留在 toolpack 目录内，以 `.mjs` 结尾，并指向已有文件。重复 toolpack id 和跨已注册 toolpacks 的重复 tool name 会被拒绝。

## Runner Module

Runner module 在容器内实现模型可见工具。导出 `createRunnerToolpack(context)` 或 default factory。返回值可以直接是 tool map，也可以是 `{ tools: { ... } }`；manifest 中声明的每个 tool name 都有 handler。Runner handler 接收模型输入，返回 `{ output, title?, metadata? }`。

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

Runner context 字段包括 `project`、`agentId`、`activationId`、`workspace`、`toolpackId`、`callSupport(tool, input)` 和 `recordSignal(signal)`。

`callSupport` 会调用同一个 toolpack 的 controller module；controller 会先验证 token、activation ownership、toolpack membership 和 agent allowlist。

## Controller Module

Controller module 为需要项目状态的工具提供 support。导出 `createControllerToolpack(context)` 或 default factory。返回值可以是 `{ support(tool, input) { ... } }`、`{ tools: { ... } }` 或直接的 handler map。Controller handler 返回 `{ output, title?, metadata? }`。

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

Controller context 字段包括 `store`、`agent`、`activationId` 和 `recordSignal(signal)`。

`recordSignal` 设置 `targetAgent` 或 `targetChannel` 时创建 pending schedulable work。没有 target 且 `usefulEffect: true` 时，记录 closed useful effect，不唤醒 agent。

<div class="footer">下一步：<a href="cli.html">CLI 参考</a>。</div>
