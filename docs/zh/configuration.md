---
title: "Suzumio YAML 配置"
eyebrow: "YAML 配置"
heroTitle: "用 YAML 编写多 agent 行为"
lead: "Suzumio 项目就是 YAML 文件。好的 YAML 会定义任务、分配 agent 职责、谨慎授予工具，并告诉团队什么时候等待、汇报、审查和提交。"
---

## 解析流程

Suzumio 把配置当作 source material，而不是可变运行时状态。运行 `suzumio init` 时，loader 会执行与 `suzumio config render` 相同的步骤，并把结果保存为 `resolved.yaml`。

    source YAML
      -> quote bare @import(...) markers
      -> substitute environment placeholders in text
      -> parse YAML
      -> resolve whole-field imports recursively
      -> apply extends profiles
      -> apply defaults and validate
      -> write resolved.yaml and SQLite project config

`suzumio config render path/to/project.yaml` 会打印 Suzumio 实际运行的完整配置。

## 最小项目

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

这个项目只有一个 agent。Multi-agent 项目通常包含一个 coordinator 和至少一个 specialist。

## 如何设计 Multi-Agent YAML

可以把 YAML 想成团队的小型作业流程。好的文件会回答五个问题。

| 问题 | YAML 位置 | 好答案 |
|------|-----------|--------|
| 什么算成功？ | `task` | 写清最终报告应包含什么，以及哪些结论不能假装已经证明。 |
| 谁负责协调？ | `agents.pm` 或类似 agent | 只给一个 agent `completion.submit`，让它负责等待和整合。 |
| 谁做实际工作？ | worker agents | 给 worker 狭窄 prompt，并且只给它需要的工具。 |
| 谁检查质量？ | critic/checker agent | 给它审查指令，并要求 ACCEPT/REVISE 这类明确 verdict。 |
| 证据如何共享？ | `shell.exec` 和 `/artifacts/<agent-id>` | 告诉会用工具的 agent 把脚本、日志、笔记、输出写到自己的 artifact 目录，再用 message 告知路径。 |

### 通常有效的 Prompt 规则

- 把持久项目要求放在 `task`，不要只放进某个 agent 的 prompt。
- 每个 agent 都写 role-specific prompt，不要把整个流程脚本塞给所有人。
- 告诉 PM：发出的请求在收到回复或明确作废前都算 outstanding。
- 告诉 worker：先发送有用结果；如果已经汇报完、只是等待下一步，就调用 `coordination.wait_for_signal` 并设置 `notifyPm:false`。
- 只把 `completion.submit` 给最终负责判断是否完成的 agent。
- 只把 `shell.exec` 给需要运行代码或写文件的 agent。

## 模式 1：PM + 两个 Worker + Critic

模式范围：证明、研究摘要、设计评审，以及需要比较独立尝试的任务。

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

角色分工结果：

- `pm` 负责提交和协调。
- worker 可以使用工具和共享文件，但不能提交最终答案。
- critic 默认不需要 shell；它审查文本和 artifact path。

## 模式 2：Python 实验团队

模式范围：带脚本、命令输出和 artifact 路径的小实验。

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
      Keep scripts small and auditable. Send pm the path, command, output summary,
      and limitations. Then wait with notifyPm:false.
    tools:
      - shell.exec
      - messages.send
      - coordination.wait_for_signal
