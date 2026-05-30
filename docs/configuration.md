---
title: "Suzumio Configuration"
eyebrow: "Configuration"
heroTitle: "Project YAML reference"
lead: "A Suzumio project is declared in YAML, resolved into one canonical config, and then stored with the project. The config describes the task, agents, message channels, Docker backend, scheduler, and model presets."
---

## Resolution Pipeline

Suzumio treats configuration as source material, not as mutable runtime state. When you run `suzumio init`, the loader performs the same steps as `suzumio config render` and stores the result as `resolved.yaml`.

    source YAML
      -> quote bare @import(...) markers
      -> substitute environment placeholders in text
      -> parse YAML
      -> resolve whole-field imports recursively
      -> apply extends profiles
      -> apply defaults and validate
      -> write resolved.yaml and SQLite project config

Use `suzumio config render path/to/project.yaml` before review or initialization. It is the easiest way to see the exact config Suzumio will run.

## Minimal Project

    name: demo
    task: |
      Demonstrate one non-preemptive activation.

    backend:
      runner:
        mode: ai
        model: main
        models:
          providers:
            gateway:
              type: openai-compatible
              baseURL: https://your-gateway.example/v1
              apiKeyEnv: SUZUMIO_GATEWAY_API_KEY
          presets:
            main:
              provider: gateway
              model: gpt-5.5
              apiModel: gpt-5.5

    tools:
      toolpacks:
        - core

    agents:
      pm:
        role: project-manager
        displayName: Yuki
        prompt: |
          Handle the user request and stay concise.
        tools:
          - messages.send

## Complete Shape

The example below shows the main fields in one file. Most projects should split task text, long prompts, and reusable backend settings into imports or profiles.

    name: research-demo
    task: @import(tasks/main.md)

    scheduler:
      kind: nonpreemptive-signals
      intervalMs: 2000
      maxPromptMessages: 20

    channels:
      - "#project"
      - "#blocked"
      - "#reviews"

    backend:
      kind: docker-chat
      image: suzumio-runner:dev
      controllerUrl: http://host.docker.internal:39400
      docker:
        network: bridge
      runner:
        mode: ai
        model: worker-with-fallback
        models:
          providers:
            gateway:
              type: openai-compatible
              baseURL: https://your-gateway.example/v1
              apiKeyEnv: SUZUMIO_GATEWAY_API_KEY
              timeoutMs: 300000
          presets:
            worker-main:
              provider: gateway
              model: gpt-5.5
              apiModel: gpt-5.5
              toolChoice: auto
              maxOutputTokens: 2000
            pm-main:
              provider: gateway
              model: gpt-5.5
              apiModel: gpt-5.5
              toolChoice: auto
              maxOutputTokens: 2000
            worker-with-fallback:
              model-list:
                - worker-main
                - pm-main

    tools:
      toolpacks:
        - core
        - shell
        - web

    agents:
      pm:
        role: project-manager
        displayName: Yuki
        prompt: @import(prompts/pm.md)
        model: pm-main
        tools:
          - messages.send
          - coordination.wait_for_signal
          - completion.submit
      worker:
        role: worker
        count: 2
        names:
          - Akari
          - Ren
        prompt: @import(prompts/worker.md)
        model: worker-with-fallback
        tools:
          - messages.send
          - shell.exec
          - web.fetch

## Top-level Fields

| Field           | Required | Description                                                                                                             |
|-----------------|----------|-------------------------------------------------------------------------------------------------------------------------|
| `name`          | Yes      | Project id and runtime directory name under `SUZUMIO_ROOT`.                                                             |
| `task`          | Yes      | Durable task statement rendered into every activation prompt.                                                           |
| `agents`        | Yes      | Map of agent ids to agent configs. At least one agent is required.                                                      |
| `tools`         | No       | Toolpacks registered for the project. Defaults to `core` and `web`; add `shell` for container-local bash and shared artifact files. |
| `extends`       | No       | One profile object or a list of profile objects to merge before local fields.                                           |
| `scheduler`     | No       | Scheduler kind and prompt-signal batching. Defaults to `nonpreemptive-signals`.                                         |
| `backend`       | No       | Docker runner image, controller support URL, Docker options, and model runner settings.                                 |
| `channels`      | No       | Allowed channel names. Defaults include `#project` and `#blocked`.                                                      |
| `observability` | No       | Documentation-level server defaults for HTTP/WebUI. The CLI flags still control the actual server bind address.         |

