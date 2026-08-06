---
title: "Suzumio YAML Reference"
eyebrow: "YAML Reference"
heroTitle: "所有项目字段集中说明"
lead: "Suzumio 项目是 YAML 文件。Resolved YAML 定义 task、agents、tool registration、scheduler policy、Docker runner、model presets、channels 和本地 observability defaults。"
---

## 解析流程

`suzumio config render path/to/project.yaml` 会打印与 `suzumio init` 存入 `resolved.yaml` 相同的 resolved config。

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

Resolved config 是 runtime source material。初始化后修改原始 YAML，不会自动改变已初始化 project；需要重新 render 和 init。

## 最小结构

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

## 顶层字段

| 字段 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | 是 | 无 | Project id，也是 `SUZUMIO_ROOT` 下的 runtime directory name。 |
| `task` | 是 | 无 | 持久 task statement，会渲染进第一次 activation prompt，并通过 agent history 延续。 |
| `agents` | 是 | 无 | Agent id 到 agent config 的 map。至少需要一个 agent。 |
| `tools` | 否 | `toolpacks: [core, web]` | Project toolpack registration。Agent 仍需要 per-agent tool allowlist。 |
| `platforms` | 否 | Empty list | 可选外部聊天平台 bridge，例如 Feishu。 |
| `scheduler` | 否 | Signal scheduler defaults | Signal delivery、nudges 和 quiet monitor 设置。 |
| `communication` | 否 | Coordinator `pm`，不限制 coordinator-only | 渲染进 activation prompt 的 communication policy。 |
| `backend` | 否 | Docker chat runner defaults | Docker image、controller URL、mounts、proxy、AI runner 和 model registry。 |
| `channels` | 否 | `#project`, `#blocked` | Channel messages 允许使用的 channel names。 |
| `extends` | 否 | 无 | 在 local fields 前合并的 profile object 或 profile object list。 |
| `observability` | 否 | HTTP/WebUI enabled on `127.0.0.1:39400` | YAML 中记录的 server defaults。实际 bind address 由 CLI flags 控制。 |

## `name` 和 `task`

```yaml
name: theorem-search
task: |
  Produce a concise report.
  Separate proven facts, experiments, failed attempts, and remaining gaps.
```

`name` 是 CLI commands 使用的 project id，也是 `SUZUMIO_ROOT` 下的目录名。`task` 会渲染进每个 agent 的第一次 activation prompt。

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

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `role` | Agent id | 随 agent 保存的人类可读 role。 |
| `displayName` | Agent id | 人类可读 display name。 |
| `names` | 无 | Counted agents 的可选名字，按 index 分配。 |
| `count` | 无 | 将一个 config entry 展开为 `worker-1`、`worker-2` 等编号 agents。 |
| `prompt` | Empty string | 每个 activation prompt 中包含的 agent instructions。 |
| `model` | `backend.runner.model` | 该 agent 使用的 model preset。 |
| `tools` | Empty list | Per-agent model-visible tool allowlist。支持 exact names、`namespace.*` 和 `*`。 |
| `mounts` | Empty list | 只挂载给该 agent 的 host files 或 directories。 |
| `env` | Empty map | 传给该 agent runner containers 的额外 environment variables。 |

Counted agents 使用 generated ids。上面的例子会创建 `worker-1` 和 `worker-2`，display names 是 `Akari` 和 `Ren`。

## `tools`

```yaml
tools:
  toolpacks:
    - core
    - shell
    - web
    - path: ./toolpacks/scheduler
      id: scheduler
    - path: ./toolpacks/plan
      id: plan
    - path: ./toolpacks/review
      id: review-tools
```

| Entry | Registered tools |
|-------|------------------|
| `core` | `messages.send`, `coordination.wait_for_signal`, `completion.submit`, `file.read`, `file.write`, `file.patch` |
| `shell` | `shell.exec` |
| `web` | `web.fetch` |
| Local `toolpacks/scheduler` | `schedule.once`、`schedule.recurring`、`schedule.list`、`schedule.cancel`，以及 scheduled-message WebUI controls 和 scheduler hook。 |
| Local `toolpacks/plan` | `plan.create`、`plan.status`、`plan.update`、`plan.set_item_status`、`plan.close`，以及 active-plan WebUI controls 和 continuation scheduler hook。 |
| Local `{ path, id }` | 该目录中 `suzumio.toolpack.json` 声明的 model-facing tools 和可选 WebUI entries。 |

