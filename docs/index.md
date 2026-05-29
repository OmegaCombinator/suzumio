---
title: "Suzumio Documentation"
description: "Suzumio is a Docker-first, non-preemptive multi-agent coordination runtime."
eyebrow: "Docker-first coordination for long-running agents"
heroTitle: "Suzumio"
lead: "Suzumio coordinates multi-agent projects with a non-preemptive mailbox scheduler, isolated Docker turns, audited tools, artifact tracking, SQLite state, a CLI, an HTTP API, and a lightweight WebUI."
actions:
  - text: "Run the demo"
    link: "quickstart.html"
    variant: "primary"
  - text: "Write a config"
    link: "configuration.html"
  - text: "Use the API"
    link: "api.html"
    variant: "blue"
---

## Purpose

Suzumio is a coordination runtime for projects where agents may need to work for a long time without being interrupted. It is suitable for formalization, code work, research workflows, review pipelines, benchmark experiments, and other tasks where progress is best represented as durable turns, messages, artifacts, and audit logs.

Suzumio separates project coordination from agent execution. The core runtime owns project state and scheduling. The Docker runner executes one agent turn, presents the model-facing tools, calls back to Suzumio only when stateful support is needed, writes a result, and exits.

<div class="grid">

<div class="card"><h3>Non-preemptive scheduling</h3><p>Running agents are not prompted, nudged, or interrupted. New inbound messages wait in the mailbox until the current turn finishes.</p></div>

<div class="card"><h3>Durable project state</h3><p>Projects store resolved configuration, agents, messages, message reads, turns, events, tool calls, and artifacts in SQLite.</p></div>

<div class="card"><h3>Docker-first execution</h3><p>Each turn runs in a container with a read-only turn input file, an agent workspace, runner-local shell and web tools, and HTTP result submission.</p></div>

<div class="card"><h3>Allowlisted tools</h3><p>Project toolpacks choose available tools, and each agent receives only its configured allowlist.</p></div>

</div>

## What You Can Do Today

| Task                                | Where to start                      | What you get                                                                                             |
|-------------------------------------|-------------------------------------|----------------------------------------------------------------------------------------------------------|
| Run a local AI smoke test           | [Quickstart](quickstart.html)       | A Docker-backed AI turn that verifies scheduling, storage, controller support routes, and runner wiring. |
| Define a project                    | [Configuration](configuration.html) | YAML config with whole-field imports, profile composition, agents, tools, and backend settings.          |
| Operate projects from terminal      | [CLI Reference](cli.html)           | Commands for init, serve, start, send, inspect, approve, and stop.                                       |
| Integrate with other systems        | [HTTP API](api.html)                | Project objects, user actions, event streams, and controller support calls.                              |
| Deploy docs or inspect architecture | [Architecture](architecture.html)   | Clear boundaries between core runtime, Docker backend, runner tools, support routes, and SQLite.         |

## Core Workflow

    1. Render and validate project config.
    2. Initialize a project under SUZUMIO_ROOT.
    3. Start the HTTP server and scheduler loop.
    4. Send a user message to an agent.
    5. Scheduler starts one Docker turn for that agent.
    6. Runner executes the turn and model-facing tools.
    7. Suzumio records messages, tool calls, events, artifacts, and turn output.
    8. Idle agents remain quiet until new inbound messages arrive.

## Project Layout

    $SUZUMIO_ROOT/demo/
      suzumio.sqlite      durable project database
      source.yaml         original project config
      resolved.yaml       fully resolved config
      agents/             per-agent workspaces
      artifacts/          published files
      turns/              turn input directories
      logs/               reserved for runtime logs

## Public Documentation Scope

This site documents the runtime contract, user workflows, configuration, CLI, API, and operational behavior. It intentionally avoids internal development history and private deployment details. Examples use placeholders for provider endpoints and keys.

<div class="footer">Current site: <a href="https://suzumio.aixmath.org">suzumio.aixmath.org</a>. Source: <a href="https://github.com/OmegaCombinator/suzumio">OmegaCombinator/suzumio</a>.</div>