```

Worker message 包含：

```text
Wrote /artifacts/experimenter/search.py and /artifacts/experimenter/run.log.
Command: python3 /artifacts/experimenter/search.py
Result: no counterexample found up to n=8.
Limitations: brute force only, no proof beyond n=8.
```

## 模式 3：Web Research + 保守 Summarizer

模式范围：抓取来源并保持最终结论保守。

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

Proxy 设置可以在 YAML 中声明，也可以继承运行 Suzumio 进程的环境变量：

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

## 模式 4：Review Pipeline

模式范围：code review、写作和设计任务，author 与 reviewer 分离。

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

## 模式 5：Counted Agents

`count` 会把一个角色展开成多个可独立寻址的 agents。

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

这会创建 `solver-1`、`solver-2` 和 `solver-3`。第一次 activation prompt 会包含这些生成 id，可作为 direct message 的精确 recipient。

## 完整结构

下面的例子展示主要字段。大型项目通常会把 task、长 prompt 和可复用 backend 设置拆到 import 或 profile 中。

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

## 顶层字段

| 字段            | 是否必需 | 说明                                                                                          |
|-----------------|----------|-----------------------------------------------------------------------------------------------|
| `name`          | 是       | `SUZUMIO_ROOT` 下的项目 id 和运行目录名。                                                     |
| `task`          | 是       | 持久任务描述，会渲染进第一次 activation prompt，并通过 agent history 延续。                    |
| `agents`        | 是       | Agent id 到 agent config 的映射。至少需要一个 agent。                                         |
| `tools`         | 否       | 项目的 toolpack 注册。默认包含 `core` 和 `web`；`shell` 添加容器内 bash。详见 [Toolpacks](toolpacks.html)。 |
| `extends`       | 否       | 一个 profile object 或 profile object 列表，在本地字段之前合并。                              |
| `scheduler`     | 否       | Scheduler 选项。默认覆盖 signal delivery、`P0` interrupt、`P1` tool-boundary delivery 和 `P2` activation delivery。 |
| `backend`       | 否       | Docker runner image、controller support URL、Docker options 和 model runner 设置。            |
| `channels`      | 否       | 允许的频道名。默认包含 `#project` 和 `#blocked`。                                             |
| `observability` | 否       | 文档层面的 HTTP/WebUI 默认值。实际 server bind 地址仍由 CLI flags 控制。                      |

## YAML 写法约定

Suzumio 使用普通 YAML map、array、scalar 和 block string。长 task 与 prompt 通常使用 block string 或导入文件。

| 写法           | 用途                                         | 例子              |
|----------------|----------------------------------------------|-------------------|
| Block scalar   | 多行 task 和 prompt。                        | `task: |`         |
| Quoted strings | Channel 名称和包含特殊符号的字符串。         | `"#project"`      |
| Arrays         | Tools、channels、profile lists。             | `- messages.send` |
| Maps           | Agents、providers、presets、Docker options。 | `agents: { ... }` |

    task: |
      Write the final result as a short report.
      Mention any assumptions and artifacts.

    channels:
      - "#project"
      - "#blocked"

## Whole-field Imports

当某个字段的完整值是 `@import(path)` 时，该字段会被导入文件替换。关键点是：import marker 必须占满整个字段值。Suzumio 不支持在更大的字符串里做插值。

    task: @import(tasks/main.md)
    agents:
      pm: @import(agents/pm.yaml)
      worker:
        prompt: @import(prompts/worker.md)

如果导入的 YAML 或 JSON 文件包含 object，该 object 会成为 import 位置的值。如果导入 Markdown 或 text 文件，完整文本会成为 import 位置的值。

| 导入文件          | Suzumio 如何读取                          | 常见用途                                       |
|-------------------|-------------------------------------------|------------------------------------------------|
| `.yaml` 或 `.yml` | 作为 YAML 解析，并继续解析其中的 import。 | Agents、backend profiles、scheduler profiles。 |
| `.json`           | 作为 JSON 解析，并继续解析其中的 import。 | 生成的 model preset maps 或 tool lists。       |
| 其他扩展名        | 作为 UTF-8 原始文本导入。                 | Tasks、prompts、report templates。             |

### Import 路径

Import 路径相对包含该 import 的文件解析，而不是相对进程工作目录解析。嵌套 profile 可以稳定地导入自己旁边的 fragment。

    # configs/project.yaml
    agents:
      pm: @import(agents/pm.yaml)

    # configs/agents/pm.yaml
    role: project-manager
    prompt: @import(../prompts/pm.md)

### 有效和无效写法