## YAML Conventions

Suzumio uses ordinary YAML maps, arrays, scalars, and block strings. Keep long text in block strings or imported files so rendered prompts are readable.

| Pattern        | Use it for                                          | Example           |
|----------------|-----------------------------------------------------|-------------------|
| Block scalar   | Tasks and prompts with multiple lines.              | `task: |`         |
| Quoted strings | Channel names and strings that contain punctuation. | `"#project"`      |
| Arrays         | Tools, channels, profile lists.                     | `- messages.send` |
| Maps           | Agents, providers, presets, Docker options.         | `agents: { ... }` |

    task: |
      Write the final result as a short report.
      Mention any assumptions and artifacts.

    channels:
      - "#project"
      - "#blocked"

## Whole-field Imports

A field whose entire value is `@import(path)` is replaced by the imported file. This is the key rule: the import marker must occupy the whole field value. Suzumio does not support string interpolation inside a larger string.

    task: @import(tasks/main.md)
    agents:
      pm: @import(agents/pm.yaml)
      worker:
        prompt: @import(prompts/worker.md)

If an imported YAML or JSON file contains an object, that object becomes the value at the import site. If an imported Markdown or text file is used, its full text becomes the value at the import site.

| Imported file     | How Suzumio reads it                                 | Typical use                                   |
|-------------------|------------------------------------------------------|-----------------------------------------------|
| `.yaml` or `.yml` | Parsed as YAML, then imports inside it are resolved. | Agents, backend profiles, scheduler profiles. |
| `.json`           | Parsed as JSON, then imports inside it are resolved. | Generated model preset maps or tool lists.    |
| Other extension   | Imported as raw UTF-8 text.                          | Tasks, prompts, report templates.             |

### Import paths

Import paths are resolved relative to the file that contains the import, not relative to the process working directory. That means nested profile files can import their own neighboring fragments predictably.

    # configs/project.yaml
    agents:
      pm: @import(agents/pm.yaml)

    # configs/agents/pm.yaml
    role: project-manager
    prompt: @import(../prompts/pm.md)

### Valid and invalid import forms

| Form                                       | Result                                                                                     |
|--------------------------------------------|--------------------------------------------------------------------------------------------|
| `prompt: @import(prompts/pm.md)`           | Valid. The field value is replaced by the file content.                                    |
| `pm: @import(agents/pm.yaml)`              | Valid. The imported object becomes `agents.pm`.                                            |
| `prompt: "Read this: @import(x.md)"`       | Invalid for import purposes. It remains an ordinary string; no interpolation is performed. |
| `url: @import(https://example.com/x.yaml)` | Rejected. HTTP imports are disabled.                                                       |

### Nested object example

If `agents/pm.yaml` contains the fields below, importing it at `agents.pm` preserves that nesting exactly.

    # agents/pm.yaml
    role: project-manager
    prompt: @import(../prompts/pm.md)
    tools:
      - messages.send
      - completion.submit

    # resolved shape
    agents:
      pm:
        role: project-manager
        prompt: "...contents of prompts/pm.md..."
        tools:
          - messages.send
          - completion.submit

Import loops and excessive import depth are rejected so a project cannot accidentally create an infinite config expansion.

## Extends and Merge Rules

`extends` is for reusable profiles. Each entry must resolve to an object. Suzumio merges profile objects from first to last, then merges the local file on top.

    extends:
      - @import(profiles/base.yaml)
      - @import(profiles/ai.yaml)

    name: theorem-project
    task: @import(tasks/theorem.md)

    agents:
      worker:
        count: 3

