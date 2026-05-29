---
title: "Suzumio Core Concepts"
eyebrow: "Core Concepts"
heroTitle: "How Suzumio thinks about work"
lead: "Suzumio models a project as durable messages and isolated turns. The scheduler is intentionally conservative: it starts work only when an agent has inbound messages and leaves running agents alone."
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
| `quiet`   | Idle and no unread inbound messages.                               |
| `running` | A Docker turn is active. The scheduler must not prompt this agent. |
| `failed`  | The last turn or backend operation failed.                         |
| `stopped` | The agent is disabled.                                             |

## Message

Messages are the only normal way to wake an agent. A message is either direct, with `recipient`, or channel-based, with `channel`. Unknown channels are rejected so project communication remains explicit.

    {
      "sender": "user",
      "recipient": "pm",
      "priority": "P1",
      "body": "Start the project."
    }

A message becomes read for an agent only when it is included in that agent's turn prompt. This creates a precise record in `message_reads`.

## Turn

A turn is one isolated execution of one agent. Suzumio creates a turn record, writes read-only `input.json`, starts a Docker container, receives completion through `POST /turn-output`, and records completion or failure.

    turn.started -> container runs -> POST /turn-output -> turn.completed

A turn can send messages, publish artifacts, submit a report, or simply return text. The text is not treated as a message unless the agent uses `messages.send`.

## Mailbox Scheduler

The default scheduler is `nonpreemptive-mailbox`.

1.  Skip projects that are not `running`.
2.  Skip agents that are already `running`.
3.  Fetch unread inbound messages for each idle agent.
4.  If there are no unread messages, leave the agent quiet.
5.  If there are unread messages, render one prompt and start one turn.
6.  Do not create heartbeat prompts, status prompts, or automatic reminders.

## Tools

Tools are presented to the model by the Docker runner. Stateful tools call back to Suzumio for controller support such as messages, artifact registry writes, project submission, permission checks, and audit records. Local tools such as shell and web fetch run inside the runner container.

<div class="grid">

<div class="card"><h3><code>messages.send</code></h3><p>Create a direct or channel message through Suzumio support APIs.</p></div>

<div class="card"><h3><code>artifacts.publish</code></h3><p>Register a workspace file or directory as a durable artifact.</p></div>

<div class="card"><h3><code>artifacts.list</code></h3><p>Return published artifacts.</p></div>

<div class="card"><h3><code>artifacts.read</code></h3><p>Read text file artifacts by id or name.</p></div>

<div class="card"><h3><code>shell.exec</code></h3><p>Run bash inside the Docker runner container.</p></div>

<div class="card"><h3><code>completion.submit</code></h3><p>Write the final report and mark the project submitted.</p></div>

<div class="card"><h3><code>web.fetch</code></h3><p>Fetch an HTTP(S) URL from inside the runner container.</p></div>

</div>

## Artifact

An artifact is a file or directory published from an agent workspace. Suzumio records id, creator, turn id, name, path, SHA-256 hash, description, and creation time. This provides a durable handoff between agents without asking them to search each other's workspaces.

## Event

Events form the project timeline. They are useful for WebUI updates, debugging, auditing, and later replay tools.

    project.initialized
    message.created
    turn.started
    tool.called
    artifact.published
    turn.completed
    project.submitted

<div class="footer">Next: <a href="configuration.html">Configuration</a>.</div>