| 写法                                       | 结果                                               |
|--------------------------------------------|----------------------------------------------------|
| `prompt: @import(prompts/pm.md)`           | 有效。字段值会被文件内容替换。                     |
| `pm: @import(agents/pm.yaml)`              | 有效。导入对象成为 `agents.pm`。                   |
| `prompt: "Read this: @import(x.md)"`       | 不会作为 import 处理。它只是普通字符串；不做插值。 |
| `url: @import(https://example.com/x.yaml)` | 拒绝。禁用 HTTP import。                           |

### 嵌套对象例子

如果 `agents/pm.yaml` 内容如下，导入到 `agents.pm` 时会完整保留这个嵌套结构。

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

Suzumio 会拒绝循环 import 和过深的 import 链。

## Extends 和合并规则

`extends` 用来复用 profile。每个 entry 必须解析成 object。Suzumio 会按顺序合并 profile，然后把当前文件合并到最上层。

    extends:
      - @import(profiles/base.yaml)
      - @import(profiles/ai.yaml)

    name: theorem-project
    task: @import(tasks/theorem.md)

    agents:
      worker:
        count: 3

| 合并情况            | 行为                            |
|---------------------|---------------------------------|
| Object 合并 object  | 递归 deep-merge。               |
| Array 合并 array    | 后面的 array 替换前面的 array。 |
| Scalar 合并任意值   | 后面的 scalar 替换前面的值。    |
| 当前文件 vs profile | 当前文件胜出。                  |

### Profile 合并例子

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

Resolved result：profile 中的 `backend.image` 保留，本地 `backend.runner.mode` 覆盖，`channels` 整体替换而不是 append。

## Scheduler Defaults

默认 scheduler 是 signal-driven：idle agent 会因 pending signal 醒来，`P0` 会中断并重启 running agent，`P1` 会尽量在下一次 tool boundary 投递，`P2` 等待下一次 activation。`scheduler.maxSignalsPerActivation` 默认值是 20。

`scheduler.quietAgentMonitor` 会在配置的 agent 保持 `quiet` 超过指定时间后发送普通 `messages.send` 通知。不会创建真实 monitor agent。

```yaml
scheduler:
  quietAgentMonitor:
    enabled: true
    rules:
      - id: formalizer-watch
        agent: formalizer-1
        recipient: pm
        sender: monitor
        priority: P2
        initialDelayMs: 1800000   # quiet 30 分钟后首次提醒
        repeatDelayMs: 900000     # 仍然 quiet 时每 15 分钟重复提醒
        message: |
          {{agent}} has been quiet for {{quietMinutes}} minutes.
          Please check whether it needs a follow-up assignment.
```

`message` 模板支持 `{{project}}`、`{{agent}}`、`{{recipient}}`、`{{sender}}`、`{{quietMs}}`、`{{quietMinutes}}`、`{{quietSince}}`、`{{now}}`、`{{attempt}}`、`{{initialDelayMs}}`、`{{repeatDelayMs}}` 和 `{{ruleId}}`。

Suzumio 会在 SQLite 中保存每个 agent 的模型历史。每次 activation prompt、可见 assistant 输出、tool call、tool result 和 compaction marker 都会 append 到 history。Runner 下一次调用模型时会把 active history 重新传给模型。当 provider 因 context window 超限而拒绝请求时，旧 history 会被总结成 compaction message，compact 前的完整 raw 范围会本地归档，然后 runner retry 当前 activation。

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

| 字段             | 说明                                                                                                     |
|------------------|----------------------------------------------------------------------------------------------------------|
| `kind`           | Backend implementation。当前 backend 基于 Docker。                                                       |
| `image`          | 每个 activation container 使用的 Docker image。                                                          |
| `controllerUrl`  | 容器访问 Suzumio support routes 并提交 activation output 的 URL。本地 Docker 通常使用 `host.docker.internal`。 |
| `docker.network` | 可选 Docker network mode。                                                                               |
| `docker.proxy`   | 可选代理配置，会传入 runner 容器。显式配置会覆盖继承的环境变量。                                          |
| `docker.mounts`  | 显式挂载到每个 activation container 的 host 文件或目录。Source 会在 render 时相对顶层项目配置解析。      |
| `runner.mode`    | 只支持 `ai`。                                                                                            |