`tools.toolpacks` 为 project 注册 definitions。`agents.<id>.tools` allowlist 决定模型可以看到哪些已注册 tools。内置 file tools 可以用 `file.*` 授权，也可以写 exact names，例如 `file.read` 和 `file.patch`。Toolpack WebUI entries 是 user-facing controls，不使用 per-agent model allowlist。

自定义 toolpack 细节见 [Custom Tools](toolpacks.html)。

## `platforms`

```yaml
platforms:
  - id: feishu-main
    kind: feishu
    appIdEnv: FEISHU_APP_ID
    appSecretEnv: FEISHU_APP_SECRET
    inbound:
      recipient: pm
      priority: P2
      allowedChatTypes: [group]
      groupMessageMode: bot_mentions
      reactionAck:
        enabled: true
        emojiType: Typing
    outbound:
      recipient: user
      replyToLastInbound: true
```

Platforms 是 Suzumio messages 和外部聊天系统之间的可选 bridge。`suzumio serve` 默认启动 enabled platforms；如果只想运行本地 HTTP/WebUI，不连接外部平台，可以用 `suzumio serve --no-platforms`。

Feishu platform 使用飞书 Node SDK 的长连接接收 `im.message.receive_v1` events。默认只有群聊里 @ 当前机器人的消息会变成 Suzumio 中从 `sender` 发给 `inbound.recipient` 的 message；私聊 `p2p` 和普通群消息会被忽略。把 accepted message 交给 Suzumio 前，bridge 会先给飞书原消息添加 `Typing` reaction，作为 best-effort ack。Suzumio 中 recipient 等于 `outbound.recipient` 的 messages 会推回飞书，优先回复该 project/platform 最近一次收到的飞书消息。

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `id` | Required | Platform id，用于 audit events 和 dedupe。 |
| `kind` | Required | 当前只支持 `feishu`。 |
| `enabled` | `true` | `suzumio serve` 时启用 bridge。 |
| `appId` / `appIdEnv` | `FEISHU_APP_ID` env | 飞书 app id。为避免泄漏 secret，推荐用 `appIdEnv`。 |
| `appSecret` / `appSecretEnv` | `FEISHU_APP_SECRET` env | 飞书 app secret。推荐用 `appSecretEnv`。 |
| `inbound.enabled` | `true` | 通过长连接接收飞书事件。 |
| `inbound.recipient` | `pm` | 接收外部用户消息的 Suzumio agent。 |
| `inbound.priority` | `P2` | 创建 Suzumio message 时使用的 priority。 |
| `inbound.sender` | `user` | 外部消息进入 Suzumio 时使用的 sender id。 |
| `inbound.includeMetadata` | `true` | 在 message body 末尾追加飞书 ids，便于追踪。 |
| `inbound.allowedChatTypes` | `[group]` | 允许进入 Suzumio 的飞书 chat type。只有明确需要私聊进入时才加入 `p2p`。 |
| `inbound.groupMessageMode` | `bot_mentions` | 群聊中只接收 @ 当前机器人的消息。只有明确需要普通群消息进入时才设为 `all`。 |
| `inbound.botOpenId` / `botOpenIdEnv` | `FEISHU_BOT_OPEN_ID` env，然后自动查询 | 用于校验群 @ 是否指向当前 bot 的 `open_id`。未配置时 bridge 会请求 `/open-apis/bot/v3/info`。 |
| `inbound.reactionAck.enabled` | `true` | 在唤醒 PM 前，给 accepted inbound 飞书消息添加 reaction。Reaction 失败会记录 audit event，但不会阻塞 PM 处理。 |
| `inbound.reactionAck.emojiType` | `Typing` | 入站 ack 使用的飞书 reaction `emoji_type`。该值大小写敏感。 |
| `outbound.enabled` | `true` | 轮询 Suzumio events 并把 user-facing messages 发到飞书。 |
| `outbound.recipient` | `user` | 被视为外部用户输出的 Suzumio recipient。 |
| `outbound.replyToLastInbound` | `true` | 尽量回复最近一次 inbound 飞书消息。 |
| `outbound.defaultReceiveId` / `defaultReceiveIdEnv` | None | 没有 inbound route 时的 fallback receive id。 |
| `outbound.defaultReceiveIdType` | `chat_id` | Fallback route 的飞书 id 类型。 |
| `outbound.pollIntervalMs` | `2000` | 轮询新的 Suzumio user-facing messages 的间隔。 |

