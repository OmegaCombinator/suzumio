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

评审或初始化前建议运行 `suzumio config render path/to/project.yaml`。它会展示 Suzumio 实际运行的完整配置。

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
              baseURL: https://your-gateway.example/v1
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

这个项目只有一个 agent，适合 smoke test，但不是真正的协作。实际的 multi-agent YAML 通常从一个 coordinator 和至少一个 specialist 开始。

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

适合证明、研究摘要、设计评审，或者任何需要比较独立尝试的任务。

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

这个模式有效的原因：

- `pm` 负责提交和协调。
- worker 可以使用工具和共享文件，但不能提交最终答案。
- critic 默认不需要 shell；它审查文本和 artifact path。

## 模式 2：Python 实验团队

适合希望 agent 实际运行小实验，而不只是互相聊天的任务。

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

好的 worker message 应该包含：

```text
Wrote /artifacts/experimenter/search.py and /artifacts/experimenter/run.log.
Command: python3 /artifacts/experimenter/search.py
Result: no counterexample found up to n=8.
Limitations: brute force only, no proof beyond n=8.
```

## 模式 3：Web Research + 保守 Summarizer

适合需要 worker 抓取来源，但最终答案必须避免过度断言的任务。

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

如果网络需要 proxy，可以在 YAML 中声明，或者继承运行 Suzumio 进程的环境变量：

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

适合 code review、写作或设计任务：作者不应该自己批准自己的输出。

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

多个 agent 共享同一个角色、但应该独立工作时，使用 `count`。

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

这会创建 `solver-1`、`solver-2` 和 `solver-3`。第一次 activation prompt 会包含这些生成 id，方便团队用精确 recipient 发送 direct message。

## 完整结构

下面的例子展示主要字段。实际项目通常会把 task、长 prompt 和可复用 backend 设置拆到 import 或 profile 中。

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
              baseURL: https://your-gateway.example/v1
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
| `task`          | 是       | 持久任务描述，会渲染进每个 activation prompt。                                                |
| `agents`        | 是       | Agent id 到 agent config 的映射。至少需要一个 agent。                                         |
| `tools`         | 否       | 项目注册的 toolpacks。默认包含 `core` 和 `web`；需要容器内 bash 和共享 artifact 文件时添加 `shell`。 |
| `extends`       | 否       | 一个 profile object 或 profile object 列表，在本地字段之前合并。                              |
| `scheduler`     | 否       | 高级 scheduler 选项。多数项目应省略它并使用默认值。                                           |
| `backend`       | 否       | Docker runner image、controller support URL、Docker options 和 model runner 设置。            |
| `channels`      | 否       | 允许的频道名。默认包含 `#project` 和 `#blocked`。                                             |
| `observability` | 否       | 文档层面的 HTTP/WebUI 默认值。实际 server bind 地址仍由 CLI flags 控制。                      |

## YAML 写法约定

Suzumio 使用普通 YAML map、array、scalar 和 block string。长文本建议使用 block string 或导入文件，这样 resolved prompt 更容易阅读。

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

Suzumio 会拒绝循环 import 和过深的 import 链，避免项目意外无限展开配置。

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

`backend` 是 object，所以会 deep-merge：profile 中的 `backend.image` 保留，本地 `backend.runner.mode` 覆盖。`channels` 是 array，所以整体替换，不会自动 append。

## Scheduler Defaults

多数项目应省略 `scheduler`。默认行为是 signal-driven 且非抢占：idle agent 会因 pending signal 醒来，running agent 不会被打断。高级项目可以设置 `scheduler.kind` 或 `scheduler.maxSignalsPerActivation`；默认每次 activation 最多投递 20 个 pending signals。

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

`docker.proxy` 字段包括 `inheritEnv`、`http`、`https`、`all`、`noProxy` 和 `rewriteLocalhost`。默认情况下，Suzumio 会继承 controller 进程中的标准代理环境变量，并在 bridge-network 容器中把 loopback 代理 host 改写为 `host.docker.internal`。如果代理只监听 host loopback，在 Linux 上可使用 `network: host`。

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

Model 选择是显式的。可以在 `backend.runner.model` 设置项目级选择，或在 `agents.*.model` 为每个 agent 设置。带 `model-list` 的 preset 会展开成有序 fallback 列表；runner 会按顺序尝试其中的 concrete preset。多数配置里，`model` 同时也是 provider-facing model id。只有当本地 preset 名称需要和 provider API 模型名不同时，才使用 `apiModel`。

<div class="notice danger">

提交到仓库的示例必须保持脱敏。真实 endpoint 和 key 应放在本地未跟踪配置或环境变量中。

</div>

## Toolpacks

    tools:
      toolpacks:
        - core
        - shell
        - web

| Toolpack    | 注册工具                                                | 运行位置                             |
|-------------|---------------------------------------------------------|--------------------------------------|
| `core`      | `messages.send`, `coordination.wait_for_signal`, `completion.submit` | Runner wrapper + Suzumio support API |
| `shell`     | `shell.exec`                                            | Docker runner container              |
| `web`       | `web.fetch`                                             | Docker runner container              |

Mounted inputs 是通过配置挂载到容器路径的 host 文件或目录。Suzumio 会把这些路径渲染进 activation prompt。拥有 `shell.exec` 的 agent 可以把它们复制到 `/workspace`、编译代码、运行二进制，并把持久输出写到 `/artifacts/<agent-id>`。当前 agent 的 artifact 目录可写；其他 agent 的 artifact 目录只读。

### Local toolpacks

Local toolpack 从 controller host 上的目录加载，并只读挂载进 runner container。

    tools:
      toolpacks:
        - core
        - path: ./toolpacks/review
          id: review-tools

每个 local 目录必须包含 `suzumio.toolpack.json` 和 ESM `.mjs` 模块：

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

id 只能包含字母、数字、`.`、`_` 和 `-`。HTTP(S) toolpack path 会被拒绝。当前不提供 TypeScript runtime transpilation；请发布 JavaScript `.mjs` 文件。

Runner module 在容器内实现模型可见工具。Controller module 为需要项目状态的工具提供 support。两侧 context 都有 `recordSignal`；设置 `targetAgent` 会创建 pending signal，省略 target 并设置 `usefulEffect: true` 会创建 closed useful effect。

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

## Channels

    channels:
      - "#project"
      - "#blocked"
      - "#reviews"

发送到未声明 channel 的消息会失败。这样可以避免拼写错误产生噪音频道。

## 验证流程

    suzumio config render path/to/project.yaml
    suzumio init path/to/project.yaml
    suzumio status project-name

使用多个 profile 时尤其要在 review 中渲染配置。检查 resolved output 中是否有意外的 array replacement、继承来的 model 设置，以及不应该提交的私有 endpoint。

<div class="footer">下一步：<a href="cli.html">CLI 参考</a>。</div>
