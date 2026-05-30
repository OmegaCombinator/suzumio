---
title: "Suzumio Documentation"
description: "Suzumio is a YAML-based multi-agent system that runs agents in Docker activations."
eyebrow: "YAML-based multi-agent projects"
heroTitle: "Write a YAML file. Run a team of agents."
lead: "Suzumio lets you describe a multi-agent workflow in one YAML project file: task, agents, prompts, tools, Docker runner, model presets, and scheduling policy. The runtime turns that YAML into durable messages, signals, activations, shared files, and final submissions."
actions:
  - text: "Start with YAML"
    link: "quickstart.html"
    variant: "primary"
  - text: "YAML reference"
    link: "configuration.html"
  - text: "Use the API"
    link: "api.html"
    variant: "blue"
---

## The Idea

Suzumio is a YAML-based multi-agent system. You do not start by writing orchestration code. You start by writing a project file that says:

- what the project is trying to accomplish;
- which agents exist;
- what each agent is allowed to do;
- how agents should coordinate;
- which Docker runner and model presets to use.

The runtime then handles the boring coordination mechanics: storing state in SQLite, starting Docker activations, delivering messages as signals, preventing running agents from being interrupted, mounting shared files, and recording tool calls.

## A Tiny Project

This is the smallest useful shape. One `pm` agent receives user messages, can message the user or other agents, can wait for future signals, and can submit a final report.

```yaml
name: tiny-research
task: |
  Answer the user's question carefully. If you are missing information,
  ask a follow-up instead of pretending.

tools:
  toolpacks:
    - core

agents:
  pm:
    role: project-manager
    displayName: Yuki
    prompt: |
      You coordinate the project. Keep a short working memory in your messages.
      Submit only when the answer is ready for the user.
    tools:
      - messages.send
      - coordination.wait_for_signal
      - completion.submit
```

Run it with:

```bash
suzumio config render tiny-research.yaml
suzumio init tiny-research.yaml
suzumio serve --host 0.0.0.0 --port 39400
suzumio start tiny-research
suzumio send tiny-research pm P1 "Start."
```

## How YAML Becomes Multi-Agent Behavior

| YAML field | What it controls | What happens at runtime |
|------------|------------------|--------------------------|
| `task` | The shared project goal | Rendered into the first activation prompt. |
| `agents` | The roster and prompts | Each agent becomes a durable participant with its own workspace and shared artifact directory. |
| `agents.<id>.tools` | The model-visible allowlist | A worker cannot call tools it was not given. |
| `tools.toolpacks` | Which tool families exist | `core` gives messages/wait/submit; `shell` gives Python/bash; `web` gives HTTP fetch. |
| `scheduler` | Signal delivery policy | Idle agents with pending signals get one activation; running agents are not interrupted. |
| `backend` | Docker/model/proxy settings | The runner image, controller URL, model presets, mounts, network, and proxy are resolved from YAML. |

## The Default Collaboration Loop

1. A user sends a message to an agent, usually `pm`.
2. That message becomes a pending `message.created` signal.
3. The scheduler starts one Docker activation for the idle target agent.
4. The agent can send messages, run tools, write `/artifacts/<agent-id>` files, wait, or submit.
5. If it messages another agent, that creates a pending signal for the recipient.
6. If it calls `coordination.wait_for_signal`, the activation ends cleanly and the agent stays quiet.
7. If it calls `completion.submit`, the project is marked submitted and a final report is written.

## Good YAML Produces Good Coordination

The most important design skill is not writing long prompts. It is assigning clear responsibilities and giving each agent just enough tools.

Use a PM when:

- the project needs delegation;
- multiple reports must be merged;
- someone must decide when the final answer is ready.

Use workers when:

- tasks can be explored independently;
- you want separate attempts, experiments, or proofs;
- you want the PM to compare evidence rather than invent everything alone.

Use a critic/checker when:

- final output needs review;
- hallucinated certainty is dangerous;
- workers may produce incompatible claims.

Use `shell.exec` when:

- the agent should run Python, tests, scripts, or local searches;
- the result should be saved under `/artifacts/<agent-id>`;
- evidence matters more than prose.

## Copyable Patterns

Start with [Quickstart](quickstart.html) for a runnable tutorial, then use [Configuration](configuration.html) for copyable YAML patterns: PM plus workers, PM plus critic, Python experiment teams, web research, and review pipelines.

## Project Layout

After `suzumio init`, the runtime root contains the project state generated from YAML:

```text
$SUZUMIO_ROOT/tiny-research/
  suzumio.sqlite      durable project database
  source.yaml         original project config
  resolved.yaml       fully resolved config
  agents/             per-agent workspaces
  artifacts/          per-agent shared files
  activations/        activation input directories
  logs/               reserved for runtime logs
```

## Where To Go Next

| Goal | Read |
|------|------|
| Run your first YAML project | [Quickstart](quickstart.html) |
| Learn every YAML field | [Configuration](configuration.html) |
| Understand messages, signals, and activations | [Core Concepts](concepts.html) |
| Operate projects from the terminal | [CLI Reference](cli.html) |
| Integrate or build UI around Suzumio | [HTTP API](api.html) |

<div class="footer">Current site: <a href="https://suzumio.aixmath.org">suzumio.aixmath.org</a>. Source: <a href="https://github.com/OmegaCombinator/suzumio">OmegaCombinator/suzumio</a>.</div>
