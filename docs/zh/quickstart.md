---
title: "Suzumio 快速开始"
eyebrow: "快速开始"
heroTitle: "第一个 YAML 多智能体项目"
lead: "本教程从一个项目 YAML 文件开始，渲染配置、初始化运行时状态、启动 Docker-backed scheduler，并发送第一条消息。"
---

## 你会构建什么

你会创建一个小项目，包含两个 agents：

- `pm`：协调者，接收用户请求并决定何时提交；
- `researcher`：worker，可以在 Docker 中运行 Python，并把共享文件写到 `/artifacts/researcher`。

这个项目很小，但包含大型团队也会用的核心模式：PM 分派任务，worker 报告结果，PM 等待或提交。

## 前置要求

| 要求 | 用途 | 检查 |
|------|------|------|
| Node.js 24+ | CLI、server、runner build、内置 SQLite 模块。 | `node --version` |
| npm | 安装 TypeScript 和运行时依赖。 | `npm --version` |
| Docker | 每个 agent activation 都在容器中运行。 | `docker ps` |
| 模型网关凭据 | AI runner 需要 provider endpoint 和 API key。 | provider-specific |

## 1. 构建 Suzumio

```bash
git clone git@github.com:OmegaCombinator/suzumio.git
cd suzumio
npm install
npm run build
docker build -t suzumio-runner:dev .
```

默认 runner image 包含 Node.js、`python3`、`curl` 和 `git`。

## 2. 编写 YAML

保存为 `/tmp/suzumio-tutorial.yaml`，如有需要替换 gateway URL。

```yaml
name: yaml-tutorial
task: |
  Produce a short note about one small Ramsey-number example.
  The worker should run a tiny Python check and save the script/output
  under /artifacts/researcher. The PM should summarize the result.

backend:
  kind: docker-chat
  image: suzumio-runner:dev
  controllerUrl: http://host.docker.internal:39400
  runner:
    mode: ai
    model: main
    models:
      providers:
        gateway:
          type: openai-compatible
          baseURLEnv: SUZUMIO_GATEWAY_BASE_URL
          apiKeyEnv: SUZUMIO_GATEWAY_API_KEY
          timeoutMs: 300000
      presets:
        main:
          provider: gateway
          model: gpt-5.5
          maxOutputTokens: 8000
          temperature: 0.2
          toolChoice: auto

tools:
  toolpacks:
    - core
    - shell

agents:
  pm:
    role: project-manager
    displayName: Yuki
    prompt: |
      Coordinate the task. Ask researcher for one small executable check.
      Treat your request as outstanding until researcher replies.
      If you are waiting, call coordination.wait_for_signal.
      Submit only after you have incorporated the worker result.
    model: main
    tools:
      - messages.send
      - coordination.wait_for_signal
      - completion.submit

  researcher:
    role: researcher
    displayName: Akari
    prompt: |
      Run a small Python experiment when useful. Save durable files under
      /artifacts/researcher. Send pm a concise report with the path.
      After reporting, if waiting for follow-up, call coordination.wait_for_signal
      with notifyPm:false.
    model: main
    tools:
      - messages.send
      - coordination.wait_for_signal
      - shell.exec
```

这个 YAML 做了四件重要的事：

- `pm` 可以提交，但没有 shell 权限；
- `researcher` 可以跑 shell/Python，但不能提交；
- worker 知道共享文件应该写到哪里；
- 两个 agent 都知道如何等待，而不是轮询。

## 3. 本地配置 secrets

不要提交真实 key 或私有 gateway URL。

```bash
export SUZUMIO_ROOT=/tmp/suzumio-root
export SUZUMIO_GATEWAY_API_KEY=...
```

如果 Docker 容器需要 HTTP 代理，在任何可能启动 activation 的命令前导出 proxy env，或在本地未跟踪 YAML 中配置 `backend.docker.proxy`。

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

Linux 上如果代理只监听 host loopback，请使用 `backend.docker.network: host`，并把 `backend.controllerUrl` 设为 `http://127.0.0.1:<port>`。

## 4. 运行前先 render

```bash
suzumio config render /tmp/suzumio-tutorial.yaml
```

Render 会显示 imports、环境变量替换、默认值，以及项目实际存储的最终 YAML 形状。

## 5. 初始化并启动 server

```bash
suzumio init /tmp/suzumio-tutorial.yaml
suzumio serve --host 0.0.0.0 --port 39400
```

另开一个终端，带同样的 env vars：

```bash
export SUZUMIO_ROOT=/tmp/suzumio-root
export SUZUMIO_GATEWAY_API_KEY=...
suzumio start yaml-tutorial
suzumio send yaml-tutorial pm P1 "Run the small Ramsey example and submit a short note."
```

`start` 和 `send` 可能直接运行 scheduler tick，所以它们也需要和 server 相同的 provider/proxy 环境。

打包后的 WebUI 由 `http://127.0.0.1:39400` 提供。开发 WebUI 时，在另一个终端运行 `npm run webui:dev` 并打开 `http://127.0.0.1:5173`；Vite 会把 `/api` 和 `/health` 代理到 `39400` 上的 backend。

## 6. 检查运行结果

```bash
suzumio status yaml-tutorial
suzumio messages yaml-tutorial --limit 20
suzumio activations yaml-tutorial --limit 20
suzumio events yaml-tutorial --limit 40
```

Worker 写出的文件会在 host 上出现：

```text
$SUZUMIO_ROOT/yaml-tutorial/artifacts/researcher/
```

容器内会看到这些共享路径：

```text
/artifacts/pm          pm 可写，其他 agent 只读
/artifacts/researcher  researcher 可写，其他 agent 只读
```

## 7. 一个健康 run 应该长什么样

1. 用户消息唤醒 `pm`。
2. `pm` 向 `researcher` 发送请求。
3. `pm` 调用 `coordination.wait_for_signal`。
4. `researcher` 运行 `shell.exec`，写 `/artifacts/researcher/...`，并向 `pm` 汇报。
5. `pm` 在下一次 activation 中看到 worker report。
6. `pm` 调用 `completion.submit` 提交最终 Markdown report。

## 排错

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| Activation 还没提交结果就失败。 | runner image 未构建、镜像名错误、Docker 启动失败或模型/provider 错误。 | 运行 `docker build -t suzumio-runner:dev .`，检查 `suzumio activations` 和 `docker logs <container>`。 |
| Support tool connection refused。 | 容器无法访问 Suzumio server。 | 用 `--host 0.0.0.0` 启动 server 并使用 `http://host.docker.internal:39400`，或使用 host networking + `127.0.0.1`。 |
| Agent 不启动。 | 项目不是 `running`，或没有 pending signal 指向该 agent。 | 运行 `suzumio start project` 并给 agent 发送直接消息。 |
| Docker 内缺少 API key。 | 创建 activation 的进程没有 provider env var。 | 在 `serve`、`start`、`send`、`tick` 前都导出 key。 |

<div class="footer">下一步：<a href="configuration.html">YAML 配置</a>。</div>
