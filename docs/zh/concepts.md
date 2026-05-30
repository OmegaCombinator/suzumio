---
title: "Suzumio 核心概念"
eyebrow: "核心概念"
heroTitle: "Suzumio 如何组织工作"
lead: "Suzumio 把项目建模为持久消息、signal 和隔离 activation。Scheduler 很保守：只有当智能体有 pending signal 时才开始工作，并且不会打断正在运行的智能体。"
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

Agent 是带 role、prompt、model、workspace 和 tool allowlist 的参与者。Agent 不拥有项目状态；它通过 Suzumio 产生消息、工具调用、artifact 和 activation output。

| 状态      | 含义                                                  |
|-----------|-------------------------------------------------------|
| `quiet`   | 空闲且没有 pending signal。                           |
| `running` | 一个 Docker activation 正在运行，scheduler 不能 prompt 它。 |
| `failed`  | 上一次 activation 或 backend 操作失败。                     |
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
      sourceActivation?: string
      targetAgent?: string
      targetChannel?: string
      priority: "P0" | "P1" | "P2" | "P3"
      status: "pending" | "delivered" | "closed"
      usefulEffect: boolean
      payload: Record<string, unknown>
    }

| 状态        | 含义                                             |
|-------------|--------------------------------------------------|
| `pending`   | 等待渲染进目标 agent 的下一个 activation prompt。 |
| `delivered` | 已经渲染进一个 activation prompt，不会再次投递。  |
| `closed`    | 不参与调度的审计或 effect 记录。                 |

带目标的 signal 不能显式 closed。要唤醒 agent 就创建 pending signal；只想记录 effect 而不唤醒任何人，就不要给 target，创建 closed signal。

## Useful Effect

`usefulEffect` 回答一个问题：这个 activation 有没有做足够的外部协调工作，从而不应该被自动催促？Activation 完成时，Suzumio 会按 `sourceActivation` 统计 useful effect。

| Signal kind                         | 默认 useful effect | 原因                                                |
|-------------------------------------|--------------------|-----------------------------------------------------|
| 给其他 agent 的 pending signal      | 是                 | 它安排了后续工作。                                  |
| `message.created`                   | 是                 | 它和 agent 或用户进行了沟通。                       |
| `completion.submitted`              | 是                 | 它把最终报告交给用户。                              |
| `coordination.wait_for_signal`      | 是                 | 它记录了明确的等待状态。                            |
| `scheduler.no_effect_nudge`         | 否                 | 这是 scheduler 反馈，不是 agent 进展。              |
| generic closed custom signal        | 否                 | 自定义工具需要时可显式设置 `usefulEffect: true`。   |

## Activation

Activation 是一个连续 agent 的一次隔离执行。Suzumio 创建 activation record，写入只读 `input.json`，启动 Docker 容器，通过 `POST /activation-output` 接收完成结果，并记录成功或失败。

    activation.started -> container runs -> POST /activation-output -> activation.completed

## Signal Scheduler

默认 scheduler 是 `nonpreemptive-signals`。`nonpreemptive-mailbox` 仍作为兼容名称接受，但实际运行同一个 signal-driven scheduler。

1.  跳过非 `running` 项目。
2.  跳过已经 `running` 的 agent。
3.  按 priority 和创建时间读取每个 idle agent 的 pending signals。
4.  没有 pending signal 时保持 quiet。
5.  有 pending signal 时渲染一个 prompt 并启动一个 activation。
6.  创建 activation 后把这些 signal 标记为 delivered。
7.  如果 activation 完成时没有 useful effect，就创建一次 `scheduler.no_effect_nudge`，但由 nudge 唤醒的 activation 不会继续无限 nudge。

## Tools

工具由 Docker runner 展示给模型。需要持久状态的工具会回调 Suzumio support API，用于消息、项目提交、权限检查和审计记录；`shell`、`web.fetch` 这类 local tools 在 runner 容器内执行。

<div class="grid">

<div class="card"><h3><code>messages.send</code></h3><p>通过 Suzumio support API 创建直接或频道消息。</p></div>

<div class="card"><h3><code>coordination.wait_for_signal</code></h3><p>声明当前正在等待未来 signal。非 PM agent 默认通知 <code>pm</code>；PM 自己会安静等待。</p></div>

<div class="card"><h3><code>shell.exec</code></h3><p>在 Docker runner 容器内运行 bash。</p></div>

<div class="card"><h3><code>completion.submit</code></h3><p>写入最终报告并标记项目 submitted。</p></div>

<div class="card"><h3><code>web.fetch</code></h3><p>从 runner 容器内获取 HTTP(S) URL。</p></div>

</div>

## Shared Artifacts 和 Event

每个 activation 都会挂载 `/artifacts/<agent-id>`。当前 agent 的目录可写，其他 agent 的目录只读。第一次 activation prompt 会列出 artifact path；后续 activation 依赖 agent 的连续上下文。这就是轻量 artifact 工作流：拥有 `shell.exec` 的 agent 可以直接把脚本、输出、笔记和数据写进自己的共享目录，然后发消息告诉其他 agent 路径。Event 是项目时间线，用于 WebUI、debug、审计和未来 replay 工具。

    project.initialized
    message.created
    signal.created
    activation.started
    tool.called
    activation.completed
    project.submitted

<div class="footer">下一步：<a href="configuration.html">配置</a>。</div>
