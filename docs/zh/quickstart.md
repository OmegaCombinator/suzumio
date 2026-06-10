---
title: "初始化并运行 Suzumio 项目"
eyebrow: "运行项目"
heroTitle: "Render YAML，初始化状态，启动 agents"
lead: "本章覆盖本地 setup、project initialization、terminal control、WebUI、runtime inspection、artifacts、secrets、proxies 和基本 cleanup。"
---

## 前置要求

| Requirement | Used by | Check |
|-------------|---------|-------|
| Node.js 24+ | CLI、server、runner build、内置 SQLite module。 | `node --version` |
| npm | 安装 TypeScript 和 runtime dependencies。 | `npm --version` |
| Docker | 每个 agent activation 都在 container 中运行。 | `docker ps` |
| Model gateway credentials | AI runner provider endpoint 和 API key。 | Provider-specific。 |

## 构建 Suzumio

```bash
git clone git@github.com:OmegaCombinator/suzumio.git
cd suzumio
npm install
npm run build
docker build -t suzumio-runner:dev .
```

默认 runner image 包含 Node.js、`python3`、`curl` 和 `git`。

## Runtime Root

```bash
export SUZUMIO_ROOT=/tmp/suzumio-root
```

Runtime root 包含 project databases、activation inputs、agent workspaces、artifacts 和 logs。

```text
$SUZUMIO_ROOT/project-name/
  suzumio.sqlite      durable project database
  source.yaml         original project config
  resolved.yaml       fully resolved config
  agents/             per-agent workspaces
  artifacts/          per-agent shared files
  activations/        activation input directories
  logs/               reserved runtime logs
```

## Secrets 和 Provider Environment

Provider keys 使用环境变量；private gateway URLs 放在本地未跟踪 config 中。

```bash
export SUZUMIO_GATEWAY_API_KEY=...
export SUZUMIO_GATEWAY_BASE_URL=...
```

启动 activation 的进程必须带有配置中引用的 provider environment variables。这个进程可以是 long-running server，也可以是直接触发 scheduler tick 的 CLI command。

以下命令使用同一套 provider/proxy environment：

```bash
suzumio serve --host 0.0.0.0 --port 39400
suzumio start project-name
suzumio send project-name pm P1 "Start."
suzumio tick
```

## Proxy Environment

Suzumio 会把存在的标准 proxy variables 传入 runner containers：`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及其 lowercase variants。

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

Bridge-network containers 不能直接访问 host loopback。`rewriteLocalhost: true` 会把 loopback proxy hosts 改写为 `host.docker.internal`。

```yaml
backend:
  docker:
    proxy:
      inheritEnv: true
      rewriteLocalhost: true
      https: ${HTTPS_PROXY}
      http: ${HTTP_PROXY}
```

Linux host networking 会保留 `127.0.0.1` proxy URLs，并使用 host-local controller URL。

```yaml
backend:
  controllerUrl: http://127.0.0.1:39400
  docker:
    network: host
```

## 示例 Project YAML

保存为 `/tmp/suzumio-tutorial.yaml`。

```yaml
name: yaml-tutorial
task: |
  Produce a short note about one small Ramsey-number example.
  Have the worker run a tiny Python check and save the script/output
  under /artifacts/researcher. Have the PM summarize the result.

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

## Render 和 Initialize

```bash
suzumio config render /tmp/suzumio-tutorial.yaml
suzumio init /tmp/suzumio-tutorial.yaml
suzumio status yaml-tutorial
```

`config render` 会显示 imports、environment substitutions、defaults、merge results、model settings，以及 `init` 存储的准确 YAML。

## 启动 Server

```bash
suzumio serve --host 0.0.0.0 --port 39400
```

Server 提供 HTTP API routes、runner containers 使用的 controller support routes、Server-Sent Events 和 packaged WebUI。

本地访问使用 `127.0.0.1`。Docker bridge containers 需要通过 `host.docker.internal` 访问 host support routes 时使用 `0.0.0.0`。

Long-running server 使用 systemd、container supervisor 或 supervised shell session。在 user-facing API authentication 完成前，只绑定 trusted interfaces。

## Terminal Control

另开一个 terminal，带同样的 `SUZUMIO_ROOT` 和 provider/proxy env。

```bash
export SUZUMIO_ROOT=/tmp/suzumio-root
export SUZUMIO_GATEWAY_API_KEY=...

suzumio start yaml-tutorial
suzumio send yaml-tutorial pm P1 "Run the small Ramsey example and submit a short note."
```

