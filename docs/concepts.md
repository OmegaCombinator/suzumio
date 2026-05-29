---
title: "Suzumio Core Concepts"
eyebrow: "Core Concepts"
heroTitle: "How Suzumio thinks about work"
lead: "Suzumio models a project as durable messages, signals, and isolated turns. The scheduler is intentionally conservative: it starts work only when an agent has pending signals and leaves running agents alone."
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

An agent is a configured participant with a role, prompt, model selection, workspace, and tool allowlist. Agents do not own project state; they produce messages, tool calls, artifacts, and turn outputs through Suzumio.

| State     | Meaning                                                            |
|-----------|--------------------------------------------------------------------|
| `quiet`   | Idle and no pending signals.                                       |
| `running` | A Docker turn is active. The scheduler must not prompt this agent. |
| `failed`  | The last turn or backend operation failed.                         |
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
      sourceTurn?: string
      targetAgent?: string
      targetChannel?: string
      priority: "P0" | "P1" | "P2" | "P3"
      status: "pending" | "delivered" | "closed"
      usefulEffect: boolean
      payload: Record<string, unknown>
    }

| Status      | Meaning                                                                 |
|-------------|-------------------------------------------------------------------------|
| `pending`   | Waiting to be rendered into the target agent's next turn prompt.        |
| `delivered` | Already rendered into a turn prompt. It will not be delivered again.    |
| `closed`    | Audit or effect record that does not participate in scheduling.         |

Targeted signals cannot be explicitly closed. To wake an agent, create a pending signal. To record an effect without waking anyone, omit the target and create a closed signal.

## Useful Effect

`usefulEffect` answers one question: did this turn do enough external coordination work to avoid an automatic nudge? Suzumio counts useful effects by `sourceTurn` when a turn completes.

| Signal kind                         | Default useful effect | Reason                                                               |
|-------------------------------------|-----------------------|----------------------------------------------------------------------|
| pending signal to another agent     | Yes                   | It schedules follow-up work.                                         |
| `message.created`                   | Yes                   | It communicates with an agent or the user.                           |
| `completion.submitted`              | Yes                   | It hands the final report to the user.                               |
| `coordination.no_valuable_work`     | Yes                   | It records an intentional wait state.                                |
| `artifact.published`                | No                    | Publishing alone does not notify anyone. Send a message as handoff.  |
| `scheduler.no_effect_nudge`         | No                    | It is scheduler feedback, not agent progress.                        |
| generic closed custom signal        | No                    | Custom tools opt in with `usefulEffect: true` when appropriate.      |

## Turn

A turn is one isolated execution of one agent. Suzumio creates a turn record, writes read-only `input.json`, starts a Docker container, receives completion through `POST /turn-output`, and records completion or failure.

    turn.started -> container runs -> POST /turn-output -> turn.completed

A turn can send messages, publish artifacts, submit a report, or simply return text. The text is not treated as a message unless the agent uses `messages.send`.

## Signal Scheduler

The default scheduler is `nonpreemptive-signals`. `nonpreemptive-mailbox` is still accepted as a compatibility name, but it runs the same signal-driven scheduler.

1.  Skip projects that are not `running`.
2.  Skip agents that are already `running`.
3.  Fetch pending signals for each idle agent by priority and creation time.
4.  If there are no pending signals, leave the agent quiet.
5.  If there are pending signals, render one prompt and start one turn.
6.  Mark those signals delivered when the turn is created.
7.  If the turn completes with no useful effects, create one `scheduler.no_effect_nudge` signal unless that turn was itself created by such a nudge.

## Tools

Tools are presented to the model by the Docker runner. Stateful tools call back to Suzumio for controller support such as messages, artifact registry writes, project submission, permission checks, and audit records. Local tools such as shell and web fetch run inside the runner container.

<div class="grid">

<div class="card"><h3><code>messages.send</code></h3><p>Create a direct or channel message through Suzumio support APIs.</p></div>

<div class="card"><h3><code>coordination.no_valuable_work</code></h3><p>Declare an intentional wait state. Non-PM agents notify <code>pm</code> by default; PM waits quietly.</p></div>

<div class="card"><h3><code>artifacts.publish</code></h3><p>Register a workspace file or directory as a durable artifact.</p></div>

<div class="card"><h3><code>artifacts.list</code></h3><p>Return published artifacts.</p></div>

<div class="card"><h3><code>artifacts.read</code></h3><p>Read text file artifacts by id or name.</p></div>

<div class="card"><h3><code>shell.exec</code></h3><p>Run bash inside the Docker runner container.</p></div>

<div class="card"><h3><code>completion.submit</code></h3><p>Write the final report and mark the project submitted.</p></div>

<div class="card"><h3><code>web.fetch</code></h3><p>Fetch an HTTP(S) URL from inside the runner container.</p></div>

</div>

## Artifact

An artifact is a file or directory published from an agent workspace. Suzumio records id, creator, turn id, name, path, SHA-256 hash, description, and creation time. Publishing an artifact is durable storage, not communication. An agent should send a message or submit completion after publishing if another participant should act on it.

## Event

Events form the project timeline. They are useful for WebUI updates, debugging, auditing, and later replay tools.

    project.initialized
    message.created
    signal.created
    turn.started
    tool.called
    artifact.published
    turn.completed
    project.submitted

<div class="footer">Next: <a href="configuration.html">Configuration</a>.</div>