| Merge case            | Behavior                                     |
|-----------------------|----------------------------------------------|
| Object into object    | Deep-merged recursively.                     |
| Array into array      | The later array replaces the earlier array.  |
| Scalar into any value | The later scalar replaces the earlier value. |
| Local file vs profile | The local file wins.                         |

### Profile merge example

    # profiles/base.yaml
    backend:
      image: suzumio-runner:dev
      runner:
        mode: ai
    channels:
      - "#project"
      - "#blocked"

    # project.yaml
    extends:
      - @import(profiles/base.yaml)
    name: demo
    task: @import(tasks/demo.md)
    backend:
      runner:
        mode: ai
    channels:
      - "#project"
      - "#reviews"

    # important resolved effects
    backend.image: suzumio-runner:dev
    backend.runner.mode: ai
    channels: ["#project", "#reviews"]

The backend object deep-merges, so `backend.image` remains from the profile while `backend.runner.mode` is overridden locally. The channels array is replaced, not appended.

## Scheduler Config

    scheduler:
      kind: nonpreemptive-signals
      intervalMs: 2000
      maxPromptMessages: 20

| Field               | Description                                                                                       |
|---------------------|---------------------------------------------------------------------------------------------------|
| `kind`              | `nonpreemptive-signals` is the default. `nonpreemptive-mailbox` is accepted as a compatibility alias. |
| `intervalMs`        | Intended scheduler loop interval. The current server uses a fixed loop aligned with this default. |
| `maxPromptMessages` | Maximum pending signals rendered into one activation prompt.                                      |

## Backend Config

    backend:
      kind: docker-chat
      image: suzumio-runner:dev
      controllerUrl: http://host.docker.internal:39400
      docker:
        network: bridge
        proxy:
          inheritEnv: true
          https: ${HTTPS_PROXY}
          http: ${HTTP_PROXY}
          all: ${ALL_PROXY}
          noProxy: ${NO_PROXY}
        mounts:
          - source: ./reference
            target: /mnt/reference
            readonly: true
            description: Project reference material for agents.
      runner:
        mode: ai

| Field            | Description                                                                                                                                        |
|------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| `kind`           | Backend implementation. The current backend is Docker-based.                                                                                       |
| `image`          | Docker image used for each activation container.                                                                                                   |
| `controllerUrl`  | URL the container uses to call Suzumio support routes and submit activation output. For local Docker, use `host.docker.internal`.                  |
| `docker.network` | Optional Docker network mode.                                                                                                                      |
| `docker.proxy`   | Optional proxy configuration passed into runner containers. Explicit values override inherited environment variables.                              |
| `docker.mounts`  | Explicit host files or directories mounted into every activation container. Sources are resolved relative to the top-level project config during render. |
| `runner.mode`    | Only `ai` is supported.                                                                                                                            |

`docker.proxy` fields are `inheritEnv`, `http`, `https`, `all`, `noProxy`, and `rewriteLocalhost`. By default Suzumio inherits standard proxy env vars from the controller process and rewrites loopback proxy hosts to `host.docker.internal` for bridge-network containers. Use `network: host` on Linux if the proxy only listens on host loopback.

## AI Runner Config

    backend:
      runner:
        mode: ai
        model: worker-with-fallback
        models:
          providers:
            gateway:
              type: openai-compatible
              baseURL: https://your-gateway.example/v1
              apiKeyEnv: SUZUMIO_GATEWAY_API_KEY
              timeoutMs: 300000
          presets:
            worker-main:
              provider: gateway
              model: gpt-5.5
              apiModel: gpt-5.5
              toolChoice: auto
              maxOutputTokens: 2000
            pm-main:
              provider: gateway
              model: gpt-5.5
              apiModel: gpt-5.5
            worker-with-fallback:
              model-list:
                - worker-main
                - pm-main

