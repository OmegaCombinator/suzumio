---
title: "Suzumio Signal 调度"
eyebrow: "Signal 调度"
heroTitle: "Signal 如何驱动每一次 activation"
lead: "Suzumio 从持久 signal 调度 agent。消息、等待、提交、nudge 和自定义工具都会写入 SQLite，scheduler 把 pending targeted signals 变成 Docker activations。"
---

## Runtime Objects

| Object | Runtime 角色 |
|--------|--------------|
| Project | 持久工作单元，包含 resolved YAML、agent roster、channels、SQLite database、artifacts 和 event timeline。 |
| Agent | 配置好的参与者，包含 role、prompt、model selection、workspace、artifact directory、token 和 tool allowlist。 |
| Message | 持久通信记录。Direct message 指向一个 agent 或 `user`；channel message fan out 到 agents。 |
| Signal | Scheduler 输入和 effect ledger。Pending targeted signal 唤醒 agent；closed signal 记录 effect。 |
| Activation | 一个 agent 的一次隔离 Docker 执行。Activation prompt 中包含 delivered signals。 |
| Event | Append-style timeline entry，用于 UI、audit、debug 和 replay tooling。 |

## Project 和 Agent 状态

| Project status | 调度行为 |
|----------------|----------|
| `initialized` | 不自动调度。 |
| `running` | Scheduler 可以启动 ready agents。 |
| `submitted` | Project 等待用户 approval。 |
| `completed` | 调度完成。 |
| `stopped` | 调度禁用。 |

| Agent status | 调度行为 |
|--------------|----------|
| `quiet` | 有 pending targeted signals 时可启动新 activation。 |
| `running` | 有 active activation。`P0` 可 interrupt；`P1` 可在 tool boundary 注入；`P2` 和 `P3` 等待。 |
| `failed` | 上一次 activation 或 backend action 失败。 |
| `stopped` | Agent 禁用。 |

## Message 变成 Signal

`messages.send` 会写入 message row，append `message.created` event，并记录一个或多个 signals。

```json
{
  "sender": "user",
  "recipient": "pm",
  "priority": "P1",
  "body": "Start the project."
}
```

| Message target | Signal result |
|----------------|---------------|
| `recipient: "pm"` | 给 `pm` 创建一个 pending `message.created` signal。 |
| `channel: "#reviews"` | 给 config 中的其他 agents 各创建一个 pending `message.created` signal。 |
| `recipient: "user"` | Closed useful effect；不唤醒 agent。 |

未知 recipient 和未声明 channel 会被拒绝。

## Signal Shape

```ts
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
```

| Status | 含义 |
|--------|------|
| `pending` | 等待在 activation start 或 tool boundary 投递给 target agent。 |
| `delivered` | 已 append 到某次 activation 的 agent history，不会再次投递。 |
| `closed` | 不参与调度的 audit 或 useful-effect 记录。 |

唤醒 agent 时创建带 `targetAgent` 的 pending signal。只记录 effect 时省略 `targetAgent` 和 `targetChannel`，创建 closed signal。

## Priority Rules

| Priority | 投递规则 |
|----------|----------|
| `P0` | Interrupt running target agent。当前 activation 被取消，agent 带着 `P0` signal 重启。 |
| `P1` | 尽量在下一次 tool boundary 投递；没有 boundary 时在下一次 activation start 投递。 |
| `P2` | Control-flow 或 continuation work。等待当前 activation 完成，并在下一次 activation start 优先于 routine backlog 投递。 |
| `P3` | Routine queued work。等待当前 activation 完成，并在所有 pending `P2` 之后投递。 |

Routine messages 默认使用 `P3`。`P2` 用于 plan-continuation nudges、scheduler control messages，以及其他应优先于普通 backlog 的工作。`P0` 保留给 human stop、destructive repository conflict、secret/safety issue，或继续当前 activation 会有害的 blocker。

## Activation Start

对于 running project，scheduler 会检查 agent roster。Quiet agent 有 pending targeted signals 时获得一次 activation。

1. 按 priority 和创建时间加载该 agent 的 pending signals。
2. 渲染 activation prompt，包含当前 delivered signals 和 tool/reporting contract。
3. 把 prompt append 到 agent 的 SQLite history。
4. 将这些 signals 标记为 `delivered`，并记录 activation id。
5. 创建 activation row，写入只读 `input.json`。
6. 启动一个 Docker runner container。

Activation prompt 是新 delivered signals 对模型可见的位置。Earlier model history 用于 continuity；新的 assignments 来自 delivered signals。

## Running Agent Behavior

Agent 已经 running 时，scheduler 不会为它启动第二个 activation。

