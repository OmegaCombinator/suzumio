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

Local toolpacks 是 controller host 上的 directories。Suzumio 会把当前 agent 至少允许一个 model-facing tool 的 local toolpack read-only mount 到该 agent 的 runner container。WebUI-only toolpacks，以及被 agent allowlist 隐藏的 toolpacks，只留在 controller side。

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
| `id` | Yes | Toolpack id。如果 config 中也写了 `id`，两者必须一致。 |
| `runner` | No | Runner-side module path，相对 toolpack root。默认 `runner.mjs`。仅当 `tools` 非空时必须存在。 |
| `controller` | No | Controller-side module path，相对 toolpack root。默认 `controller.mjs`。 |
| `tools` | Yes | Tool definitions array，每个 definition 包含 `name`、`description` 和 JSON-schema-like `inputSchema`。 |
| `webui` | No | 可选 WebUI entries，显示在 Tools panel 中。每个 entry 包含 `id`、`title`、`kind`，以及可选 `description`、`inputSchema`、`submitLabel`。 |

Id 只包含 letters、digits、`.`、`_` 和 `-`。HTTP(S) toolpack paths 会被拒绝。Module paths 保持在 toolpack directory 内，并以 `.mjs` 结尾。Controller module 必须存在；声明 model-facing tools 时 runner module 也必须存在。重复 toolpack ids 和跨 registered toolpacks 的重复 tool names 会被拒绝。

Runtime 不提供 TypeScript transpilation。Toolpack modules 是 JavaScript ESM `.mjs` files。

## Packaged Scheduler Toolpack

仓库包含 `toolpacks/scheduler`，这是 local、非 kernel 的定时消息 toolpack。按 path 注册，并给允许创建/管理 schedule 的 agents 加 allowlist：

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

它提供 `schedule.once`、`schedule.recurring`、`schedule.list`、`schedule.cancel`，并在 WebUI 的 scheduler tool page 下提供 controls。Jobs 存在项目目录的 `toolpack-state/scheduler/jobs.json`。到期 job 会通过 project store 创建普通 message，默认 `P3`，并可设置 `waitForQuiet: true` 来等待 direct recipient 的 live model activation 结束。Weekly recurring jobs 使用 UTC `weekday` 和 `time`。

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

## Scheduler Hooks

Local controller modules 可以导出 `schedulerTick(context)` 或 `createSchedulerToolpack(context)`。Core scheduler 会在每个 running project tick 中调用这些 hooks，位置在已存在 pending signals 投递之后、内置 nudge/monitor rules 之前。

```js
export async function schedulerTick(context) {
  if (context.agents.some((agent) => agent.id === "pm" && agent.modelAlive)) return [];
  return [{ kind: "plan.continuation_nudge", targetAgent: "pm", priority: "P2", payload: { message: "Continue the active plan." }, usefulEffect: false }];
}
```

Scheduler context 包含 `store`、`project`、`toolpackId`、`now`、`agents`、`recordSignal`、`hasPendingSignals`、`hasPendingSignalsForAgent`。每个 `agents` entry 包含 `id`、`displayName`、`role`、`status`、`activeActivationId`、`updatedAt` 和 `modelAlive`。Hooks 可以返回 signal requests，也可以直接使用 trusted controller-side store APIs，例如 `store.sendMessage`。

## WebUI Registration

Toolpacks 可以注册 user-facing WebUI controls，不需要写 browser code。Server 通过 `GET /api/projects/:project/tool-ui` 暴露这些 entries，WebUI 的 Tools panel 会把它们渲染为通用 panel 或 action form。

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

启用对应 `tools.toolpacks` 后，内置 toolpacks 会注册这些 WebUI controls：

| Toolpack | WebUI entry | 用途 |
|----------|-------------|------|
| `core` | `project.stats` | Project、agent、message、activation、history 和 tool-call counts。 |
| `core` | `messages.conversation` | 查看两个 participants 之间的 direct conversation history。 |
| `core` | `messages.send` | 向 agent 或 channel 发送 user-facing message。 |
| `core` | `coordination.signals` | 查看 pending、delivered 和 closed scheduler signals。 |
| `core` | `completion.report` | 显示 `completion.submit` 状态，以及 submitted report path/content。 |
| `core` | `file.activity` | 聚合 file.read、file.write、file.patch 调用，不暴露 file contents。 |
| `shell` | `shell.activity` | 聚合 shell.exec 调用、recent commands、failures 和 running commands。 |
| `web` | `web.activity` | 聚合 web.fetch 调用、recent URLs、failures 和 running fetches。 |

这些内置 controls 会在 WebUI 的 per-tool workspace 中渲染。与 agent 相关的字段会用当前 project roster 填充下拉选择：`sender`、`recipient`、`agentA`、`agentB`、`targetAgent`。Message body、channel、path 等无法从 project summary 确定的值仍然是自由文本输入。

Controller module 可以导出 `createWebuiToolpack(context)`、`webui` handler map，或 default handler map 来处理 WebUI entries。Handler 返回值与 tool support handler 相同，都是 `{ output, title?, metadata? }`。

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

WebUI handlers 在 controller side 运行，是 user-facing project API，不是 model-facing tools。它们不需要 agent activation token。Local toolpacks 必须视为 trusted code，且不要把 Suzumio HTTP server 暴露到不可信网络。

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
| Tool name is unique across registered toolpacks. | Activation startup、support calls 或 WebUI tool loading 时的 toolpack resolution。 |
| WebUI entry has a controller-side handler. | 打开 Tools panel，或调用 `POST /api/projects/:project/tool-ui/:toolpack/:entry`。 |
| Agent allowlist includes the tool. | `agents.<id>.tools` in YAML. |
| Runner module is ESM `.mjs`. | Toolpack directory. |
| Controller support returns `{ output }`. | Toolpack tests or a local activation. |

<div class="footer">下一步：<a href="cli.html">CLI 参考</a>。</div>
