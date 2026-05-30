---
title: "Suzumio 架构"
eyebrow: "架构"
heroTitle: "Core 负责协调，Container 执行 activation。"
lead: "Suzumio 将 orchestration 与 execution 分离。核心进程拥有项目事实和调度；Docker runner 执行一个隔离 activation 后退出。"
---

## 层次图

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
      POSTs /activation-output with final text

## 核心进程

核心进程是项目级记录的权威来源。CLI、HTTP、WebUI 或审计日志需要看到的数据，都应通过 core store 写入 SQLite。

| 模块           | 职责                                                                                                                   |
|----------------|------------------------------------------------------------------------------------------------------------------------|
| `config.ts`    | 加载 YAML、解析 import、应用 `extends`、验证配置并渲染最终 YAML。                                                      |
| `store.ts`     | 创建和查询 projects、agents、messages、signals、activations、events、tool_calls 等 SQLite 表。                       |
| `scheduler.ts` | 实现 signal-driven 非抢占式调度规则。                                                                                  |
| `tools.ts`     | 解析 built-in 和 local toolpacks，并通过 token 与 allowlist 校验提供 controller support。                              |
| `server.ts`    | HTTP API、SSE stream、controller support route、activation result route 和静态 WebUI asset serving。                   |
| `webui/`       | Preact + Vite 浏览器 control room，构建后由 `/` 提供。                                                               |
| `backend.ts`   | Docker 容器创建、配置的 bind mounts、runner input 和 activation completion monitoring。                                |
| `runner.ts`    | 模型驱动 activation 的容器入口，并执行 runner-local tools。                                                            |

## Runner Contract

Runner 通过一个只读 input 文件接收上下文，并通过 HTTP 回传完成结果。这样执行层仍可替换，同时不会让模型可写文件成为 output authority。

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
    }

    type RunnerActivationOutput = {
      text: string
      usage?: Record<string, unknown>
    }

## Docker 隔离

每个 activation container 只获得明确的小环境：

- 只读 `/activation/input.json` bind mount。
- `/workspace` bind mount，作为 agent workspace。
- 按配置显式挂载到非保留 target 的 host 文件或目录。
- project、agent、activation、token 以及配置的 provider key 环境变量。
- `host.docker.internal` 映射，用于访问 host 上的 Suzumio support routes 和 `/activation-output`。

当前版本保留 completed containers 便于 early debugging。后续应把 cleanup policy 配置化。

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

模型默认不会获得任意 host tools。工具按 agent 配置。`shell.exec` 和 `web.fetch` 在 Docker runner 内执行；消息、completion 和 coordination 工具使用 Suzumio support API。

## Signal Delivery

Agent 不 poll 工作。Suzumio 把 pending signal 渲染进下一个 activation prompt，并记录哪个 activation 收到了哪些 signal。这样既避免 polling loop，也让调度决策可审计。

Message 会创建 `message.created` signal。Shared artifact 文件是普通持久文件，本身不会唤醒 agent。自定义 toolpack 可以调用 `recordSignal` 创建 pending 协调任务或 closed useful effect。

## SQLite 是项目事实

每个项目有一个 SQLite 文件。Container runner 不维护项目数据库；持久项目状态必须通过已鉴权 HTTP submit 或 controller support call 回到 core。

| 表              | 用途                                                          |
|-----------------|---------------------------------------------------------------|
| `projects`      | 项目状态、任务、resolved config JSON、submitted report path。 |
| `agents`        | Agent roster、prompt、tool allowlist、token、active activation。 |
| `messages`      | 直接消息和频道消息。                                          |
| `signals`       | Scheduler 输入、已投递 signal 记录和 useful effects。         |
| `activations`   | Activation 执行记录和 output text。                           |
| `events`        | Append-style event timeline。                                 |
| `tool_calls`    | Controller-supported tool call 记录。                         |

## 边界的价值

项目事实留在 core 中，agent execution 就可以是一次性的。Runner 可以失败、替换或升级，而项目数据库、消息历史、artifact 和用户控制面保持稳定。

<div class="footer">下一步：<a href="operations.html">运维</a>。</div>
