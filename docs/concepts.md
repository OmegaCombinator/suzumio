---
title: "Suzumio Signal Scheduling"
eyebrow: "Signal Scheduling"
heroTitle: "How signals drive every activation"
lead: "Suzumio schedules agents from durable signals. Messages, waits, submissions, nudges, and custom tools all become records in SQLite, and the scheduler turns pending targeted signals into Docker activations."
---

## Runtime Objects

| Object | Runtime role |
|--------|--------------|
| Project | Durable unit of work with resolved YAML, agent roster, channels, SQLite database, artifacts, and event timeline. |
| Agent | Configured participant with role, prompt, model selection, workspace, artifact directory, token, and tool allowlist. |
| Message | Durable communication record. Direct messages target one agent or `user`; channel messages fan out to agents. |
| Signal | Scheduler input and effect ledger. Pending targeted signals wake agents; closed signals record effects. |
| Activation | One isolated Docker execution for one agent. The activation receives delivered signals in its prompt. |
| Event | Append-style timeline entry for UI, audit, debugging, and replay tooling. |

## Project And Agent States

| Project status | Scheduling behavior |
|----------------|---------------------|
| `initialized` | No automatic scheduling. |
| `running` | Scheduler may start ready agents. |
| `submitted` | Project waits for user approval. |
| `completed` | Scheduling complete. |
| `stopped` | Scheduling disabled. |

| Agent status | Scheduling behavior |
|--------------|---------------------|
| `quiet` | Eligible for a new activation when pending targeted signals exist. |
| `running` | Has an active activation. `P0` can interrupt; `P1` may be injected at a tool boundary; `P2` and `P3` wait. |
| `failed` | Last activation or backend action failed. |
| `stopped` | Agent is disabled. |

## Messages Become Signals

`messages.send` writes a message row, appends a `message.created` event, and records one or more signals.

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
| `recipient: "pm"` | One pending `message.created` signal for `pm`. |
| `channel: "#reviews"` | One pending `message.created` signal for each other agent subscribed by config. |
| `recipient: "user"` | Closed useful effect; no agent is woken. |

Unknown recipients and undeclared channels are rejected.

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

| Status | Meaning |
|--------|---------|
| `pending` | Waiting to be delivered to a target agent at activation start or tool boundary. |
| `delivered` | Already appended to agent history for one activation. It will not be delivered again. |
| `closed` | Audit or useful-effect record that does not participate in scheduling. |

To wake an agent, create a pending signal with `targetAgent`. To record an effect without waking anyone, omit `targetAgent` and `targetChannel`, then create a closed signal.

## Priority Rules

| Priority | Delivery rule |
|----------|---------------|
| `P0` | Interrupts a running target agent. The current activation is cancelled and the agent restarts with the `P0` signal in history. |
| `P1` | Delivered at the next tool boundary when possible. If there is no boundary, it is delivered at the next activation start. |
| `P2` | Control-flow or continuation work. It waits until the current activation completes and is delivered before routine backlog at the next activation start. |
| `P3` | Routine queued work. It waits until the current activation completes and is delivered after any pending `P2` signal. |

Default routine messages use `P3`. Use `P2` for plan-continuation nudges, scheduler control messages, and other work that should run before ordinary backlog. `P0` is reserved for human stop, destructive repository conflict, secret/safety issue, or a blocker where continuing the current activation is harmful.

## Activation Start

For each running project, the scheduler checks the agent roster. A quiet agent with pending targeted signals gets one activation.

1. Load pending signals for the agent by priority and creation time.
2. Render an activation prompt containing current delivered signals and the tool/reporting contract.
3. Append the prompt to the agent's SQLite history.
4. Mark those signals `delivered` with the new activation id.
5. Create an activation row and write read-only `input.json`.
6. Start one Docker runner container.

The activation prompt is the only place where newly delivered signals become model-visible. Earlier model history is included for continuity, but new assignments come from the delivered signals.

## Running Agent Behavior

