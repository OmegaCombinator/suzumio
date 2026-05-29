---
title: "Suzumio 核心概念"
eyebrow: "核心概念"
heroTitle: "Suzumio 如何组织工作"
lead: "Suzumio 把项目建模为持久消息和隔离 turn。Scheduler 很保守：只有当智能体有 inbound message 时才开始工作，并且不会打断正在运行的智能体。"
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
| `quiet`   | 空闲且没有 unread inbound message。                   |
| `running` | 一个 Docker turn 正在运行，scheduler 不能 prompt 它。 |
| `failed`  | 上一次 turn 或 backend 操作失败。                     |
| `stopped` | 该 agent 被禁用。                                     |

## Message

Message 是唤醒 agent 的正常方式。可以是带 `recipient` 的直接消息，也可以是带 `channel` 的频道消息。

    {
      "sender": "user",
      "recipient": "pm",
      "priority": "P1",
      "body": "Start the project."
    }

只有当消息被写入某个 agent 的 turn prompt 时，才会对该 agent 变成 read。

## Turn

Turn 是一个 agent 的一次隔离执行。Suzumio 创建 turn record，写入只读 `input.json`，启动 Docker 容器，通过 `POST /turn-output` 接收完成结果，并记录成功或失败。

    turn.started -> container runs -> POST /turn-output -> turn.completed

## Mailbox Scheduler

默认 scheduler 是 `nonpreemptive-mailbox`。

1.  跳过非 `running` 项目。
2.  跳过已经 `running` 的 agent。
3.  为每个 idle agent 获取 unread inbound messages。
4.  没有 unread message 时保持 quiet。
5.  有 unread message 时渲染一个 prompt 并启动一个 turn。
6.  不创建 heartbeat、status prompt 或自动提醒。

## Tools

工具由 Docker runner 展示给模型。需要持久状态的工具会回调 Suzumio support API，用于消息、artifact registry、项目提交、权限检查和审计记录；`shell`、`web.fetch` 这类 local tools 在 runner 容器内执行。

<div class="grid">

<div class="card"><h3><code>messages.send</code></h3><p>通过 Suzumio support API 创建直接或频道消息。</p></div>

<div class="card"><h3><code>artifacts.publish</code></h3><p>把 workspace 文件或目录注册为持久 artifact。</p></div>

<div class="card"><h3><code>artifacts.list</code></h3><p>返回已发布 artifact。</p></div>

<div class="card"><h3><code>artifacts.read</code></h3><p>按 id 或 name 读取文本文件 artifact。</p></div>

<div class="card"><h3><code>shell.exec</code></h3><p>在 Docker runner 容器内运行 bash。</p></div>

<div class="card"><h3><code>completion.submit</code></h3><p>写入最终报告并标记项目 submitted。</p></div>

<div class="card"><h3><code>web.fetch</code></h3><p>从 runner 容器内获取 HTTP(S) URL。</p></div>

</div>

## Artifact 和 Event

Artifact 是从 agent workspace 发布的文件或目录，记录 id、creator、turn、路径、hash 和描述。Event 是项目时间线，用于 WebUI、debug、审计和未来 replay 工具。

    project.initialized
    message.created
    turn.started
    tool.called
    artifact.published
    turn.completed
    project.submitted

<div class="footer">下一步：<a href="configuration.html">配置</a>。</div>
