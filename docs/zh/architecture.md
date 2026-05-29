---
title: "Suzumio 架构"
eyebrow: "架构"
heroTitle: "Core 负责协调，Container 执行 turn。"
lead: "Suzumio 将 orchestration 与 execution 分离。核心进程拥有项目事实和调度；Docker runner 执行一个隔离 turn 后退出。"
---

## 层次图

    CLI / HTTP / WebUI
            |
            v
    Suzumio Core
      Config loader
      SQLite store
      Message router
      Artifact registry
      Tool support routes
      Non-preemptive scheduler
            |
            v
    Docker backend
      Creates turn input JSON
      Starts one container per turn
      Monitors container exit
            |
            v
    Container runner
      Reads /turn/input.json
      Runs AI mode
      Runs model-facing tools
      Calls Suzumio support routes for stateful tools
      POSTs /turn-output with final text

## 核心进程

核心进程是项目级记录的权威来源。CLI、HTTP、WebUI 或审计日志需要看到的数据，都应通过 core store 写入 SQLite。

| 模块           | 职责                                                                                                                   |
|----------------|------------------------------------------------------------------------------------------------------------------------|
| `config.ts`    | 加载 YAML、解析 import、应用 `extends`、验证配置并渲染最终 YAML。                                                      |
| `store.ts`     | 创建和查询 projects、agents、messages、reads、turns、events、controller-supported tool_calls、artifacts 等 SQLite 表。 |
| `scheduler.ts` | 实现 `nonpreemptive-mailbox` 调度规则。                                                                                |
| `tools.ts`     | 定义工具 metadata，并对 controller-supported tool call 做 token 和 allowlist 检查。                                    |
| `server.ts`    | HTTP API、SSE stream、controller support route、turn result route 和内嵌 WebUI。                                       |
| `backend.ts`   | Docker 容器创建、配置的 bind mounts、runner input 和 turn completion monitoring。                                      |
| `runner.ts`    | 模型驱动 turn 的容器入口，并执行 runner-local tools。                                                                  |

## Runner Contract

Runner 通过一个只读 input 文件接收全部上下文，并通过 HTTP 回传完成结果。这样执行层仍可替换，同时不会让模型可写文件成为 output authority。

    type RunnerTurnInput = {
      project: string
      agent: { id: string; role: string; prompt: string; model?: string }
      turn: { id: string; prompt: string }
      workspace: string
      controllerUrl: string
      token: string
      runner: RunnerConfig
      tools: ToolDefinition[]
    }

    type RunnerTurnOutput = {
      text: string
      usage?: Record<string, unknown>
    }

## Docker 隔离

每个 turn container 只获得明确的小环境：

- 只读 `/turn/input.json` bind mount。
- `/workspace` bind mount，作为 agent workspace。
- 按配置显式挂载到非保留 target 的 host 文件或目录。
- project、agent、turn、token 以及配置的 provider key 环境变量。
- `host.docker.internal` 映射，用于访问 host 上的 Suzumio support routes 和 `/turn-output`。

当前版本保留 completed containers 便于 early debugging。后续应把 cleanup policy 配置化。

## Tool Flow

    Model asks for tool
      runner converts model tool call
      if the tool is runner-local:
        runner executes it inside the Docker container
      if the tool needs project state:
        runner POSTs /tool to Suzumio
        controller verifies token and tool allowlist
        controller updates SQLite, messages, artifacts, or submission state
      runner returns tool output to model

模型默认不会获得任意 host tools。工具按 agent 配置。`shell.exec` 和 `web.fetch` 在 Docker runner 内执行；消息、artifact 和 completion 工具使用 Suzumio support API。

## SQLite 是项目事实

每个项目有一个 SQLite 文件。Container runner 不维护项目数据库；持久项目状态必须通过已鉴权 HTTP submit 或 controller support call 回到 core。

| 表              | 用途                                                          |
|-----------------|---------------------------------------------------------------|
| `projects`      | 项目状态、任务、resolved config JSON、submitted report path。 |
| `agents`        | Agent roster、prompt、tool allowlist、token、active turn。    |
| `messages`      | 直接消息和频道消息。                                          |
| `message_reads` | 哪个 turn 消费了哪个 inbound message。                        |
| `turns`         | Turn 执行记录和 output text。                                 |
| `events`        | Append-style event timeline。                                 |
| `tool_calls`    | Controller-supported tool call 记录。                         |
| `artifacts`     | 带 hash 和 metadata 的已发布文件。                            |

## 边界的价值

项目事实留在 core 中，agent execution 就可以是一次性的。Runner 可以失败、替换或升级，而项目数据库、消息历史、artifact 和用户控制面保持稳定。

<div class="footer">下一步：<a href="operations.html">运维</a>。</div>