Model selection is explicit. Set `backend.runner.model` for a project-level selection, or set `agents.*.model` per agent. Presets with `model-list` expand to an ordered fallback list; the runner tries each concrete preset in order.

<div class="notice danger">

Committed examples must stay sanitized. Put real provider endpoints and keys in local untracked config and environment variables.

</div>

## Toolpacks

    tools:
      toolpacks:
        - core
        - shell
        - web

| Toolpack    | Registered tools                                        | Runs in                                 |
|-------------|---------------------------------------------------------|-----------------------------------------|
| `core`      | `messages.send`, `coordination.wait_for_signal`, `completion.submit` | Runner wrapper with Suzumio support API |
| `shell`     | `shell.exec`                                            | Docker runner container                 |
| `web`       | `web.fetch`                                             | Docker runner container                 |

Mounted inputs are host files or directories exposed at configured container paths. Suzumio renders those paths into the activation prompt. Agents with `shell.exec` can copy them into `/workspace`, compile code, run binaries, and write durable outputs to `/artifacts/<agent-id>`. The current agent's artifact directory is read-write; other agents' artifact directories are read-only.

### Local toolpacks

Local toolpacks are loaded from directories on the controller host and mounted read-only into runner containers.

    tools:
      toolpacks:
        - core
        - path: ./toolpacks/review
          id: review-tools

Each local directory must contain `suzumio.toolpack.json` and ESM `.mjs` modules:

    {
      "id": "review-tools",
      "runner": "runner.mjs",
      "controller": "controller.mjs",
      "tools": [
        {
          "name": "review.summarize",
          "description": "Summarize review findings.",
          "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        }
      ]
    }

The id must contain only letters, digits, `.`, `_`, and `-`. HTTP(S) toolpack paths are rejected. TypeScript runtime transpilation is not provided; publish JavaScript `.mjs` files.

Runner modules implement model-facing tools in the container. Controller modules implement support for tools that need project state. Both sides receive a context with `recordSignal`; create a pending signal by setting `targetAgent`, or create a closed useful effect by omitting the target and setting `usefulEffect: true`.

## Agent Config

    agents:
      worker:
        role: worker
        count: 2
        names:
          - Akari
          - Ren
        prompt: @import(prompts/worker.md)
        model: worker-with-fallback
        tools:
          - messages.send
          - shell.exec
          - web.fetch
        mounts:
          - source: ./worker-notes
            target: /mnt/worker-notes
            readonly: true

| Field         | Description                                                                                                                              |
|---------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `role`        | Human-readable role stored with the agent.                                                                                               |
| `displayName` | Human-readable name for a single agent or the fallback name for counted agents.                                                          |
| `names`       | Optional name list for counted agents, assigned by index.                                                                                |
| `count`       | Expands one config entry into numbered agents such as `worker-1` and `worker-2`.                                                         |
| `prompt`      | Agent instructions included in every activation prompt. Usually imported from Markdown.                                                  |
| `model`       | Explicit model preset selection for this agent. If omitted, `backend.runner.model` must be set.                                          |
| `tools`       | Allowed tool names for this agent. Supports exact names, `namespace.*`, and `*`. The tool must also be registered by a project toolpack. |
| `mounts`      | Explicit host files or directories mounted only for this agent.                                                                          |
| `env`         | Additional environment variables for runner containers.                                                                                  |

## Channels

    channels:
      - "#project"
      - "#blocked"
      - "#reviews"

Channel messages to undeclared channels fail. This prevents accidental creation of noisy or misspelled channels.

## Validation Workflow

    suzumio config render path/to/project.yaml
    suzumio init path/to/project.yaml
    suzumio status project-name

Render configs in code review, especially when using multiple profiles. Check the resolved output for unexpected array replacement, unexpected inherited model settings, and private endpoints that should stay local.

<div class="footer">Next: <a href="cli.html">CLI Reference</a>.</div>
