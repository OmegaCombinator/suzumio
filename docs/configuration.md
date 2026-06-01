---
title: "Suzumio YAML Configuration"
eyebrow: "YAML Configuration"
heroTitle: "Write multi-agent behavior in YAML"
lead: "Suzumio projects are YAML files. A good YAML file defines the task, assigns agent responsibilities, grants tools deliberately, and tells the team when to wait, report, review, or submit."
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
              baseURLEnv: SUZUMIO_GATEWAY_BASE_URL
              apiKeyEnv: SUZUMIO_GATEWAY_API_KEY
          presets:
            main:
              provider: gateway
              model: gpt-5.5

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

This project has only one agent, so it is useful for smoke tests but not for real collaboration. Real multi-agent YAML usually starts with a coordinator and at least one specialist.

## How To Design A Multi-Agent YAML

Think of the YAML as a small operating procedure for a team. A good file answers five questions.

| Question | YAML place | Good answer |
|----------|------------|-------------|
| What is success? | `task` | Say what the final report should contain and what not to fake. |
| Who coordinates? | `agents.pm` or similar | Give one agent `completion.submit`; make it responsible for waiting and merging. |
| Who does work? | worker agents | Give workers narrow prompts and only the tools they need. |
| Who checks quality? | critic/checker agent | Give it review instructions and ask for ACCEPT/REVISE style verdicts. |
| How is evidence shared? | `shell.exec` and `/artifacts/<agent-id>` | Tell tool-using agents to save scripts, logs, notes, and outputs under their artifact directory, then message the path. |

### Prompt Rules That Usually Work

- Put durable project requirements in `task`, not only in one agent prompt.
- Give each agent a role-specific prompt, not the whole workflow script.
- Tell PM agents that requests are outstanding until answered or explicitly superseded.
- Tell worker agents to send the useful result, then call `coordination.wait_for_signal` with `notifyPm:false` if they are waiting.
- Give `completion.submit` only to the agent that should decide final readiness.
- Give `shell.exec` only to agents that should run code or write files.

## Pattern 1: PM + Two Workers + Critic

Use this for proofs, research summaries, design reviews, or any task where independent attempts should be compared.

```yaml
name: reviewed-research
task: |
  Produce a conservative research note. Separate checked facts,
  plausible ideas, failed attempts, and remaining gaps.

tools:
  toolpacks: [core, shell, web]

agents:
  pm:
    role: research-coordinator
    prompt: |
      Delegate substantive work to the workers. Track outstanding requests.
      Send candidate conclusions to critic before submitting. If waiting for
      requested replies, call coordination.wait_for_signal.
    tools:
      - messages.send
      - coordination.wait_for_signal
      - completion.submit

  worker:
    role: researcher
    count: 2
    names: [Akari, Ren]
    prompt: |
      Work independently on the request you receive. Send pm your best result,
      including assumptions, uncertainty, and artifact paths. If you already
      reported and are waiting, call coordination.wait_for_signal with notifyPm:false.
    tools:
      - messages.send
      - coordination.wait_for_signal
      - shell.exec
      - web.fetch

  critic:
    role: reviewer
    displayName: Mio
    prompt: |
      Review claims for unsupported leaps. Send pm ACCEPT, ACCEPT-with-edits,
      or REVISE, with the smallest concrete issue to fix.
    tools:
      - messages.send
      - coordination.wait_for_signal
```

Why this works:

- `pm` owns submission and coordination.
- Workers can use tools and shared files but cannot submit.
- The critic does not need shell by default; it reviews text and artifact paths.

## Pattern 2: Python Experiment Team

Use this when you want agents to run small experiments instead of only talking.

```yaml
tools:
  toolpacks: [core, shell]

agents:
  pm:
    role: experiment-lead
    prompt: |
      Ask the experimenter for a reproducible script and output. Do not submit
      until the artifact path and conclusion are both in conversation history.
    tools:
      - messages.send
      - coordination.wait_for_signal
      - completion.submit

  experimenter:
    role: python-experimenter
    prompt: |
      Use shell.exec to write scripts and outputs under /artifacts/experimenter.
      Prefer small, auditable scripts. Send pm the path, command, output summary,
      and limitations. Then wait with notifyPm:false.
    tools:
      - shell.exec
      - messages.send
      - coordination.wait_for_signal
```

A good worker message should include:

```text
Wrote /artifacts/experimenter/search.py and /artifacts/experimenter/run.log.
Command: python3 /artifacts/experimenter/search.py
Result: no counterexample found up to n=8.
Limitations: brute force only, no proof beyond n=8.
```

## Pattern 3: Web Research With A Conservative Summarizer

Use this when a worker should fetch sources but the final answer must not overclaim.

