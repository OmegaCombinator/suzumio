---
title: "Suzumio Core Concepts"
eyebrow: "Core Concepts"
heroTitle: "How Suzumio thinks about work"
lead: "Suzumio models a project as durable messages, signals, per-agent histories, and isolated activations. The scheduler starts work only when an agent has pending signals, with explicit priority rules for interrupting or deferring work."
---

## Project

A project is the durable unit of work. It has a name, task statement, resolved configuration, agent roster, channels, SQLite database, artifact directory, and event timeline.

| Status        | Scheduling behavior               | Typical transition                  |
|---------------|-----------------------------------|-------------------------------------|
| `initialized` | No scheduling.                    | Created by `suzumio init`.          |
| `running`     | Scheduler may start ready agents. | `suzumio start` or request changes. |
| `submitted`   | Project waits for user approval.  | `completion.submit` tool.           |
| `completed`   | No further scheduling expected.   | `suzumio approve`.                  |
| `stopped`     | Scheduling disabled.              | `suzumio stop`.                     |

## Agent

An agent is a configured participant with a role, prompt, model selection, workspace, and tool allowlist. Agents do not own project state; they produce messages, tool calls, artifacts, and activation outputs through Suzumio.

| State     | Meaning                                                            |
|-----------|--------------------------------------------------------------------|
| `quiet`   | Idle and no pending signals.                                       |
| `running` | A Docker activation is active. Only `P0` can interrupt and restart it. |
| `failed`  | The last activation or backend operation failed.                         |
| `stopped` | The agent is disabled.                                             |

## Message

Messages are durable communication records. A message is either direct, with `recipient`, or channel-based, with `channel`. Unknown recipients and undeclared channels are rejected so project communication remains explicit.

    {
      "sender": "user",
      "recipient": "pm",
      "priority": "P1",
      "body": "Start the project."
    }

A message creates a `message.created` signal. Direct messages to agents create one pending signal for that agent. Channel messages fan out into one pending signal per other agent. Messages to `recipient: "user"` are closed useful effects: they are visible to users but do not wake an agent.

## Signal

Signals are the scheduler input and the effect ledger. A signal with `targetAgent` and `status: "pending"` can wake that agent. A closed signal has no target and is retained for audit, useful-effect accounting, or both.

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

| Status      | Meaning                                                                 |
|-------------|-------------------------------------------------------------------------|
| `pending`   | Waiting to be delivered to the target agent at an activation start or tool boundary. |
| `delivered` | Already appended to agent history for one activation. It will not be delivered again. |
| `closed`    | Audit or effect record that does not participate in scheduling.         |

Targeted signals cannot be explicitly closed. To wake an agent, create a pending signal. To record an effect without waking anyone, omit the target and create a closed signal.

## Priority

| Priority | Delivery rule                                                                 |
|----------|-------------------------------------------------------------------------------|
| `P0`     | Interrupt the current activation if the target is running, cancel it, and restart with the signal in agent history. |
| `P1`     | Deliver at the next tool boundary when possible; otherwise deliver at the next activation start. |
| `P2`     | Wait until the current activation finishes, then deliver at the next activation start. |

## Useful Effect

`usefulEffect` answers one question: did this activation do enough external coordination work to avoid an automatic nudge? Suzumio counts useful effects by `sourceActivation` when an activation completes.

| Signal kind                         | Default useful effect | Reason                                                               |
|-------------------------------------|-----------------------|----------------------------------------------------------------------|
| pending signal to another agent     | Yes                   | It schedules follow-up work.                                         |
| `message.created`                   | Yes                   | It communicates with an agent or the user.                           |
| `completion.submitted`              | Yes                   | It hands the final report to the user.                               |
| `coordination.wait_for_signal`      | Yes                   | It records an intentional wait state.                                |
| `scheduler.no_effect_nudge`         | No                    | It is scheduler feedback, not agent progress.                        |
| generic closed custom signal        | No                    | Custom tools opt in with `usefulEffect: true` when appropriate.      |

## Activation

An activation is one isolated execution of one continuous agent. Suzumio creates an activation record, writes read-only `input.json`, starts a Docker container, receives completion through `POST /activation-output`, and records completion or failure.

    activation.started -> container runs -> POST /activation-output -> activation.completed

An activation can send messages, publish artifacts, submit a report, or simply return text. The text is not treated as a message unless the agent uses `messages.send`.

## Agent History

Each agent has append-only model history stored in SQLite. Suzumio appends user prompts from delivered signals, visible assistant output, tool calls, tool results, and compaction markers. The runner sends the active history back to the model on the next call, so continuity lives in the core runtime rather than in a container-local file.

When the active history grows too large, the runner asks the model for a compact summary. Suzumio archives the full raw compacted range locally, marks those messages archived, appends a compaction marker containing the summary, and keeps the latest tail messages verbatim.

## Signal Scheduler

The default scheduler is `nonpreemptive-signals`. `nonpreemptive-mailbox` is still accepted as a compatibility name, but it runs the same signal-driven scheduler.

1.  Skip projects that are not `running`.
2.  For running agents, only act on pending `P0`: cancel the active activation and restart with the new signal.
3.  For idle agents, fetch pending signals by priority and creation time.
4.  If there are no pending signals, leave the agent quiet.
5.  If there are pending signals, append one activation prompt to agent history and start one activation.
6.  Mark those signals delivered when the activation is created.
7.  If a `P1` signal arrives during a running activation, deliver it at the next completed tool call when possible.
8.  If the activation completes with no useful effects, create one `scheduler.no_effect_nudge` signal unless that activation was itself created by such a nudge.

## Tools

Tools are presented to the model by the Docker runner. Stateful tools call back to Suzumio for controller support such as messages, project submission, permission checks, and audit records. Local tools such as shell and web fetch run inside the runner container.

<div class="grid">

<div class="card"><h3><code>messages.send</code></h3><p>Create a direct or channel message through Suzumio support APIs.</p></div>

<div class="card"><h3><code>coordination.wait_for_signal</code></h3><p>Declare an intentional wait state. Non-PM agents notify <code>pm</code> by default; PM waits quietly.</p></div>

<div class="card"><h3><code>shell.exec</code></h3><p>Run bash inside the Docker runner container.</p></div>

<div class="card"><h3><code>completion.submit</code></h3><p>Write the final report and mark the project submitted.</p></div>

<div class="card"><h3><code>web.fetch</code></h3><p>Fetch an HTTP(S) URL from inside the runner container.</p></div>

</div>

## Shared Artifacts

Every activation gets `/artifacts/<agent-id>` mounts. The current agent's directory is read-write, and other agents' directories are read-only. The first activation prompt lists the artifact paths; later activations rely on the agent's persisted history. This is the lightweight artifact workflow: agents with `shell.exec` can write scripts, outputs, notes, and data directly to their own shared directory, then send a message pointing other agents at the path.

## Event

Events form the project timeline. They are useful for WebUI updates, debugging, auditing, and later replay tools.

    project.initialized
    message.created
    signal.created
    activation.started
    tool.called
    activation.completed
    project.submitted

<div class="footer">Next: <a href="configuration.html">Configuration</a>.</div>