`docker.proxy` 字段包括 `inheritEnv`、`http`、`https`、`all`、`noProxy` 和 `rewriteLocalhost`。默认情况下，Suzumio 会继承 controller 进程中的标准代理环境变量，并在 bridge-network 容器中把 loopback 代理 host 改写为 `host.docker.internal`。Linux 上的 `network: host` 会让 host-loopback proxy URL 在容器中直接可达。

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

Model 选择是显式的。`backend.runner.model` 设置项目级选择；`agents.*.model` 设置 per-agent 选择。带 `model-list` 的 preset 会展开成有序 fallback 列表，runner 会按顺序尝试其中的 concrete preset。多数配置里，`model` 同时也是 provider-facing model id。`apiModel` 用来分离本地 preset 名称和 provider-facing model id。

Agent history compaction 是 Docker chat runner 的一部分，不暴露成用户配置面。Model preset 的 `contextLimit` 默认值是 `260000`；它是模型配置 metadata，不会主动触发 compaction。Runner 只在 provider 报告 context-window overflow 时 compact。

<div class="notice danger">

提交到仓库的示例使用 `baseURLEnv` 和 `apiKeyEnv`。真实 endpoint 和 key 保留在环境变量中。

</div>

## Toolpacks

    tools:
      toolpacks:
        - core
        - shell
        - web

| Toolpack    | 注册工具                                                                                                        | 运行位置                                  |
|-------------|-----------------------------------------------------------------------------------------------------------------|-------------------------------------------|
| `core`      | `messages.send`, `coordination.wait_for_signal`, `completion.submit`, `file.read`, `file.write`, `file.patch`   | Runner container + Suzumio support API    |
| `shell`     | `shell.exec`                                                                                                    | Docker runner container                   |
| `web`       | `web.fetch`                                                                                                     | Docker runner container                   |

`tools.toolpacks` 注册项目 tool definitions。`agents.<id>.tools` 控制 agent 可以看到哪些已注册工具。内置 file tools 可以授权 `file.*`，也可以写精确名称如 `file.read`、`file.patch`。

Local toolpacks、manifest 字段、runner module、controller module 和 file/artifact 行为见 [Toolpacks](toolpacks.html)。

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

| 字段          | 说明                                                                                                |
|---------------|-----------------------------------------------------------------------------------------------------|
| `role`        | 随 agent 保存的人类可读角色。                                                                       |
| `displayName` | 单个 agent 的人类可读名字，或 counted agents 的 fallback 名字。                                     |
| `names`       | Counted agents 的可选名字列表，按 index 分配。                                                      |
| `count`       | 将一个配置项展开为 `worker-1`、`worker-2` 等编号 agents。                                           |
| `prompt`      | 每个 activation prompt 中包含的 agent instructions，通常从 Markdown 导入。                          |
| `model`       | 该 agent 的显式 model preset 选择。若省略，则必须设置 `backend.runner.model`。                      |
| `tools`       | 该 agent 允许调用的工具名。支持精确名称、`namespace.*` 和 `*`，并且工具也必须由项目 toolpack 注册。 |
| `mounts`      | 只挂载给这个 agent 的 host 文件或目录。                                                             |
| `env`         | 传给 runner containers 的附加环境变量。                                                             |

`tools.toolpacks` 只是为项目注册可用 tool definitions；`agents.<id>.tools` 才是每个 agent 的 allowlist。内置 file tools 可以授权 `file.*`，也可以写精确名称如 `file.read`、`file.patch`。如果 agent allowlist 中写了某个工具，但没有任何已注册 toolpack 提供它，调用仍会失败。

## Channels

    channels:
      - "#project"
      - "#blocked"
      - "#reviews"

发送到未声明 channel 的消息会失败。

## 验证流程

    suzumio config render path/to/project.yaml
    suzumio init path/to/project.yaml
    suzumio status project-name

Rendered output 会显示 array replacement、继承来的 model 设置，以及 provider endpoint/key 环境变量名。

<div class="footer">下一步：<a href="toolpacks.html">Toolpacks</a>。</div>
