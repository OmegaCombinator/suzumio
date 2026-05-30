---
title: "Suzumio 快速开始"
eyebrow: "快速开始"
heroTitle: "端到端运行运行时"
lead: "本指南在 Docker 中运行一个 AI-backed agent activation，并验证 config、SQLite、scheduler、Docker backend、runner tools、controller support routes、HTTP API 和 WebUI。"
---

## 前置要求

| 要求        | 用途                                          | 检查             |
|-------------|-----------------------------------------------|------------------|
| Node.js 24+ | CLI、server、runner build、内置 SQLite 模块。 | `node --version` |
| npm         | 安装 TypeScript 和运行时依赖。                | `npm --version`  |
| Docker      | 每个智能体 activation 都在容器中运行。        | `docker ps`      |
| Git         | clone 仓库并管理本地修改。                    | `git --version`  |

## 1. Clone 和 Build

    git clone git@github.com:OmegaCombinator/suzumio.git
    cd suzumio
    npm install
    npm run build

## 2. 构建 Runner 镜像

    docker build -t suzumio-runner:dev .

示例配置使用 `suzumio-runner:dev`。如果使用其他 tag，请修改项目配置中的 `backend.image`。

## 3. 选择 Runtime Root

    export SUZUMIO_ROOT=/tmp/suzumio-root
    mkdir -p "$SUZUMIO_ROOT"

`SUZUMIO_ROOT` 存储项目数据库、activation input 文件、workspace 和 artifact。建议放在 Git 仓库外。

## 4. 配置模型凭据

提交的示例已脱敏。如果需要替换 placeholder gateway URL，请复制到本地未跟踪文件后再编辑，并导出配置中引用的 API key 环境变量。

    cp examples/demo.yaml /tmp/suzumio-demo.yaml
    # 如需私有 gateway URL，在本地编辑 /tmp/suzumio-demo.yaml
    export SUZUMIO_GATEWAY_API_KEY=...

## 5. 检查配置

    suzumio config render /tmp/suzumio-demo.yaml

运行前先渲染配置，可以看到 import 内容、默认值和写入 SQLite 的最终形状。

## 6. 初始化项目

    suzumio init /tmp/suzumio-demo.yaml
    suzumio status demo

初始化后项目还不会被调度。需要在 server 运行后显式 start。

## 7. 启动 Server

    suzumio serve --host 0.0.0.0 --port 39400

这会启动 HTTP API、controller support routes、WebUI、SSE stream 和 scheduler loop。浏览器打开 `http://127.0.0.1:39400`。

## 8. 发送第一条消息

在另一个终端中使用同一个 `SUZUMIO_ROOT`。

    export SUZUMIO_ROOT=/tmp/suzumio-root
    suzumio start demo
    suzumio send demo pm P1 "Send one short status update to the user."

这条消息会为 `pm` 创建 pending `message.created` signal。Scheduler 会把该 signal 投递进一个 activation，并启动一个 Docker 容器。

## 9. 检查结果

    suzumio activations demo --limit 5
    suzumio messages demo --limit 10
    suzumio events demo --limit 20

成功运行会显示 completed activation，以及模型通过 Suzumio support routes 创建的消息、artifact 或提交状态。

## 10. 验证非抢占行为

如果智能体已经处于 `running`，发送新消息不会打断当前 activation。新消息会创建 pending signal，等待当前 activation 完成后再投递。

## 可选备用 AI 配置

`examples/ai-demo.yaml` 也已脱敏。加入私有 endpoint 之前，请复制到本地未跟踪文件。

    cp examples/ai-demo.yaml /tmp/suzumio-ai-demo.yaml
    # 在本地编辑 /tmp/suzumio-ai-demo.yaml
    export SUZUMIO_GATEWAY_API_KEY=...
    suzumio init /tmp/suzumio-ai-demo.yaml

<div class="notice danger">

不要提交真实 API key、私有 gateway URL 或私有 provider 名称。请放在本地配置和环境变量中。

</div>

## 排错

| 现象                              | 原因                                                                   | 处理                                                                           |
|-----------------------------------|------------------------------------------------------------------------|--------------------------------------------------------------------------------|
| Activation 提交结果前失败。       | 镜像未构建、镜像名错误、容器启动失败或 controller support 连接问题。   | 运行 `docker build -t suzumio-runner:dev .` 并检查 `docker logs <container>`。 |
| Support tool connection refused。 | 容器无法访问 Suzumio server 来使用 stateful tools 或提交 activation output。 | 用 `--host 0.0.0.0` 启动 server，并使用 `http://host.docker.internal:39400`。  |
| Agent 不启动。                    | 项目不是 `running`，或 agent 没有 pending signal。                     | 运行 `suzumio start project` 并向该 agent 发送直接消息。                       |
| 自定义域名只有 HTTP。             | GitHub Pages 证书仍在签发。                                            | 等待证书完成后再启用 HTTPS enforcement。                                       |

<div class="footer">下一步：<a href="concepts.html">核心概念</a>。</div>