| Incoming signal | Running-agent 行为 |
|-----------------|--------------------|
| `P0` | Cancel 当前 activation，停止 backend container，带 pending `P0` 和 `P1` signals 重启。 |
| `P1` | 当前 activation 继续运行。如果 runner 到达 tool boundary，则在下一次完成 tool call 后投递。 |
| `P2` | 当前 activation 继续运行。当前 activation 完成后的下一次 activation 投递，优先于 `P3`。 |
| `P3` | 当前 activation 继续运行。当前 activation 完成后的下一次 activation 投递，排在 pending `P2` 之后。 |

Runner 在完成 tool call 后向 Suzumio 请求 tool-boundary signal delivery。Pending `P1` signals 会在该 boundary append 到 active model context。

## Useful Effects 和 Nudges

`usefulEffect` 记录 activation 的外部协调工作。Activation 完成时，Suzumio 按 `sourceActivation` 统计 useful effects。

| Signal kind | 默认 useful effect |
|-------------|--------------------|
| Pending signal to another agent | Yes |
| `message.created` | Yes |
| `completion.submitted` | Yes |
| `coordination.wait_for_signal` | Yes |
| `scheduler.no_effect_nudge` | No |
| `scheduler.failed_nudge` | No |
| Generic closed custom signal | No，除非 custom tool 设置 `usefulEffect: true`。 |

Activation 完成时没有 useful effect，`scheduler.noEffectNudge` 可以创建 follow-up signal。默认 nudge 启用，使用 `P3`，由 `maxConsecutive`、`initialDelayMs`、`backoffFactor` 和 `maxDelayMs` 控制。

Activation 在提交 output 前失败时，`scheduler.failedNudge` 可以给同一个 agent 创建 delayed retry signal。它和 runner/provider 内部 retry/backoff 是分开的；作用是复活已经进入 Suzumio `failed` 状态的 agent。

## All-Quiet Nudge

`scheduler.allQuietNudge` 监听所有 agents 都是 `quiet` 且没有 pending signals 的 project。启用后，它会给配置的 target agent 创建 pending scheduler signal，通常是 `pm`。

```yaml
scheduler:
  allQuietNudge:
    enabled: true
    targetAgent: pm
    priority: P3
    cooldownMs: 300000
```

## Quiet Agent Monitor

`scheduler.quietAgentMonitor` 监听指定 agents 是否保持 `quiet` 超过配置时间。它通过和 `messages.send` 相同的路径发送普通消息；不会创建 monitor agent。

```yaml
scheduler:
  quietAgentMonitor:
    enabled: true
    rules:
      - id: worker-watch
        agent: worker-1
        recipient: pm
        sender: monitor
        priority: P3
        initialDelayMs: 1800000
        repeatDelayMs: 900000
        message: "{{agent}} has been quiet for {{quietMinutes}} minutes."
```

Scheduler 按 rule、agent 和 quiet timestamp 记录 monitor-send events。同一个 quiet state 中，只有超过 `repeatDelayMs` 后才会重复发送。

## Failed Agent Monitor

`scheduler.failedAgentMonitor` 监听指定 agents 是否保持 `failed` 超过配置时间。它发送普通 monitor message，通常发给 `pm`，并在同一个 failed activation 仍是当前失败状态时重复提醒。

## Full Tick Order

默认 scheduler 是 `nonpreemptive-signals`。`nonpreemptive-mailbox` 作为 compatibility alias 接受，运行同一个 signal-driven scheduler。

1. 跳过非 `running` projects。
2. 加载 agents。
3. 对 running agents，只处理 pending `P0` interruption signals。
4. 对 quiet agents，如果存在 pending targeted signals，启动一个 activation。
5. 刷新 agent list。
6. 运行 local toolpack scheduler hooks，并传入当前 agent status 和 `modelAlive` state。
7. 应用 failed-agent retry nudge rules。
8. 应用 failed-agent monitor rules。
9. 应用 quiet-agent monitor rules。
10. 应用 all-quiet nudge rules。

## Common Flows

| Flow | Signal sequence |
|------|-----------------|
| User starts PM | User message 给 `pm` 创建 pending `message.created`；scheduler 启动 `pm`。 |
| PM delegates | PM 调用 `messages.send` 给 worker；worker 获得 pending `message.created`；PM 可以 wait。 |
| Worker waits | Worker 调用 `coordination.wait_for_signal`；activation 带 useful effect 结束，无 polling loop。 |
| Worker reports | Worker 调用 `messages.send` 给 `pm`；PM 获得 pending `message.created`。 |
| PM submits | PM 调用 `completion.submit`；project 变成 `submitted` 并等待 approval。 |

<div class="footer">下一步：<a href="configuration.html">YAML 配置</a>。</div>