```yaml
tools:
  toolpacks: [core, web]

agents:
  pm:
    role: summary-editor
    prompt: |
      Ask researcher for source-backed notes. Keep claims conservative and cite
      which statements came from fetched sources versus model memory.
    tools:
      - messages.send
      - coordination.wait_for_signal
      - completion.submit

  researcher:
    role: source-checker
    prompt: |
      Use web.fetch for lightweight source checks. Quote only short relevant
      snippets and include URLs. If a source cannot be fetched, say so.
    tools:
      - web.fetch
      - messages.send
      - coordination.wait_for_signal
```

If your network needs a proxy, put it in YAML or inherit it from the process environment:

```yaml
backend:
  docker:
    network: host
    proxy:
      inheritEnv: true
      rewriteLocalhost: false
      http: ${HTTP_PROXY}
      https: ${HTTPS_PROXY}
```

## Pattern 4: Review Pipeline

Use this for code review, writing, or design tasks where the author should not approve their own output.

```yaml
agents:
  author:
    role: draft-author
    prompt: |
      Produce the draft requested by pm. Write longer files under /artifacts/author
      if useful, then message pm with the path.
    tools:
      - messages.send
      - coordination.wait_for_signal
      - shell.exec

  reviewer:
    role: reviewer
    prompt: |
      Review the draft. Prioritize concrete bugs, missing evidence, and unclear
      claims. Send pm a verdict and minimal required edits.
    tools:
      - messages.send
      - coordination.wait_for_signal

  pm:
    role: editor
    prompt: |
      Route the request to author, send the draft to reviewer, and submit only
      after review is incorporated or explicitly rejected with reason.
    tools:
      - messages.send
      - coordination.wait_for_signal
      - completion.submit
```

## Pattern 5: Counted Agents

Use `count` when several agents share the same role but should work independently.

```yaml
agents:
  solver:
    role: proof-worker
    count: 3
    names: [Akari, Ren, Sora]
    prompt: |
      Try an independent route. Do not coordinate with other solvers unless pm asks.
      Report your route, exact assumptions, and smallest gap.
    tools:
      - messages.send
      - coordination.wait_for_signal
```

This creates `solver-1`, `solver-2`, and `solver-3`. The first activation prompt includes these generated ids so the team can send direct messages with exact recipients.

## Complete Shape

The example below shows the main fields in one file. Most projects should split task text, long prompts, and reusable backend settings into imports or profiles.

    name: research-demo
    task: @import(tasks/main.md)

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
              baseURLEnv: SUZUMIO_GATEWAY_BASE_URL
              apiKeyEnv: SUZUMIO_GATEWAY_API_KEY
              timeoutMs: 300000
          presets:
            worker-main:
              provider: gateway
              model: gpt-5.5
              toolChoice: auto
              maxOutputTokens: 2000
            pm-main:
              provider: gateway
              model: gpt-5.5
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
| `scheduler`     | No       | Advanced scheduler options. Most projects should omit it and use the defaults.                                          |
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

## Scheduler Defaults

Most projects should omit `scheduler`. The default is signal-driven and non-preemptive: idle agents wake for pending signals, and running agents are not interrupted. Advanced projects may set `scheduler.kind` or `scheduler.maxSignalsPerActivation`; the default signal batch size is 20.

Activation prompts include bounded continuity context instead of replaying the entire project log. By default Suzumio includes up to 30 recent visible messages, 6 previous activation outputs for that agent, 3000 characters per history message, and 6000 characters per activation excerpt. Override `scheduler.messageHistoryLimit`, `scheduler.activationHistoryLimit`, `scheduler.maxHistoryMessageChars`, or `scheduler.maxHistoryActivationChars` only for projects that need more context and have enough model window.

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
              baseURLEnv: SUZUMIO_GATEWAY_BASE_URL
              apiKeyEnv: SUZUMIO_GATEWAY_API_KEY
              timeoutMs: 300000
          presets:
            worker-main:
              provider: gateway
              model: gpt-5.5
              reasoningEffort: high
              toolChoice: auto
              maxOutputTokens: 2000
            pm-main:
              provider: gateway
              model: gpt-5.5
            worker-with-fallback:
              model-list:
                - worker-main
                - pm-main

Model selection is explicit. Set `backend.runner.model` for a project-level selection, or set `agents.*.model` per agent. Presets with `model-list` expand to an ordered fallback list; the runner tries each concrete preset in order. In most configs, `model` is also the provider model id. Use `apiModel` only when you want the local preset name to differ from the provider-facing model id.

<div class="notice danger">

Committed examples must stay sanitized. Prefer `baseURLEnv` and `apiKeyEnv` so real provider endpoints and keys stay in environment variables.

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
