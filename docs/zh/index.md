---
title: "Suzumio 文档"
description: "Suzumio 是一个 YAML-based multi-agent system，用 Docker activation 运行智能体团队。"
eyebrow: "用 YAML 定义多智能体项目"
heroTitle: "写一个 YAML，运行一组智能体"
lead: "Suzumio 让你用一个 YAML 项目文件描述 multi-agent workflow：任务、agents、prompts、tools、Docker runner、模型 presets 和调度策略。Runtime 会把 YAML 变成持久消息、signals、activations、共享文件和最终提交。"
actions:
  - text: "从 YAML 开始"
    link: "quickstart.html"
    variant: "primary"
  - text: "YAML 参考"
    link: "configuration.html"
  - text: "Toolpacks"
    link: "toolpacks.html"
    variant: "blue"
---

## 核心想法

Suzumio 是一个 YAML-based multi-agent system。你不是先写 orchestration code，而是先写一个项目文件，说明：

- 项目要完成什么；
- 有哪些 agents；
- 每个 agent 可以做什么；
- agent coordination rules；
- 使用哪个 Docker runner 和模型 presets。

Runtime 负责协调细节：把状态存进 SQLite、启动 Docker activation、把消息变成 signal、应用 priority 规则、挂载共享文件，并记录 tool calls。

## 一个最小项目

这是最小可用形状。一个 `pm` agent 接收用户消息，可以给用户或其他 agent 发消息，可以等待未来 signal，也可以提交最终报告。

```yaml
name: tiny-research
task: |
  Answer the user's question carefully. If you are missing information,
  ask a follow-up instead of pretending.

tools:
  toolpacks:
    - core

agents:
  pm:
    role: project-manager
    displayName: Yuki
    prompt: |
      You coordinate the project. Keep a short working memory in your messages.
      Submit only when the answer is ready for the user.
    tools:
      - messages.send
      - coordination.wait_for_signal
      - completion.submit
```

运行：

```bash
suzumio config render tiny-research.yaml
suzumio init tiny-research.yaml
suzumio serve --host 0.0.0.0 --port 39400
suzumio start tiny-research
suzumio send tiny-research pm P1 "Start."
```

## YAML 如何变成多智能体行为

| YAML 字段 | 控制什么 | Runtime 中发生什么 |
|-----------|----------|--------------------|
| `task` | 共享项目目标 | 渲染进第一次 activation prompt。 |
| `agents` | roster 和 prompts | 每个 agent 都变成一个持久参与者，有自己的 workspace 和共享 artifact 目录。 |
| `agents.<id>.tools` | 模型可见工具 allowlist | worker 不能调用未授权工具。 |
| `tools.toolpacks` | 可用工具家族 | `core` 提供 messages/wait/submit/file tools；`shell` 提供 bash；`web` 提供 HTTP fetch。 |
| `scheduler` | signal 投递策略 | 有 pending signal 的 idle agent 会获得一次 activation；`P0` 可以中断 running activation。 |
| `backend` | Docker/model/proxy 设置 | runner image、controller URL、模型 presets、mounts、network 和 proxy 都从 YAML 解析。 |

## 默认协作循环

1. 用户给某个 agent 发消息，通常是 `pm`。
2. 消息变成 pending `message.created` signal。
3. Scheduler 为 idle target agent 启动一个 Docker activation。
4. Agent 可以发消息、跑工具、写 `/artifacts/<agent-id>` 文件、等待或提交。
5. 如果它给另一个 agent 发消息，就为对方创建 pending signal。
6. 如果它调用 `coordination.wait_for_signal`，activation 干净结束，agent 保持 quiet。
7. 如果它调用 `completion.submit`，项目变成 submitted，并写出最终报告。

## 好的 YAML 会产生好的协作

最重要的设计能力不是写很长的 prompt，而是分清职责，并给每个 agent 刚好够用的工具。

PM 用于：

- 项目需要分派任务；
- 多份报告需要合并；
- 需要有人判断最终答案是否 ready。

Workers 用于：

- 任务可以独立探索；
- 你希望有多个尝试、实验或证明；
- 你希望 PM 比较证据，而不是自己凭空完成全部工作。

Critic/checker 用于：

- 最终输出需要审查；
- 幻觉式确定性很危险；
- workers 可能给出互相矛盾的 claims。

`shell.exec` 用于：

- agent 运行 Python、测试、脚本或本地搜索；
- 结果保存到 `/artifacts/<agent-id>`；
- 证据比纯文字更重要。

## 可复制模式

先看 [快速开始](quickstart.html) 跑一个完整 YAML 项目，再看 [配置](configuration.html) 里的可复制模式：PM + workers、PM + critic、Python 实验团队、web research 和 review pipeline。

## 项目目录

`suzumio init` 后，runtime root 中会出现由 YAML 生成的项目状态：

```text
$SUZUMIO_ROOT/tiny-research/
  suzumio.sqlite      持久项目数据库
  source.yaml         原始项目配置
  resolved.yaml       完整解析后的配置
  agents/             每个 agent 的 workspace
  artifacts/          每个 agent 的共享文件
  activations/        activation input 目录
  logs/               预留运行日志目录
```

## 下一步

| 目标 | 阅读 |
|------|------|
| 跑第一个 YAML 项目 | [快速开始](quickstart.html) |
| 学习所有 YAML 字段 | [配置](configuration.html) |
| 配置内置或 local tools | [Toolpacks](toolpacks.html) |
| 理解 messages、signals 和 activations | [核心概念](concepts.html) |
| 用终端运维项目 | [CLI 参考](cli.html) |
| 集成或围绕 Suzumio 做 UI | [HTTP API](api.html) |

<div class="footer">当前站点：<a href="https://suzumio.aixmath.org">suzumio.aixmath.org</a>。源码：<a href="https://github.com/OmegaCombinator/suzumio">OmegaCombinator/suzumio</a>。</div>