飞书侧需要创建企业自建应用、启用 Bot、配置 **Receive events through persistent connection**、订阅 `im.message.receive_v1`、添加发送和接收消息权限、发布版本，并把机器人加入目标聊天。群消息中，`im:message.group_at_msg:readonly` 可接收 @ 机器人消息；如果审批通过，`im:message.group_msg:readonly` 可接收 associated group chats 的全量消息。默认 reaction ack 需要 `im:message` 或 `im:message.reactions:write_only` 权限。Suzumio 仍会在创建本地 message 前按 `inbound.allowedChatTypes` 和 `inbound.groupMessageMode` 过滤。

## `scheduler`

```yaml
scheduler:
  kind: nonpreemptive-signals
  maxSignalsPerActivation: 20
  noEffectNudge:
    enabled: true
    priority: P3
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
    priority: P3
    cooldownMs: 300000
  quietAgentMonitor:
    enabled: true
    rules:
      - id: worker-watch
        agent: worker-1
        recipient: pm
        sender: monitor
        priority: P3
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

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `kind` | `nonpreemptive-signals` | Signal-driven scheduler。`nonpreemptive-mailbox` 作为 alias 接受。 |
| `maxSignalsPerActivation` | `20` | Activation start 时最多包含的 pending signals 数量。 |
| `noEffectNudge.enabled` | `true` | Activation 完成但没有 useful effect 时创建 follow-up nudge。 |
| `noEffectNudge.priority` | `P3` | No-effect nudge signal priority。 |
| `noEffectNudge.maxConsecutive` | `0` | 连续 no-effect activations 后最多 nudge 次数。`0` 表示不设上限。 |
| `noEffectNudge.initialDelayMs` | `30000` | 初始 nudge delay。 |
| `noEffectNudge.backoffFactor` | `2` | Exponential backoff multiplier。 |
| `noEffectNudge.maxDelayMs` | `300000` | 最大 nudge delay。 |
| `failedNudge.enabled` | `false` | Agent 保持 `failed` 且没有 pending signal 时，创建 delayed self-directed retry signal。 |
| `failedNudge.priority` | `P2` | Failed retry signal priority。 |
| `failedNudge.maxConsecutive` | `3` | Failed activations 后最多自动 retry 次数。`0` 表示不设上限。 |
| `failedNudge.initialDelayMs` | `60000` | 第一次 failed retry signal 前的 delay。 |
| `failedNudge.backoffFactor` | `2` | 后续 failed retry signals 的 exponential backoff multiplier。 |
| `failedNudge.maxDelayMs` | `900000` | 最大 failed retry delay。 |
| `failedNudge.message` | Built-in text | 渲染给 failed agent 的 nudge body。 |
| `allQuietNudge.enabled` | `false` | 所有 agents quiet 且无 pending signals 时创建 scheduler signal。 |
| `allQuietNudge.targetAgent` | `pm` | 接收 all-quiet nudge 的 agent。 |
| `allQuietNudge.priority` | `P3` | All-quiet nudge signal priority。 |
| `allQuietNudge.cooldownMs` | `300000` | All-quiet nudges 最小间隔。 |
| `allQuietNudge.message` | Built-in text | 渲染进 scheduler signal 的 message。 |
| `quietAgentMonitor.enabled` | `false` | 启用 quiet-agent monitor rules。 |
| `quietAgentMonitor.rules` | Empty list | Quiet-agent monitor rule list。 Each rule defaults to `P3`。 |
| `failedAgentMonitor.enabled` | `false` | 启用 failed-agent monitor rules。 |
| `failedAgentMonitor.rules` | Empty list | Failed-agent monitor rule list。 |

Priority 包括 `P0`、`P1`、`P2`、`P3`。`P2` 用于应优先于 routine backlog 的 control-flow 或 continuation signals。普通 queued messages 默认使用 `P3`。

Quiet-agent monitor rule 字段：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `id` | Derived from index, agent, sender, recipient | 稳定 rule key，用于 dedupe。 |
| `enabled` | `true` | 启用该 rule。 |
| `agent` | Required | 监控的 agent id，只在它是 `quiet` 时触发。 |
| `recipient` | `pm` | Message recipient。必须是 `user` 或 existing agent。 |
| `sender` | `monitor` | Virtual message sender。不会创建真实 sender agent。 |
| `priority` | `P3` | Message priority。 |
| `initialDelayMs` | `1800000` | 首次 message 前的 quiet duration。 |
| `repeatDelayMs` | `900000` | 同一个 quiet state 继续存在时的 repeat interval。 |
| `message` | Built-in text | Monitor message template body。 |

Monitor template 支持 `{{project}}`、`{{agent}}`、`{{recipient}}`、`{{sender}}`、`{{quietMs}}`、`{{quietMinutes}}`、`{{quietSince}}`、`{{now}}`、`{{attempt}}`、`{{initialDelayMs}}`、`{{repeatDelayMs}}` 和 `{{ruleId}}`。

Failed-agent monitor rules 使用同样字段，但只在 agent 是 `failed` 时触发；priority 默认 `P2`。它们的 templates 还支持 `{{failedMs}}`、`{{failedMinutes}}`、`{{failedSince}}`、`{{activationId}}` 和 `{{error}}`。

## `communication`

```yaml
communication:
  coordinatorAgent: pm
  restrictNonCoordinatorToCoordinator: true
  nonCoordinatorMaxPriority: P2
  pmRoutineVerifierPriority: P3
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `coordinatorAgent` | `pm` | Rendered prompt 中的 coordinator agent。 |
| `restrictNonCoordinatorToCoordinator` | `false` | Prompt contract：non-coordinator 只 message coordinator。 |
| `nonCoordinatorMaxPriority` | `P2` | Non-coordinator routine messages 的 prompt-level max priority。 |
| `pmRoutineVerifierPriority` | `P3` | PM routine review/delegation messages 的 prompt-level default。 |

