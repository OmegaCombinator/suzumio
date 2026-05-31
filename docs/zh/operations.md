---
title: "Suzumio 运维"
eyebrow: "运维"
heroTitle: "运行、检查和清理项目"
lead: "Suzumio 的运行状态是透明的。每个关键对象都有 CLI 视图和 HTTP 视图，并由同一个 SQLite store 支撑。"
---

## Runtime Root

    export SUZUMIO_ROOT=/data/suzumio-runtime

运行时状态应放在源码仓库外。Root 包含项目数据库、activation input、agent workspace、artifact 和日志。

## 推荐运行模式

    npm run build
    docker build -t suzumio-runner:dev .

    export SUZUMIO_ROOT=/data/suzumio-runtime
    suzumio config render examples/demo.yaml
    suzumio init examples/demo.yaml
    suzumio serve --host 0.0.0.0 --port 39400

另开一个终端：

    export SUZUMIO_ROOT=/data/suzumio-runtime
    suzumio start demo
    suzumio send demo pm P1 "Start the project."

## 运维检查表

| 阶段      | 检查                                           | 命令                                      |
|-----------|------------------------------------------------|-------------------------------------------|
| Build     | TypeScript 生成 `dist/`。                      | `npm run build`                           |
| Image     | 本地存在 runner 镜像。                         | `docker image inspect suzumio-runner:dev` |
| Config    | Import 可解析，且没有提交 secret。             | `suzumio config render file.yaml`         |
| Store     | 项目初始化在预期 root 下。                     | `suzumio status project`                  |
| Server    | HTTP 和 controller support routes 可访问。     | `curl http://127.0.0.1:39400/health`      |
| Scheduler | 项目为 running，idle agent 有 pending signal。 | `suzumio messages project` 和 events      |
| Activation | 容器完成，activation 文本已通过 HTTP 提交。  | `suzumio activations project`             |

## 检查 Activation

Activation 目录包含精确的 runner input：

    $SUZUMIO_ROOT/demo/activations/act_.../
      input.json

Input 包含渲染后的 prompt、agent identity、controller URL、runner config 和工具定义。最终 activation 文本通过 `POST /activation-output` 提交并存入 SQLite，因此不需要信任容器可写文件，失败 activation 仍可审阅。

## 调试 Scheduler Silence

| 现象                  | 可能原因                                   | 处理                                                |
|-----------------------|--------------------------------------------|-----------------------------------------------------|
| 项目从不启动 activation。 | 项目不是 `running`。                       | `suzumio start project`                             |
| Agent 保持 quiet。    | 没有给该 agent 的 pending signal。         | `suzumio send project agent P1 "..."`               |
| 有消息但没有新 activation。 | Agent 已经 `running`、项目 stopped，或消息目标是 `user`。 | 等待完成，或向 agent 发送直接消息。                 |
| Activation 立即失败。 | 镜像、mount 或 Docker daemon 问题。        | 检查 `suzumio activations`、activation input 和 `docker logs`。 |

## 避免协调循环

Agent 不应该向共享频道发送“没事做”消息。请使用 `coordination.wait_for_signal`。它会记录等待状态并结束当前 activation。Worker agent 默认会用 direct message 通知 `pm`，PM 可以记录一个明确的等待状态，而不会唤醒自己。

如果 agent 在 `/artifacts/<agent-id>` 下写了共享 artifact，它还应该在文件可供他人使用时发送消息或提交 completion。文件写入是持久的，但不会自己唤醒其他 agent。

## 清理 Debug Containers

早期 Suzumio 会保留 completed activation containers 方便调试。只删除 Suzumio 创建的容器：

    docker ps -a --filter name=suzumio
    docker rm <container-name>

<div class="notice danger">

不要在共享机器上执行宽泛的 Docker prune 命令。只清理 Suzumio 创建的容器。

</div>

## Secrets

API key 使用环境变量，私有 gateway URL 放在本地未跟踪配置中。

    export SUZUMIO_GATEWAY_API_KEY=...
    suzumio serve --host 0.0.0.0 --port 39400

Runner backend 会把配置中引用、且创建 activation 的进程环境里存在的 provider key 环境变量传入容器。这个进程可能是长时间运行的 server，也可能是直接触发 scheduler tick 的 CLI 命令，例如 `suzumio start`、`suzumio send` 或 `suzumio tick`，所以这些命令也要带同一套 provider env。提交示例应只使用占位 endpoint 和环境变量名。

## 代理和 Runner 工具

默认 runner 镜像包含 `python3`、`curl` 和 `git`，所以拥有 `shell.exec` 的 agent 可以在 Docker 内运行小脚本、命令行网络探测和本地仓库流程。

Suzumio 会把标准代理变量传入 runner 容器：`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及其小写形式。如果代理值指向 `127.0.0.1`、`localhost` 或 `::1`，Suzumio 会在传给 bridge-network 容器时把 host 改写成 `host.docker.internal`。

本地 HTTP 代理建议在启动任何可能创建 activation 的进程前导出：

    export HTTPS_PROXY=http://127.0.0.1:7890
    export HTTP_PROXY=http://127.0.0.1:7890
    suzumio serve --host 0.0.0.0 --port 39400

HTTP/HTTPS proxy URL 会被内置模型调用和 `web.fetch` 使用。SOCKS proxy URL 仍会传进容器，供 `curl` 这类 shell 工具使用；但内置模型调用和 `web.fetch` 需要 HTTP 或 HTTPS 代理。

也可以在本地项目 YAML 中显式配置代理：

    backend:
      docker:
        proxy:
          inheritEnv: true
          https: ${HTTPS_PROXY}
          http: ${HTTP_PROXY}
          all: ${ALL_PROXY}
          noProxy: ${NO_PROXY}

如果本地代理只监听 host loopback，Docker bridge 无法访问它，可以在 Linux 上让该项目使用 host networking，并把 `backend.controllerUrl` 设成 `http://127.0.0.1:<port>`：

    backend:
      docker:
        network: host

使用 `network: host` 时，Suzumio 会保留 `127.0.0.1` 代理 URL，因为容器和宿主共享 network namespace。

## 长时间运行 Server

长时间运行时建议使用 systemd、容器 supervisor 或受监督的 shell session。在用户 API 鉴权完成前，只绑定到可信接口。

    suzumio serve --host 127.0.0.1 --port 39400

如果 Docker 容器需要调用 host support routes，需要绑定到 Docker 可访问的地址，并设置对应的 `backend.controllerUrl`。

## 文档部署

GitHub Pages workflow 上传静态 `docs/` 目录。自定义域名由 `docs/CNAME` 和 DNS 配置。GitHub 证书签发完成前，自定义域名可能只通过 HTTP 提供服务；证书 ready 后再启用 HTTPS enforcement。

<div class="footer">下一步：<a href="api.html">HTTP API</a>。</div>
