---
title: "Suzumio 核心概念"
eyebrow: "核心概念"
heroTitle: "Suzumio 如何组织工作"
lead: "Suzumio 把项目建模为持久消息、signal 和隔离 turn。Scheduler 很保守：只有当智能体有 pending signal 时才开始工作，并且不会打断正在运行的智能体。"
---

## Project

Project 是持久工作单元，包含名称、任务描述、解析后的配置、agent roster、channel、SQLite 数据库、artifact 目录和事件时间线。

| 状态          | 调度行为                         | 常见来源                             |
|---------------|----------------------------------|--------------------------------------|
| `initialized` | 不调度。                         | `suzumio init`                       |
| `running`     | Scheduler 可以启动 ready agent。 | `suzumio start` 或 request changes。 |
| `submitted`   | 等待用户审批。                   | `completion.submit`                  |
| `completed`   | 不再调度。                       | `suzumio approve`                    |
| `stopped`     | 调度关闭。                       | `suzumio stop`                       |

## Agent

Agent 是带 role、prompt、model、workspace 和 tool allowlist 的参与者。Agent 不拥有项目状态；它通过 Suzumio 产生消息、工具调用、artifact 和 turn output。

| 状态      | 含义                                                  |
|-----------|-------------------------------------------------------|
| `quiet`   | 空闲且没有 pending signal。                           |
| `running` | 一个 Docker turn 正在运行，scheduler 不能 prompt 它。 |
| `failed`  | 上一次 turn 或 backend 操作失败。                     |
| `stopped` | 该 agent 被禁用。                                     |

## Message

Message 是持久沟通记录。可以是带 `recipient` 的直接消息，也可以是带 `channel` 的频道消息。未知 recipient 和未声明 channel 都会被拒绝。

    {
      "sender": "user",
      "recipient": "pm",
      "priority": "P1",
      "body": "Start the project."
    }

Message 会创建 `message.created` signal。发给 agent 的直接消息会创建一条给该 agent 的 pending signal；频道消息会 fan out 成给其他 agent 的 pending signal。发给 `recipient: "user"` 的消息是 closed useful effect，用户能看到，但不会唤醒 agent。

## Signal

Signal 同时是 scheduler 输入和 effect ledger。带 `targetAgent` 且 `status: "pending"` 的 signal 可以唤醒该 agent；closed signal 没有目标，只用于审计、useful-effect 统计，或两者兼有。

    type SignalRecord = {
      kind: string
      sourceAgent?: string
      sourceTurn?: string
      targetAgent?: string
      targetChannel?: string
      priority: "P0" | "P1" | "P2" | "P3"
      status: "pending" | "delivered" | "closed"
      usefulEffect: boolean
      payload: Record<string, unknown>
    }

| 状态        | 含义                                             |
|-------------|--------------------------------------------------|
| `pending`   | 等待渲染进目标 agent 的下一个 turn prompt。      |
| `delivered` | 已经渲染进一个 turn prompt，不会再次投递。       |
| `closed`    | 不参与调度的审计或 effect 记录。                 |

带目标的 signal 不能显式 closed。要唤醒 agent 就创建 pending signal；只想记录 effect 而不唤醒任何人，就不要给 target，创建 closed signal。

## Useful Effect

`usefulEffect` 回答一个问题：这个 turn 有没有做足够的外部协调工作，从而不应该被自动催促？Turn 完成时，Suzumio 会按 `sourceTurn` 统计 useful effect。

| Signal kind                         | 默认 useful effect | 原因                                                |
|-------------------------------------|--------------------|-----------------------------------------------------|
| 给其他 agent 的 pending signal      | 是                 | 它安排了后续工作。                                  |
| `message.created`                   | 是                 | 它和 agent 或用户进行了沟通。                       |
| `completion.submitted`              | 是                 | 它把最终报告交给用户。                              |
| `coordination.no_valuable_work`     | 是                 | 它记录了明确的等待状态。                            |
| `artifact.published`                | 否                 | 只发布 artifact 不会通知任何人，需要再发消息交接。  |
| `scheduler.no_effect_nudge`         | 否                 | 这是 scheduler 反馈，不是 agent 进展。              |
| generic closed custom signal        | 否                 | 自定义工具需要时可显式设置 `usefulEffect: true`。   |

## Turn

Turn 是一个 agent 的一次隔离执行。Suzumio 创建 turn record，写入只读 `input.json`，启动 Docker 容器，通过 `POST /turn-output` 接收完成结果，并记录成功或失败。

    turn.started -> container runs -> POST /turn-output -> turn.completed

## Signal Scheduler

默认 scheduler 是 `nonpreemptive-signals`。`nonpreemptive-mailbox` 仍作为兼容名称接受，但实际运行同一个 signal-driven scheduler。

1.  跳过非 `running` 项目。
2.  跳过已经 `running` 的 agent。
3.  按 priority 和创建时间读取每个 idle agent 的 pending signals。
4.  没有 pending signal 时保持 quiet。
5.  有 pending signal 时渲染一个 prompt 并启动一个 turn。
6.  创建 turn 后把这些 signal 标记为 delivered。
7.  如果 turn 完成时没有 useful effect，就创建一次 `scheduler.no_effect_nudge`，但由 nudge 唤醒的 turn 不会继续无限 nudge。

## Tools

工具由 Docker runner 展示给模型。需要持久状态的工具会回调 Suzumio support API，用于消息、artifact registry、项目提交、权限检查和审计记录；`shell`、`web.fetch` 这类 local tools 在 runner 容器内执行。

<div class="grid">

<div class="card"><h3><code>messages.send</code></h3><p>通过 Suzumio support API 创建直接或频道消息。</p></div>

<div class="card"><h3><code>coordination.no_valuable_work</code></h3><p>声明当前没有有价值的工作可做。非 PM agent 默认通知 <code>pm</code>；PM 自己会安静等待。</p></div>

<div class="card"><h3><code>artifacts.publish</code></h3><p>把 workspace 文件或目录注册为持久 artifact。</p></div>

<div class="card"><h3><code>artifacts.list</code></h3><p>返回已发布 artifact。</p></div>

<div class="card"><h3><code>artifacts.read</code></h3><p>按 id 或 name 读取文本文件 artifact。</p></div>

<div class="card"><h3><code>shell.exec</code></h3><p>在 Docker runner 容器内运行 bash。</p></div>

<div class="card"><h3><code>completion.submit</code></h3><p>写入最终报告并标记项目 submitted。</p></div>

<div class="card"><h3><code>web.fetch</code></h3><p>从 runner 容器内获取 HTTP(S) URL。</p></div>

</div>

## Artifact 和 Event

Artifact 是从 agent workspace 发布的文件或目录，记录 id、creator、turn、路径、hash 和描述。发布 artifact 是持久存储，不是沟通；如果希望其他参与者处理它，agent 应该再发送消息或提交 completion。Event 是项目时间线，用于 WebUI、debug、审计和未来 replay 工具。

    project.initialized
    message.created
    signal.created
    turn.started
    tool.called
    artifact.published
    turn.completed
    project.submitted

<div class="footer">下一步：<a href="configuration.html">配置</a>。</div>