该 section 影响 activation instructions。Tool authorization 仍由 `agents.<id>.tools` 决定。

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

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `kind` | `docker-chat` | 当前 backend implementation。 |
| `image` | `suzumio-runner:dev` | Activation containers 使用的 Docker image。 |
| `controllerUrl` | `http://host.docker.internal:39400` | Containers 调用 Suzumio support routes 和提交 output 的 URL。 |
| `docker.network` | None | Docker network mode。Linux host networking 使用 `host`。 |
| `docker.mounts` | Empty list | 挂载到每个 activation container 的 host files 或 directories。 |
| `docker.proxy` | Inherit env, rewrite localhost | 传入 runner containers 的 proxy config。 |
| `runner` | `mode: ai` | AI runner config。 |

Mount 字段：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `source` | Required | Host path。Relative paths 在 render 时相对 top-level project YAML 解析。 |
| `target` | Required | Container path。使用 `/mnt/reference` 这类 non-reserved paths。 |
| `readonly` | `true` | Mount access。 |
| `description` | None | 渲染进 activation prompts 的描述。 |

Proxy 字段包括 `inheritEnv`、`http`、`https`、`all`、`noProxy` 和 `rewriteLocalhost`。Bridge networking 下，`rewriteLocalhost: true` 会把 loopback proxy hosts 改写为 `host.docker.internal`。`network: host` 下 host-loopback proxy URL 在容器中直接可达。

## `backend.runner` 和 Models

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

Runner 字段：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `mode` | `ai` | 只支持 `ai`。 |
| `model` | None | Project-level model preset name。Agents 可以用 `agents.<id>.model` 覆盖。 |
| `maxIterations` | Provider/runtime default | Optional model loop iterations cap。 |
| `maxToolCalls` | Provider/runtime default | Optional tool calls cap for one activation。 |
| `models.providers` | Empty map | Provider registry。 |
| `models.presets` | Empty map | Named model presets 和 fallback lists。 |

