---
title: "Suzumio 核心概念"
eyebrow: "核心概念"
heroTitle: "Suzumio 如何组织工作"
lead: "Suzumio 把项目建模为持久消息、signal、每个 agent 的 history 和隔离 activation。Scheduler 只有在 agent 有 pending signal 时才开始工作，并用明确 priority 规则决定中断或延后。"
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
| `running` | 一个 Docker activation 正在运行，只有 `P0` 可以中断并重启它。 |
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
      priority: "P0" | "P1" | "P2"
      status: "pending" | "delivered" | "closed"
      usefulEffect: boolean
      payload: Record<string, unknown>
    }

| 状态        | 含义                                             |
|-------------|--------------------------------------------------|
| `pending`   | 等待在 activation start 或 tool boundary 投递给目标 agent。 |
| `delivered` | 已经 append 到某次 activation 的 agent history，不会再次投递。 |
| `closed`    | 不参与调度的审计或 effect 记录。                 |

带目标的 signal 不能显式 closed。要唤醒 agent 就创建 pending signal；只想记录 effect 而不唤醒任何人，就不要给 target，创建 closed signal。

## Priority

| Priority | 投递规则                                                      |
|----------|---------------------------------------------------------------|
| `P0`     | 如果目标正在运行，中断并取消当前 activation，然后把 signal 写入 agent history 并重启。 |
| `P1`     | 尽量在下一次 tool boundary 投递；如果没有 tool boundary，则在下一次 activation start 投递。 |
| `P2`     | 等当前 activation 完成后，在下一次 activation start 投递。    |

## Useful Effect

`usefulEffect` 记录 activation 的外部协调工作。Activation 完成时，Suzumio 会按 `sourceActivation` 统计 useful effect。

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

## Agent History

每个 agent 都有 append-only 模型历史，保存在 SQLite 中。Suzumio 会 append 已投递 signal 形成的 user prompt、可见 assistant 输出、tool call、tool result 和 compaction marker。Runner 下一次调用模型时会把 active history 重新传给模型。连续性存在 core runtime 中，而不是容器本地文件里。

当 provider 因 active history 超过 context window 而拒绝请求时，runner 会让模型生成 compact summary，并用 compacted history retry 当前 activation。Suzumio 会把 compact 前的完整 raw 范围本地归档，将这些消息标记为 archived，append 一个包含 summary 的 compaction marker，并保留最新 tail messages 原文。

## Signal Scheduler

默认 scheduler 是 `nonpreemptive-signals`。`nonpreemptive-mailbox` 仍作为兼容名称接受，但实际运行同一个 signal-driven scheduler。

1.  跳过非 `running` 项目。
2.  对 running agent，只有 pending `P0` 会触发动作：取消当前 activation 并用新 signal 重启。
3.  对 idle agent，按 priority 和创建时间读取 pending signals。
4.  没有 pending signal 时保持 quiet。
5.  有 pending signal 时，把一个 activation prompt append 到 agent history 并启动 activation。
6.  创建 activation 后把这些 signal 标记为 delivered。
7.  如果 running activation 期间来了 `P1`，尽量在下一次完成的 tool call 后投递。
8.  如果 activation 完成时没有 useful effect，就创建一次 `scheduler.no_effect_nudge`，但由 nudge 唤醒的 activation 不会继续无限 nudge。

## Tools

工具由 Docker runner 展示给模型。需要持久状态的工具会回调 Suzumio support API，用于消息、项目提交、权限检查和审计记录；file、shell 和 web tools 在 runner 容器内执行。

<div class="grid">

<div class="card"><h3><code>messages.send</code></h3><p>通过 Suzumio support API 创建直接或频道消息。</p></div>

<div class="card"><h3><code>coordination.wait_for_signal</code></h3><p>声明当前正在等待未来 signal。非 PM agent 默认通知 <code>pm</code>；PM 自己会安静等待。</p></div>

<div class="card"><h3><code>file.read</code></h3><p>读取 <code>/workspace</code>、<code>/artifacts</code> 或 <code>/mnt</code> 下的文件或目录。</p></div>

<div class="card"><h3><code>file.write</code></h3><p>在 <code>/workspace</code> 或当前 agent 自己的 artifact 目录下完整写入文件。</p></div>

<div class="card"><h3><code>file.patch</code></h3><p>在 <code>/workspace</code> 或当前 agent 自己的 artifact 目录下应用精确文本编辑。</p></div>

<div class="card"><h3><code>shell.exec</code></h3><p>在 Docker runner 容器内运行 bash。</p></div>

<div class="card"><h3><code>completion.submit</code></h3><p>写入最终报告并标记项目 submitted。</p></div>

<div class="card"><h3><code>web.fetch</code></h3><p>从 runner 容器内获取 HTTP(S) URL。</p></div>

</div>

## Shared Artifacts 和 Event

每个 activation 都会挂载 `/artifacts/<agent-id>`。当前 agent 的目录可写，其他 agent 的目录只读。第一次 activation prompt 会列出 artifact path；后续 activation 依赖持久化 agent history。这就是轻量 artifact 工作流：拥有 `shell.exec` 的 agent 可以直接把脚本、输出、笔记和数据写进自己的共享目录，然后发消息告诉其他 agent 路径。Event 是项目时间线，用于 WebUI、debug、审计和未来 replay 工具。

    project.initialized
    message.created
    signal.created
    activation.started
    tool.called
    activation.completed
    project.submitted

<div class="footer">下一步：<a href="configuration.html">配置</a>。</div>
