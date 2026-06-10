---
title: "Suzumio YAML Reference"
eyebrow: "YAML Reference"
heroTitle: "Every project field in one place"
lead: "Suzumio projects are YAML files. The resolved YAML defines the task, agents, tool registration, scheduler policy, Docker runner, model presets, channels, and local observability defaults."
---

## Resolution Pipeline

`suzumio config render path/to/project.yaml` prints the same resolved config that `suzumio init` stores as `resolved.yaml`.

```text
source YAML
  -> quote bare @import(...) markers
  -> substitute environment placeholders in text
  -> parse YAML
  -> resolve whole-field imports recursively
  -> apply extends profiles
  -> apply defaults and validate
  -> write resolved.yaml and SQLite project config
```

The resolved config is runtime source material. Editing the original YAML after initialization does not mutate an already initialized project until it is rendered and initialized again.

## Minimal Shape

```yaml
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
      - coordination.wait_for_signal
      - completion.submit
```

## Top-Level Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | None | Project id and runtime directory name under `SUZUMIO_ROOT`. |
| `task` | Yes | None | Durable task statement rendered into the first activation prompt and preserved through agent history. |
| `agents` | Yes | None | Map of agent ids to agent configs. At least one agent is required. |
| `tools` | No | `toolpacks: [core, web]` | Project toolpack registration. Agent configs still need per-agent tool allowlists. |
| `scheduler` | No | Signal scheduler defaults | Signal delivery, nudges, and quiet monitor settings. |
| `communication` | No | Coordinator `pm`, no coordinator-only restriction | Prompt-level communication policy rendered into activation prompts. |
| `backend` | No | Docker chat runner defaults | Docker image, controller URL, mounts, proxy, AI runner, and model registry. |
| `channels` | No | `#project`, `#blocked` | Allowed channel names for channel messages. |
| `extends` | No | None | Profile object or list of profile objects merged before local fields. |
| `observability` | No | HTTP/WebUI enabled on `127.0.0.1:39400` | Documentation-level server defaults. CLI flags still control the actual bind address. |

## `name` And `task`

```yaml
name: theorem-search
task: |
  Produce a concise report.
  Separate proven facts, experiments, failed attempts, and remaining gaps.
```

`name` becomes the project id in CLI commands and the directory name under `SUZUMIO_ROOT`. `task` is rendered into the first activation prompt for each agent.

## `agents`

```yaml
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
    role: researcher
    count: 2
    names: [Akari, Ren]
    prompt: @import(prompts/worker.md)
    model: worker-main
    tools:
      - messages.send
      - coordination.wait_for_signal
      - shell.exec
    mounts:
      - source: ./reference
        target: /mnt/reference
        readonly: true
    env:
      EXPERIMENT_MODE: quick
```

| Field | Default | Description |
|-------|---------|-------------|
| `role` | Agent id | Human-readable role stored with the agent. |
| `displayName` | Agent id | Human-readable display name. |
| `names` | None | Optional names for counted agents, assigned by index. |
| `count` | None | Expands one config entry into numbered agents such as `worker-1` and `worker-2`. |
| `prompt` | Empty string | Agent instructions included in every activation prompt. |
| `model` | `backend.runner.model` | Model preset for this agent. |
| `tools` | Empty list | Per-agent model-visible tool allowlist. Supports exact names, `namespace.*`, and `*`. |
| `mounts` | Empty list | Host files or directories mounted only for this agent. |
| `env` | Empty map | Extra environment variables for this agent's runner containers. |

Counted agents use generated ids. The example above creates `worker-1` and `worker-2`; their configured display names are `Akari` and `Ren`.

## `tools`

```yaml
tools:
  toolpacks:
    - core
    - shell
    - web
    - path: ./toolpacks/scheduler
      id: scheduler
    - path: ./toolpacks/review
      id: review-tools
```

| Entry | Registered tools |
|-------|------------------|
| `core` | `messages.send`, `coordination.wait_for_signal`, `completion.submit`, `file.read`, `file.write`, `file.patch` |
| `shell` | `shell.exec` |
| `web` | `web.fetch` |
| Local `toolpacks/scheduler` | `schedule.once`, `schedule.recurring`, `schedule.list`, `schedule.cancel`, plus scheduled-message WebUI controls and a scheduler hook. |
| Local `{ path, id }` | Model-facing tools and optional WebUI entries declared by `suzumio.toolpack.json` in that directory. |

