---
title: "Suzumio Operations"
eyebrow: "Operations"
heroTitle: "Run, inspect, and clean projects"
lead: "Suzumio is designed to be transparent. Every important object has a CLI view and an HTTP view backed by the same SQLite store."
---

## Runtime Root

    export SUZUMIO_ROOT=/data/suzumio-runtime

Runtime state should live outside the source repository. The root contains project databases, turn input files, agent workspaces, artifacts, and logs.

## Recommended Run Pattern

    npm run build
    docker build -t suzumio-runner:dev .

    export SUZUMIO_ROOT=/data/suzumio-runtime
    suzumio config render examples/demo.yaml
    suzumio init examples/demo.yaml
    suzumio serve --host 0.0.0.0 --port 39400

Then, from another terminal:

    export SUZUMIO_ROOT=/data/suzumio-runtime
    suzumio start demo
    suzumio send demo pm P1 "Start the project."

## Operational Checklist

| Stage     | Check                                                      | Command                                   |
|-----------|------------------------------------------------------------|-------------------------------------------|
| Build     | TypeScript emits `dist/`.                                  | `npm run build`                           |
| Image     | Runner image exists locally.                               | `docker image inspect suzumio-runner:dev` |
| Config    | Imports resolve and secrets are not committed.             | `suzumio config render file.yaml`         |
| Store     | Project was initialized under the expected root.           | `suzumio status project`                  |
| Server    | HTTP and controller support routes are reachable.          | `curl http://127.0.0.1:39400/health`      |
| Scheduler | Project is running and idle agents have pending signals.    | `suzumio messages project` and events     |
| Turn      | Container completed and turn text was submitted over HTTP. | `suzumio turns project`                   |

## Inspecting a Turn

A turn directory contains the exact runner input:

    $SUZUMIO_ROOT/demo/turns/turn_.../
      input.json

The input includes the rendered prompt, agent identity, controller URL, runner config, and tool definitions available to the model. Final turn text is submitted through `POST /turn-output` and stored in SQLite, so failed turns are still reviewable without trusting a container-writable output file.

## Debugging Scheduler Silence

| Symptom                                | Likely cause                               | Action                                                        |
|----------------------------------------|--------------------------------------------|---------------------------------------------------------------|
| Project never starts a turn.           | Project is not `running`.                  | `suzumio start project`                                       |
| Agent stays quiet.                     | No pending signals for that agent.         | `suzumio send project agent P1 "..."`                         |
| Message exists but no new turn starts. | Agent is already `running`, project is stopped, or message targeted `user`. | Wait for completion or send a direct message to an agent. |
| Turn fails immediately.                | Image, mount, or Docker daemon issue.      | Inspect `suzumio turns`, turn input, and `docker logs`.       |

## Avoiding Coordination Loops

Agents should not post "nothing to do" messages to a shared channel. Use `coordination.no_valuable_work` instead. Worker agents notify `pm` by direct message by default, and PM can record an intentional wait state without waking itself.

If an agent publishes an artifact, it should also send a message or submit completion when the artifact is ready for someone else. Artifact publication alone is stored for audit, but it does not count as useful coordination work.

## Cleaning Debug Containers

Early Suzumio keeps completed turn containers for debugging. Remove only containers that Suzumio created:

    docker ps -a --filter name=suzumio
    docker rm <container-name>

<div class="notice danger">

Do not run broad Docker prune commands on shared machines. Suzumio should only clean containers it created.

</div>

## Secrets

Use environment variables for API keys and local, untracked config for private gateway URLs.

    export SUZUMIO_GATEWAY_API_KEY=...
    suzumio serve --host 0.0.0.0 --port 39400

The runner backend passes configured provider key environment variables into containers when those variables exist in the host environment. Committed examples should use placeholder endpoints and environment-variable names only.

## Long-running Servers

For a long-running server, use a process manager such as systemd, a container supervisor, or a supervised shell session. Bind the server only to trusted interfaces until user-facing API authentication lands.

    suzumio serve --host 127.0.0.1 --port 39400

If Docker containers need to call host support routes, bind to an address reachable from Docker and set `backend.controllerUrl` accordingly.

## Documentation Deployment

The GitHub Pages workflow uploads the static `docs/` directory. The custom domain is configured by `docs/CNAME` and DNS. GitHub may serve the custom domain over HTTP until certificate provisioning finishes; enable HTTPS enforcement once GitHub marks the certificate ready.

<div class="footer">Next: <a href="api.html">HTTP API</a>.</div>