Provider 字段：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `type` | Required | `openai`、`anthropic`、`google` 或 `openai-compatible`。 |
| `apiKey` | None | Inline API key。Committed examples 不写真实值。 |
| `apiKeyEnv` | None | API key environment variable name。 |
| `baseURL` | None | Inline provider base URL。私有 endpoint 不写入 committed examples。 |
| `baseURLEnv` | None | Provider base URL environment variable name。 |
| `headers` | `{}` | Extra provider headers。 |
| `timeoutMs` | Provider default | Total request timeout，或 `false`。 |
| `chunkTimeoutMs` | Provider default | Streaming chunk timeout。 |
| `options` | `{}` | Provider-specific options。 |

Preset 字段：

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `provider` | Required for concrete preset | Provider registry key。 |
| `model` | Required for concrete preset | Local and provider-facing model id，除非设置 `apiModel`。 |
| `apiModel` | None | 与 local preset model 不同的 provider-facing model id。 |
| `model-list` | None | Ordered fallback list。不能与 concrete provider/model fields 同时使用。 |
| `reasoningEffort` | None | Provider-facing reasoning effort。 |
| `temperature` | None | Provider-facing temperature。 |
| `topP` | None | Provider-facing top-p。 |
| `topK` | None | Provider-facing top-k。 |
| `maxOutputTokens` | None | Provider-facing output token cap。 |
| `contextLimit` | `260000` | Context overflow handling metadata。 |
| `toolChoice` | None | `auto`、`required` 或 `none`。 |
| `providerOptions` | `{}` | Preset-level provider-specific options。 |
| `headers` | `{}` | Preset-level headers。 |

Committed examples 使用 `baseURLEnv` 和 `apiKeyEnv`。真实 provider endpoints 和 keys 保留在环境变量中。

## `channels`

```yaml
channels:
  - "#project"
  - "#blocked"
  - "#reviews"
```

发送到未声明 channel 的 message 会失败。默认 channels 是 `#project` 和 `#blocked`。

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

这些值在 YAML 中记录 intended server defaults。实际 running process 的 bind address 和 port 由 `suzumio serve` flags 控制。

## YAML Conventions

| Pattern | Typical value | Example |
|---------|---------------|---------|
| Block scalar | Multi-line task 和 prompt text。 | `task: |` |
| Quoted strings | Channel names 和 punctuation-heavy strings。 | `"#project"` |
| Arrays | Tools、channels、profiles。 | `- messages.send` |
| Maps | Agents、providers、presets、Docker options。 | `agents: { ... }` |

## Whole-Field Imports

完整字段值为 `@import(path)` 时，该字段会被 imported file 替换。Import marker 必须占满整个字段值。

```yaml
task: @import(tasks/main.md)
agents:
  pm: @import(agents/pm.yaml)
  worker:
    prompt: @import(prompts/worker.md)
```

| Imported file | Resolution |
|---------------|------------|
| `.yaml` 或 `.yml` | 作为 YAML 解析，然后继续解析其中的 imports。 |
| `.json` | 作为 JSON 解析，然后继续解析其中的 imports。 |
| 其他扩展名 | 作为 raw UTF-8 text 导入。 |

Import path 相对包含该 import 的文件解析。HTTP imports 会被拒绝。Import loops 和过深 import depth 会被拒绝。

## `extends` 和 Merge Rules

```yaml
extends:
  - @import(profiles/base.yaml)
  - @import(profiles/ai.yaml)

name: theorem-project
task: @import(tasks/theorem.md)
```

每个 `extends` entry 都解析成 object。Suzumio 从前到后合并 profile objects，再把 local file 合并到最上层。

| Merge case | Behavior |
|------------|----------|
| Object into object | Recursively deep-merged。 |
| Array into array | Later array replaces earlier array。 |
| Scalar into any value | Later scalar replaces earlier value。 |
| Local file vs profile | Local file wins。 |

## Validation Workflow

```bash
suzumio config render path/to/project.yaml
suzumio init path/to/project.yaml
suzumio status project-name
```

Rendered output 会显示 defaults、imports、array replacement、inherited model settings、provider endpoint/key environment-variable names，以及 normalized local toolpack paths。

<div class="footer">下一步：<a href="quickstart.html">初始化与运行</a>。</div>