`tools.toolpacks` registers definitions for the project. `agents.<id>.tools` allowlists which registered tools a model can see. Built-in file tools can be granted with `file.*` or exact names such as `file.read` and `file.patch`. Toolpack WebUI entries are user-facing controls and do not use the per-agent model allowlist.

Custom toolpack details live in [Custom Tools](toolpacks.html).

## `scheduler`

```yaml
scheduler:
  kind: nonpreemptive-signals
  maxSignalsPerActivation: 20
  noEffectNudge:
    enabled: true
    priority: P2
    maxConsecutive: 0
    initialDelayMs: 30000
    backoffFactor: 2
    maxDelayMs: 300000
  failedNudge:
    enabled: false
    priority: P2
    maxConsecutive: 3
    initialDelayMs: 60000
    backoffFactor: 2
    maxDelayMs: 900000
  allQuietNudge:
    enabled: false
    targetAgent: pm
    priority: P2
    cooldownMs: 300000
  quietAgentMonitor:
    enabled: true
    rules:
      - id: worker-watch
        agent: worker-1
        recipient: pm
        sender: monitor
        priority: P2
        initialDelayMs: 1800000
        repeatDelayMs: 900000
        message: "{{agent}} has been quiet for {{quietMinutes}} minutes."
  failedAgentMonitor:
    enabled: true
    rules:
      - id: worker-failed-watch
        agent: worker-1
        recipient: pm
        sender: monitor
        priority: P2
        initialDelayMs: 300000
        repeatDelayMs: 900000
        message: "{{agent}} has been failed for {{failedMinutes}} minutes after {{activationId}}."
```

| Field | Default | Description |
|-------|---------|-------------|
| `kind` | `nonpreemptive-signals` | Signal-driven scheduler. `nonpreemptive-mailbox` is accepted as an alias. |
| `maxSignalsPerActivation` | `20` | Maximum pending signals included at activation start. |
| `noEffectNudge.enabled` | `true` | Creates a follow-up nudge when an activation completes with no useful effect. |
| `noEffectNudge.priority` | `P2` | Priority for no-effect nudge signals. |
| `noEffectNudge.maxConsecutive` | `0` | Maximum consecutive nudges after no-effect activations. `0` means no limit. |
| `noEffectNudge.initialDelayMs` | `30000` | Initial nudge delay. |
| `noEffectNudge.backoffFactor` | `2` | Exponential backoff multiplier. |
| `noEffectNudge.maxDelayMs` | `300000` | Maximum nudge delay. |
| `failedNudge.enabled` | `false` | Creates a delayed self-directed retry signal when an agent remains `failed` with no pending signal. |
| `failedNudge.priority` | `P2` | Priority for failed retry signals. |
| `failedNudge.maxConsecutive` | `3` | Maximum consecutive automatic retries after failed activations. `0` means no limit. |
| `failedNudge.initialDelayMs` | `60000` | Delay before the first failed retry signal. |
| `failedNudge.backoffFactor` | `2` | Exponential backoff multiplier for later failed retry signals. |
| `failedNudge.maxDelayMs` | `900000` | Maximum failed retry delay. |
| `failedNudge.message` | Built-in text | Nudge body rendered to the failed agent. |
| `allQuietNudge.enabled` | `false` | Creates a scheduler signal when all agents are quiet and no pending signals exist. |
| `allQuietNudge.targetAgent` | `pm` | Agent that receives the all-quiet nudge. |
| `allQuietNudge.priority` | `P2` | Priority for all-quiet nudge signals. |
| `allQuietNudge.cooldownMs` | `300000` | Minimum time between all-quiet nudges. |
| `allQuietNudge.message` | Built-in text | Nudge body rendered into the scheduler signal. |
| `quietAgentMonitor.enabled` | `false` | Enables quiet-agent monitor rules. |
| `quietAgentMonitor.rules` | Empty list | List of quiet-agent monitor rules. |
| `failedAgentMonitor.enabled` | `false` | Enables failed-agent monitor rules. |
| `failedAgentMonitor.rules` | Empty list | List of failed-agent monitor rules. |

Priorities are `P0`, `P1`, `P2`, and `P3`. `P2` is intended for control-flow or continuation signals that should run before routine backlog. Routine queued messages default to `P3`.

Quiet-agent monitor rule fields:

| Field | Default | Description |
|-------|---------|-------------|
| `id` | Derived from index, agent, sender, recipient | Stable rule key for dedupe. |
| `enabled` | `true` | Enables this rule. |
| `agent` | Required | Agent id to monitor while it is `quiet`. |
| `recipient` | `pm` | Message recipient. Must be `user` or an existing agent. |
| `sender` | `monitor` | Virtual message sender. No real sender agent is created. |
| `priority` | `P2` | Message priority. |
| `initialDelayMs` | `1800000` | Quiet duration before the first message. |
| `repeatDelayMs` | `900000` | Repeat interval while the same quiet state continues. |
| `message` | Built-in text | Template body for the monitor message. |

