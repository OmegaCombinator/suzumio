---
title: "Suzumio Operations"
eyebrow: "Operations"
heroTitle: "Run, inspect, and clean projects"
lead: "Suzumio is designed to be transparent. Every important object has a CLI view and an HTTP view backed by the same SQLite store."
---

## Runtime Root

    export SUZUMIO_ROOT=/data/suzumio-runtime

Runtime state should live outside the source repository. The root contains project databases, activation input files, agent workspaces, artifacts, and logs.

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
| Activation | Container completed and activation text was submitted over HTTP. | `suzumio activations project`             |

## Inspecting an Activation

An activation directory contains the exact runner input:

    $SUZUMIO_ROOT/demo/activations/act_.../
      input.json

The input includes the rendered prompt, agent identity, controller URL, runner config, and tool definitions available to the model. Final activation text is submitted through `POST /activation-output` and stored in SQLite, so failed activations are still reviewable without trusting a container-writable output file.

## Debugging Scheduler Silence

| Symptom                                | Likely cause                               | Action                                                        |
|----------------------------------------|--------------------------------------------|---------------------------------------------------------------|
| Project never starts an activation.    | Project is not `running`.                  | `suzumio start project`                                       |
| Agent stays quiet.                     | No pending signals for that agent.         | `suzumio send project agent P1 "..."`                         |
| Message exists but no new activation starts. | Agent is already `running`, project is stopped, or message targeted `user`. | Wait for completion or send a direct message to an agent. |
| Activation fails immediately.          | Image, mount, or Docker daemon issue.      | Inspect `suzumio activations`, activation input, and `docker logs`. |

## Avoiding Coordination Loops

Agents should not post "nothing to do" messages to a shared channel. Use `coordination.wait_for_signal` instead. It records the wait state and ends the current activation. Worker agents notify `pm` by direct message by default, and PM can record an intentional wait state without waking itself.

If an agent writes a shared artifact under `/artifacts/<agent-id>`, it should also send a message or submit completion when the file is ready for someone else. File writes are durable, but they do not wake another agent by themselves.

## Cleaning Debug Containers

Early Suzumio keeps completed activation containers for debugging. Remove only containers that Suzumio created:

    docker ps -a --filter name=suzumio
    docker rm <container-name>

<div class="notice danger">

Do not run broad Docker prune commands on shared machines. Suzumio should only clean containers it created.

</div>

## Secrets

Use environment variables for API keys and local, untracked config for private gateway URLs.

    export SUZUMIO_GATEWAY_API_KEY=...
    suzumio serve --host 0.0.0.0 --port 39400

The runner backend passes configured provider key environment variables into containers when those variables exist in the process that launches the activation. This can be the long-running server, but CLI commands such as `suzumio start`, `suzumio send`, and `suzumio tick` can also trigger scheduler ticks directly, so run them with the same provider environment. Committed examples should use placeholder endpoints and environment-variable names only.

## Proxies And Runner Tools

The default runner image includes `python3` and `curl`, so agents with `shell.exec` can run small scripts and command-line network probes inside Docker.

Suzumio passes standard proxy variables into runner containers when they exist: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, and lowercase variants. If a proxy value points at `127.0.0.1`, `localhost`, or `::1`, Suzumio rewrites that host to `host.docker.internal` for bridge-network containers.

For local HTTP proxies, export the proxy before starting any process that may launch activations:

    export HTTPS_PROXY=http://127.0.0.1:7890
    export HTTP_PROXY=http://127.0.0.1:7890
    suzumio serve --host 0.0.0.0 --port 39400

HTTP and HTTPS proxy URLs are used by built-in model calls and `web.fetch`. SOCKS proxy URLs are still passed to the container for shell tools such as `curl`, but built-in model calls and `web.fetch` require an HTTP or HTTPS proxy.

You can also make proxy use explicit in local project YAML:

    backend:
      docker:
        proxy:
          inheritEnv: true
          https: ${HTTPS_PROXY}
          http: ${HTTP_PROXY}
          all: ${ALL_PROXY}
          noProxy: ${NO_PROXY}

If the local proxy only listens on host loopback and is not reachable from Docker bridge networking, use Linux host networking for that project and set `backend.controllerUrl` to `http://127.0.0.1:<port>`:

    backend:
      docker:
        network: host

With `network: host`, Suzumio leaves `127.0.0.1` proxy URLs unchanged because the container shares the host network namespace.

## Long-running Servers

For a long-running server, use a process manager such as systemd, a container supervisor, or a supervised shell session. Bind the server only to trusted interfaces until user-facing API authentication lands.

    suzumio serve --host 127.0.0.1 --port 39400

If Docker containers need to call host support routes, bind to an address reachable from Docker and set `backend.controllerUrl` accordingly.

## Documentation Deployment

The GitHub Pages workflow uploads the static `docs/` directory. The custom domain is configured by `docs/CNAME` and DNS. GitHub may serve the custom domain over HTTP until certificate provisioning finishes; enable HTTPS enforcement once GitHub marks the certificate ready.

<div class="footer">Next: <a href="api.html">HTTP API</a>.</div>
