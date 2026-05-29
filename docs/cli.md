---
title: "Suzumio CLI Reference"
eyebrow: "CLI Reference"
heroTitle: "Operate projects from the terminal"
lead: "The CLI is the fastest way to initialize projects, render configs, send work, inspect runtime state, and control lifecycle transitions."
---

## Global Runtime Root

Most commands read `SUZUMIO_ROOT`. You can also pass `--root` to commands that support it.

    export SUZUMIO_ROOT=/data/suzumio-runtime
    suzumio status
    suzumio status --root /data/suzumio-runtime

## Command Summary

| Command                                                      | Use when                                                                 |
|--------------------------------------------------------------|--------------------------------------------------------------------------|
| `suzumio config render <file>`                               | You want to inspect the final resolved config before initialization.     |
| `suzumio init <file>`                                        | You are creating a new project database and work directories.            |
| `suzumio serve`                                              | You need HTTP API, controller support routes, WebUI, and scheduler loop. |
| `suzumio start <project>`                                    | You want the scheduler to start eligible agents.                         |
| `suzumio send <project> <recipient> <priority> <message...>` | You want to deliver user input to an agent.                              |
| `suzumio status [project]`                                   | You want project and agent status.                                       |
| `suzumio messages <project>`                                 | You want recent project messages.                                        |
| `suzumio turns <project>`                                    | You want runner outputs and failures.                                    |
| `suzumio artifacts <project>`                                | You want published artifact paths.                                       |
| `suzumio events <project>`                                   | You want the project event timeline.                                     |
| `suzumio tick [project]`                                     | You want to run one scheduler pass manually.                             |
| `suzumio stop <project>`                                     | You want to stop scheduling.                                             |
| `suzumio approve <project>`                                  | You want to mark a submitted result completed.                           |

## `suzumio config render`

    suzumio config render examples/import-demo.yaml

Loads YAML, resolves whole-field imports, applies `extends`, applies defaults, validates the config, and prints the final YAML. Use this in reviews and debugging.

Common failures:

- Missing `name`, `task`, or `agents`.
- Import path not found.
- Circular import.
- Unsupported scheduler or backend kind.

## `suzumio init`

    suzumio init examples/demo.yaml
    suzumio init examples/demo.yaml --root /tmp/suzumio-root

Creates a project under `SUZUMIO_ROOT`, writes `source.yaml` and `resolved.yaml`, creates `suzumio.sqlite`, expands counted agents, creates agent workspaces, and records `project.initialized`.

Initialization fails if a project with the same name already exists in the selected root.

## `suzumio serve`

    suzumio serve --host 0.0.0.0 --port 39400
    suzumio serve --host 127.0.0.1 --port 39400 --no-scheduler

Starts the HTTP API, controller support routes, embedded WebUI, SSE endpoint, and scheduler loop. Use `--no-scheduler` if you want to drive scheduling manually with `suzumio tick`.

| Flag             | Description                                                             |
|------------------|-------------------------------------------------------------------------|
| `--host`         | Bind address. Use `0.0.0.0` when Docker containers must reach the host. |
| `--port`         | HTTP port. Must match project `backend.controllerUrl`.                  |
| `--root`         | Override `SUZUMIO_ROOT`.                                                |
| `--no-scheduler` | Serve API without automatic scheduler ticks.                            |

## `suzumio start`

    suzumio start demo

Sets project status to `running` and immediately runs one scheduler pass. If agents already have unread inbound messages, turns may start immediately.

## `suzumio send`

    suzumio send demo pm P1 "Start the project."
    suzumio send demo worker-1 P2 "Review artifact art_..."

Creates a direct message from virtual sender `user` to the recipient and runs one scheduler pass. Priorities are `P0`, `P1`, `P2`, and `P3`. Priority is recorded and rendered into the turn prompt; it does not interrupt running agents.

## Inspection Commands

    suzumio status
    suzumio status demo
    suzumio messages demo --limit 20
    suzumio turns demo --limit 10
    suzumio artifacts demo
    suzumio events demo --limit 50

Inspection commands read directly from SQLite. They do not wake agents and do not mutate the project except for normal SQLite read access.

## `suzumio tick`

    suzumio tick
    suzumio tick demo

Runs one scheduler pass across all projects or one project. This is useful when the HTTP server is running with `--no-scheduler` or during debugging.

## Lifecycle Commands

    suzumio stop demo
    suzumio approve demo

`stop` changes project status to `stopped`. It does not currently remove existing Docker containers. `approve` changes project status to `completed` after a submitted report has been reviewed.

## Exit Codes and Scripting

Commands exit non-zero on validation errors, missing projects, invalid priorities, or store failures. Use `config render` and `status` in scripts to check readiness before starting long runs.

<div class="footer">Next: <a href="architecture.html">Architecture</a>.</div>