Monitor templates support `{{project}}`, `{{agent}}`, `{{recipient}}`, `{{sender}}`, `{{quietMs}}`, `{{quietMinutes}}`, `{{quietSince}}`, `{{now}}`, `{{attempt}}`, `{{initialDelayMs}}`, `{{repeatDelayMs}}`, and `{{ruleId}}`.

Failed-agent monitor rules use the same fields, but trigger while the agent is `failed`. Their templates also support `{{failedMs}}`, `{{failedMinutes}}`, `{{failedSince}}`, `{{activationId}}`, and `{{error}}`.

## `communication`

```yaml
communication:
  coordinatorAgent: pm
  restrictNonCoordinatorToCoordinator: true
  nonCoordinatorMaxPriority: P2
  pmRoutineVerifierPriority: P3
```

| Field | Default | Description |
|-------|---------|-------------|
| `coordinatorAgent` | `pm` | Agent treated as the coordinator in rendered prompts. |
| `restrictNonCoordinatorToCoordinator` | `false` | Prompt contract that directs non-coordinators to message only the coordinator. |
| `nonCoordinatorMaxPriority` | `P2` | Prompt-level max priority for non-coordinator routine messages. |
| `pmRoutineVerifierPriority` | `P3` | Prompt-level default for routine PM review/delegation messages. |

This section shapes activation instructions. Tool authorization still comes from `agents.<id>.tools`.

## `backend`

```yaml
backend:
  kind: docker-chat
  image: suzumio-runner:dev
  controllerUrl: http://host.docker.internal:39400
  docker:
    network: bridge
    proxy:
      inheritEnv: true
      rewriteLocalhost: true
      https: ${HTTPS_PROXY}
      http: ${HTTP_PROXY}
      all: ${ALL_PROXY}
      noProxy: ${NO_PROXY}
    mounts:
      - source: ./reference
        target: /mnt/reference
        readonly: true
        description: Project reference material.
  runner:
    mode: ai
    model: worker-main
```

| Field | Default | Description |
|-------|---------|-------------|
| `kind` | `docker-chat` | Current backend implementation. |
| `image` | `suzumio-runner:dev` | Docker image used for activation containers. |
| `controllerUrl` | `http://host.docker.internal:39400` | URL used by containers to call Suzumio support routes and submit output. |
| `docker.network` | None | Docker network mode. Linux host networking uses `host`. |
| `docker.mounts` | Empty list | Host files or directories mounted into every activation container. |
| `docker.proxy` | Inherit env, rewrite localhost | Proxy config passed into runner containers. |
| `runner` | `mode: ai` | AI runner config. |

Mount fields:

| Field | Default | Description |
|-------|---------|-------------|
| `source` | Required | Host path. Relative paths resolve against the top-level project YAML during render. |
| `target` | Required | Container path. Use non-reserved paths such as `/mnt/reference`. |
| `readonly` | `true` | Mount access. |
| `description` | None | Text included in activation prompts. |

Proxy fields are `inheritEnv`, `http`, `https`, `all`, `noProxy`, and `rewriteLocalhost`. With bridge networking, loopback proxy hosts are rewritten to `host.docker.internal` when `rewriteLocalhost` is true. With `network: host`, host-loopback proxy URLs remain reachable directly from the container.

## `backend.runner` And Models

```yaml
backend:
  runner:
    mode: ai
    model: worker-with-fallback
    maxIterations: 20
    maxToolCalls: 80
    models:
      providers:
        gateway:
          type: openai-compatible
          baseURLEnv: SUZUMIO_GATEWAY_BASE_URL
          apiKeyEnv: SUZUMIO_GATEWAY_API_KEY
          timeoutMs: 300000
          chunkTimeoutMs: 60000
          headers: {}
          options: {}
      presets:
        worker-main:
          provider: gateway
          model: gpt-5.5
          apiModel: gpt-5.5
          reasoningEffort: high
          temperature: 0.2
          topP: 1
          maxOutputTokens: 8000
          contextLimit: 260000
          toolChoice: auto
        worker-with-fallback:
          model-list:
            - worker-main
            - backup-main
```

