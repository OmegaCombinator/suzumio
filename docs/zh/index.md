---
title: "Suzumio 文档"
description: "Suzumio 是 Docker-first、非抢占式的多智能体协调运行时。"
eyebrow: "面向长时间运行智能体的 Docker-first 协调"
heroTitle: "Suzumio"
lead: "Suzumio 用非抢占式 mailbox 调度、隔离的 Docker turn、可审计工具、artifact 跟踪、SQLite 状态、CLI、HTTP API 和轻量 WebUI 来协调多智能体项目。"
actions:
  - text: "运行演示"
    link: "quickstart.html"
    variant: "primary"
  - text: "编写配置"
    link: "configuration.html"
  - text: "使用 API"
    link: "api.html"
    variant: "blue"
---

## 用途

Suzumio 适合需要让智能体长时间专注工作的项目，例如形式化、代码工作、研究流程、评审流水线和 benchmark 实验。运行时把进展记录为持久的 turn、message、artifact 和 audit log。

Suzumio 将项目协调与智能体执行分离。核心运行时拥有项目状态和调度逻辑；Docker runner 执行一个智能体 turn，向模型展示工具，只在需要 stateful support 时回调 Suzumio，写回结果，然后退出。

<div class="grid">

<div class="card"><h3>非抢占式调度</h3><p>正在运行的智能体不会被追加 prompt、催促或打断。新的 inbound message 留在 mailbox 中，等待当前 turn 完成。</p></div>

<div class="card"><h3>持久项目状态</h3><p>项目在 SQLite 中保存配置、智能体、消息、消息读取记录、turn、事件、工具调用和 artifact。</p></div>

<div class="card"><h3>Docker-first 执行</h3><p>每个 turn 在容器中运行，包含只读 turn input、agent workspace、runner-local shell/web tools 和 HTTP 结果提交。</p></div>

<div class="card"><h3>Allowlisted tools</h3><p>项目 toolpacks 选择可用工具，每个 agent 只获得自己配置的 allowlist。</p></div>

</div>

## 今天可以做什么

| 任务                   | 入口                        | 结果                                                                                     |
|------------------------|-----------------------------|------------------------------------------------------------------------------------------|
| 运行本地 AI smoke test | [快速开始](quickstart.html) | 一个 Docker-backed AI turn，验证调度、存储、controller support routes 和 runner wiring。 |
| 定义项目               | [配置](configuration.html)  | 带 whole-field import、profile 组合、agent、tool 和 backend 的 YAML 配置。               |
| 从终端运维             | [CLI 参考](cli.html)        | init、serve、start、send、inspect、approve、stop 等命令。                                |
| 集成其他系统           | [HTTP API](api.html)        | 项目对象、用户动作、事件流和 controller support calls。                                  |
| 理解运行时边界         | [架构](architecture.html)   | 核心运行时、Docker backend、runner tools、support routes 和 SQLite 的职责边界。          |

## 核心工作流

    1. 渲染并验证项目配置。
    2. 在 SUZUMIO_ROOT 下初始化项目。
    3. 启动 HTTP server 和 scheduler loop。
    4. 向一个智能体发送用户消息。
    5. Scheduler 为该智能体启动一个 Docker turn。
    6. Runner 执行 turn 和模型可见工具。
    7. Suzumio 记录消息、工具调用、事件、artifact 和 turn result。
    8. 空闲智能体保持安静，直到收到新的 inbound message。

## 项目目录

    $SUZUMIO_ROOT/demo/
      suzumio.sqlite      持久项目数据库
      source.yaml         原始项目配置
      resolved.yaml       完整解析后的配置
      agents/             每个智能体的 workspace
      artifacts/          已发布文件
      turns/              turn input 目录
      logs/               预留运行日志目录

## 公共文档范围

本站面向使用者说明 runtime contract、工作流、配置、CLI、API 和运维行为。示例使用占位 provider endpoint 和 key，不包含私有部署细节。

<div class="footer">当前站点：<a href="https://suzumio.aixmath.org">suzumio.aixmath.org</a>。源码：<a href="https://github.com/OmegaCombinator/suzumio">OmegaCombinator/suzumio</a>。</div>
