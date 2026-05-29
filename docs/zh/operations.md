---
title: "Suzumio 运维"
eyebrow: "运维"
heroTitle: "运行、检查和清理项目"
lead: "Suzumio 的运行状态是透明的。每个关键对象都有 CLI 视图和 HTTP 视图，并由同一个 SQLite store 支撑。"
---

## Runtime Root

    export SUZUMIO_ROOT=/data/suzumio-runtime

运行时状态应放在源码仓库外。Root 包含项目数据库、turn input、agent workspace、artifact 和日志。

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
| Scheduler | 项目为 running，idle agent 有 unread message。 | `suzumio messages project`                |
| Turn      | 容器完成，turn 文本已通过 HTTP 提交。          | `suzumio turns project`                   |

## 检查 Turn

Turn 目录包含精确的 runner input：

    $SUZUMIO_ROOT/demo/turns/turn_.../
      input.json

Input 包含渲染后的 prompt、agent identity、controller URL、runner config 和工具定义。最终 turn 文本通过 `POST /turn-output` 提交并存入 SQLite，因此不需要信任容器可写文件，失败 turn 仍可审阅。

## 调试 Scheduler Silence

| 现象                  | 可能原因                                   | 处理                                                |
|-----------------------|--------------------------------------------|-----------------------------------------------------|
| 项目从不启动 turn。   | 项目不是 `running`。                       | `suzumio start project`                             |
| Agent 保持 quiet。    | 没有给该 agent 的 unread inbound message。 | `suzumio send project agent P1 "..."`               |
| 有消息但没有新 turn。 | Agent 已经 `running`。                     | 等待完成。Suzumio 默认就是非抢占式。                |
| Turn 立即失败。       | 镜像、mount 或 Docker daemon 问题。        | 检查 `suzumio turns`、turn input 和 `docker logs`。 |

## 清理 Debug Containers

早期 Suzumio 会保留 completed turn containers 方便调试。只删除 Suzumio 创建的容器：

    docker ps -a --filter name=suzumio
    docker rm <container-name>

<div class="notice danger">

不要在共享机器上执行宽泛的 Docker prune 命令。只清理 Suzumio 创建的容器。

</div>

## Secrets

API key 使用环境变量，私有 gateway URL 放在本地未跟踪配置中。

    export SUZUMIO_GATEWAY_API_KEY=...
    suzumio serve --host 0.0.0.0 --port 39400

Runner backend 会把配置中引用且主机环境存在的 provider key 环境变量传入容器。提交示例应只使用占位 endpoint 和环境变量名。

## 长时间运行 Server

长时间运行时建议使用 systemd、容器 supervisor 或受监督的 shell session。在用户 API 鉴权完成前，只绑定到可信接口。

    suzumio serve --host 127.0.0.1 --port 39400

如果 Docker 容器需要调用 host support routes，需要绑定到 Docker 可访问的地址，并设置对应的 `backend.controllerUrl`。

## 文档部署

GitHub Pages workflow 上传静态 `docs/` 目录。自定义域名由 `docs/CNAME` 和 DNS 配置。GitHub 证书签发完成前，自定义域名可能只通过 HTTP 提供服务；证书 ready 后再启用 HTTPS enforcement。

<div class="footer">下一步：<a href="api.html">HTTP API</a>。</div>