Runner fields:

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | `ai` | Only `ai` is supported. |
| `model` | None | Project-level model preset name. Agents can override with `agents.<id>.model`. |
| `maxIterations` | Provider/runtime default | Optional cap on model loop iterations. |
| `maxToolCalls` | Provider/runtime default | Optional cap on tool calls in one activation. |
| `models.providers` | Empty map | Provider registry. |
| `models.presets` | Empty map | Named model presets and fallback lists. |

Provider fields:

| Field | Default | Description |
|-------|---------|-------------|
| `type` | Required | `openai`, `anthropic`, `google`, or `openai-compatible`. |
| `apiKey` | None | Inline API key. Kept out of committed examples. |
| `apiKeyEnv` | None | Environment variable name for API key. |
| `baseURL` | None | Inline provider base URL. Kept out of committed examples when private. |
| `baseURLEnv` | None | Environment variable name for provider base URL. |
| `headers` | `{}` | Extra provider headers. |
| `timeoutMs` | Provider default | Total request timeout, or `false`. |
| `chunkTimeoutMs` | Provider default | Streaming chunk timeout. |
| `options` | `{}` | Provider-specific options. |

Preset fields:

| Field | Default | Description |
|-------|---------|-------------|
| `provider` | Required for concrete preset | Provider registry key. |
| `model` | Required for concrete preset | Local and provider-facing model id unless `apiModel` is set. |
| `apiModel` | None | Provider-facing model id when different from local preset model. |
| `model-list` | None | Ordered fallback list. Cannot be combined with concrete provider/model fields. |
| `reasoningEffort` | None | Provider-facing reasoning effort. |
| `temperature` | None | Provider-facing temperature. |
| `topP` | None | Provider-facing top-p. |
| `topK` | None | Provider-facing top-k. |
| `maxOutputTokens` | None | Provider-facing output token cap. |
| `contextLimit` | `260000` | Metadata for context overflow handling. |
| `toolChoice` | None | `auto`, `required`, or `none`. |
| `providerOptions` | `{}` | Preset-level provider-specific options. |
| `headers` | `{}` | Preset-level headers. |

Committed examples use `baseURLEnv` and `apiKeyEnv`. Real provider endpoints and keys stay in environment variables.

## `channels`

```yaml
channels:
  - "#project"
  - "#blocked"
  - "#reviews"
```

Channel messages to undeclared channels fail. Defaults are `#project` and `#blocked`.

## `observability`

```yaml
observability:
  http:
    enabled: true
    host: 127.0.0.1
    port: 39400
  webui:
    enabled: true
```

These values document intended server defaults in YAML. The `suzumio serve` command flags control the actual bind address and port for a running process.

## YAML Conventions

| Pattern | Typical value | Example |
|---------|---------------|---------|
| Block scalar | Multi-line task and prompt text. | `task: |` |
| Quoted strings | Channel names and punctuation-heavy strings. | `"#project"` |
| Arrays | Tools, channels, profiles. | `- messages.send` |
| Maps | Agents, providers, presets, Docker options. | `agents: { ... }` |

## Whole-Field Imports

A field whose entire value is `@import(path)` is replaced by the imported file. The import marker must occupy the whole field value.

```yaml
task: @import(tasks/main.md)
agents:
  pm: @import(agents/pm.yaml)
  worker:
    prompt: @import(prompts/worker.md)
```

| Imported file | Resolution |
|---------------|------------|
| `.yaml` or `.yml` | Parsed as YAML, then imports inside it are resolved. |
| `.json` | Parsed as JSON, then imports inside it are resolved. |
| Other extension | Imported as raw UTF-8 text. |

Import paths are resolved relative to the file containing the import. HTTP imports are rejected. Import loops and excessive import depth are rejected.

## `extends` And Merge Rules

```yaml
extends:
  - @import(profiles/base.yaml)
  - @import(profiles/ai.yaml)

name: theorem-project
task: @import(tasks/theorem.md)
```

Each `extends` entry resolves to an object. Suzumio merges profile objects from first to last, then merges the local file on top.

| Merge case | Behavior |
|------------|----------|
| Object into object | Deep-merged recursively. |
| Array into array | Later array replaces earlier array. |
| Scalar into any value | Later scalar replaces earlier value. |
| Local file vs profile | Local file wins. |

## Validation Workflow

```bash
suzumio config render path/to/project.yaml
suzumio init path/to/project.yaml
suzumio status project-name
```

The rendered output shows defaults, imports, array replacement, inherited model settings, provider endpoint/key environment-variable names, and normalized local toolpack paths.

<div class="footer">Next: <a href="quickstart.html">Initialize And Run</a>.</div>