Core control commands:

| Command | Effect |
|---------|--------|
| `suzumio status project` | 显示 project status 和 agent states。 |
| `suzumio start project` | 标记 project running，并运行 scheduler tick。 |
| `suzumio stop project` | 停止该 project 的 scheduling。 |
| `suzumio send project agent P1 "..."` | 发送 direct message，并运行 scheduler tick。 |
| `suzumio tick` | 对 root 下 projects 运行 scheduler ticks。 |
| `suzumio approve project` | 将 submitted project 标记为 completed。 |
| `suzumio messages project --limit 20` | 显示 recent messages。 |
| `suzumio activations project --limit 20` | 显示 activation records。 |
| `suzumio events project --limit 40` | 显示 event timeline。 |

## WebUI

Packaged WebUI 由同一个 server 提供，通常是 `http://127.0.0.1:39400`。

WebUI 显示：

| View | Contents |
|------|----------|
| Project overview | Status、agents、轻量 counters、controls。 |
| Messages | Direct 和 channel messages。 |
| Agent history | Per-agent model-visible history、compaction markers、archives。 |
| Tool status | Per-tool workspace，包含 aggregate status、submit report path，并且一次只打开一个 WebUI control page。内置 message/signal controls 会用当前 project agents 填充下拉选择。`toolpacks/scheduler` 和 `toolpacks/plan` 这类 local toolpacks 可以添加 scheduled messages 和 active plans 页面。 |

WebUI development:

```bash
npm run webui:dev
```

打开 `http://127.0.0.1:5173`。Vite 会把 `/api` 和 `/health` proxy 到 `39400` 上的 backend。

## Inspect Activations

每个 activation directory 都包含准确 runner input。

```text
$SUZUMIO_ROOT/yaml-tutorial/activations/act_.../
  input.json
```

Input 包含 rendered prompt、agent identity、controller URL、token、runner config、history，以及模型可见 tool definitions。Activation output 通过 `POST /activation-output` 提交，并存入 SQLite。

## Shared Artifacts

Agents 在 containers 内看到 shared artifact paths。

```text
/artifacts/pm          pm 可写，其他 agent 只读
/artifacts/researcher  researcher 可写，其他 agent 只读
```

Tutorial worker 写出的 host files 位于：

```text
$SUZUMIO_ROOT/yaml-tutorial/artifacts/researcher/
```

File writes 不会唤醒另一个 agent。写文件的 agent 在 artifact ready 后发送 message 或 submit completion。

## Healthy Run Shape

1. User message 唤醒 `pm`。
2. `pm` 向 `researcher` 发送 request。
3. `pm` 调用 `coordination.wait_for_signal`。
4. `researcher` 运行 `shell.exec`，写 `/artifacts/researcher/...`，并向 `pm` 汇报。
5. `pm` 在下一次 activation 中看到 worker report。
6. `pm` 调用 `completion.submit` 提交 final Markdown report。
7. Project status 变成 `submitted`。
8. User 或 operator 接受后运行 `suzumio approve yaml-tutorial`。

## Troubleshooting

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Project never starts an activation. | Project 不是 `running`。 | `suzumio start project` |
| Agent stays quiet. | 没有 pending signals target that agent。 | `suzumio send project agent P1 "..."` |
| Message exists but no activation starts. | Agent 已经 `running`、project stopped，或 message targeted `user`。 | 等待完成，或给 agent 发 direct message。 |
| Activation fails before submitting output. | Runner image、mount、Docker daemon 或 provider issue。 | Inspect `suzumio activations`、activation input 和 `docker logs <container>`。 |
| Support tool connection refused. | Container 不能访问 Suzumio server。 | Server 绑定 Docker-reachable address，并匹配 `backend.controllerUrl`。 |
| API key missing inside Docker. | Activation-launching process 没有 provider env var。 | 在 `serve`、`start`、`send` 和 `tick` 前 export provider env。 |

## Debug Container Cleanup

Completed activation containers 会保留用于 debugging。只删除 Suzumio 创建的 containers。

```bash
docker ps -a --filter name=suzumio
docker rm <container-name>
```

不要在 shared machines 上运行 broad Docker prune commands。

<div class="footer">下一步：<a href="toolpacks.html">Custom Tools</a>。</div>