When an agent is already running, the scheduler does not start a second activation for it.

| Incoming signal | Running-agent behavior |
|-----------------|------------------------|
| `P0` | Cancel current activation, stop the backend container, and restart with pending `P0` and `P1` signals. |
| `P1` | Leave the activation running. Deliver at the next completed tool call if the runner reaches a tool boundary. |
| `P2` | Leave the activation running. Deliver on the next activation after current completion, before `P3`. |
| `P3` | Leave the activation running. Deliver on the next activation after current completion, after any pending `P2`. |

The runner asks Suzumio for tool-boundary signal delivery after completed tool calls. Pending `P1` signals are appended into the active model context at that boundary.

## Useful Effects And Nudges

`usefulEffect` records externally visible coordination work for an activation. Suzumio counts useful effects by `sourceActivation` when the activation completes.

| Signal kind | Default useful effect |
|-------------|-----------------------|
| Pending signal to another agent | Yes |
| `message.created` | Yes |
| `completion.submitted` | Yes |
| `coordination.wait_for_signal` | Yes |
| `scheduler.no_effect_nudge` | No |
| `scheduler.failed_nudge` | No |
| Generic closed custom signal | No unless the custom tool sets `usefulEffect: true`. |

If an activation completes without a useful effect, `scheduler.noEffectNudge` can create a follow-up signal. The default nudge is enabled, uses `P3`, and is controlled by `maxConsecutive`, `initialDelayMs`, `backoffFactor`, and `maxDelayMs`.

If an activation fails before submitting output, `scheduler.failedNudge` can create a delayed retry signal for the same agent. This is separate from provider-level retry/backoff inside the runner; it revives an agent that reached Suzumio's `failed` state.

## All-Quiet Nudge

`scheduler.allQuietNudge` watches for a project where all agents are `quiet` and no pending signals exist. When enabled, it creates a pending scheduler signal for the configured target agent, usually `pm`.

```yaml
scheduler:
  allQuietNudge:
    enabled: true
    targetAgent: pm
    priority: P3
    cooldownMs: 300000
```

## Quiet Agent Monitor

`scheduler.quietAgentMonitor` watches named agents that remain `quiet` longer than a configured delay. It sends an ordinary message through the same path as `messages.send`; no monitor agent is created.

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

The scheduler records monitor-send events by rule, agent, and quiet timestamp, then repeats only after `repeatDelayMs` while the agent remains in the same quiet state.

## Failed Agent Monitor

`scheduler.failedAgentMonitor` watches named agents that remain `failed` longer than a configured delay. It sends ordinary monitor messages, usually to `pm`, and repeats while the same failed activation remains current.

## Full Tick Order

The default scheduler is `nonpreemptive-signals`. `nonpreemptive-mailbox` is accepted as a compatibility alias for the same signal-driven scheduler.

1. Skip projects that are not `running`.
2. Load agents.
3. For each running agent, act only on pending `P0` interruption signals.
4. For each quiet agent, start one activation when pending targeted signals exist.
5. Refresh the agent list.
6. Run local toolpack scheduler hooks, passing current agent status and `modelAlive` state.
7. Apply failed-agent retry nudge rules.
8. Apply failed-agent monitor rules.
9. Apply quiet-agent monitor rules.
10. Apply all-quiet nudge rules.

## Common Flows

| Flow | Signal sequence |
|------|-----------------|
| User starts PM | User message creates pending `message.created` for `pm`; scheduler starts `pm`. |
| PM delegates | PM calls `messages.send` to a worker; worker gets pending `message.created`; PM can wait. |
| Worker waits | Worker calls `coordination.wait_for_signal`; activation ends with a useful effect and no polling loop. |
| Worker reports | Worker calls `messages.send` to `pm`; PM gets pending `message.created`. |
| PM submits | PM calls `completion.submit`; project becomes `submitted` and waits for approval. |

<div class="footer">Next: <a href="configuration.html">YAML Reference</a>.</div>
