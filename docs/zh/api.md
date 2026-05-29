---
title: "Suzumio HTTP API"
eyebrow: "参考"
heroTitle: "HTTP API 和工具支持"
lead: "HTTP server 暴露项目观测、用户控制动作、SSE 事件流，以及 Docker runner 使用的 controller support routes。"
---

## Server

    suzumio serve --host 0.0.0.0 --port 39400

当前 API 面向本地或可信网络使用。第一版尚未实现用户 API 鉴权。面向容器的 tool route 使用每个 agent 的 token。

## 约定

| 主题      | 行为                                                     |
|-----------|----------------------------------------------------------|
| Base URL  | 默认 `http://127.0.0.1:39400`。                          |
| Body 格式 | POST route 使用 JSON；无 body 的 lifecycle action 除外。 |
| 列表限制  | `?limit=n`，最多 500。                                   |
| 错误      | 根据 route 返回 plain text 或 JSON。                     |
| Tokens    | Project 和 agent listing 响应会 redact agent token。     |

## Health

    GET /health

    {
      "healthy": true
    }

## Projects

| 方法  | 路径                     | 说明                                                                     |
|-------|--------------------------|--------------------------------------------------------------------------|
| `GET` | `/api/projects`          | 列出 `SUZUMIO_ROOT` 下的项目，每项是 project summary。                   |
| `GET` | `/api/projects/:project` | Project summary，包含 redacted agents、recent turns 和 recent messages。 |

    curl http://127.0.0.1:39400/api/projects/demo

## Project Objects

| 方法  | 路径                                          | 说明                                            |
|-------|-----------------------------------------------|-------------------------------------------------|
| `GET` | `/api/projects/:project/agents`               | Agent records，token 已隐藏。                   |
| `GET` | `/api/projects/:project/messages?limit=100`   | 近期消息。                                      |
| `GET` | `/api/projects/:project/events?limit=200`     | 近期事件。                                      |
| `GET` | `/api/projects/:project/turns?limit=100`      | 近期 turn。                                     |
| `GET` | `/api/projects/:project/tool-calls?limit=100` | 近期工具调用。                                  |
| `GET` | `/api/projects/:project/artifacts?limit=100`  | Artifact registry。                             |
| `GET` | `/api/projects/:project/config/resolved`      | Resolved YAML config，plain text。              |
| `GET` | `/api/projects/:project/report`               | Submitted final report 文本；未提交时返回提示。 |

## 用户控制动作

| 方法   | 路径                                     | Body                                                     | 说明                                                    |
|--------|------------------------------------------|----------------------------------------------------------|---------------------------------------------------------|
| `POST` | `/api/projects/:project/start`           | 空                                                       | 设置为 `running` 并 tick scheduler。                    |
| `POST` | `/api/projects/:project/stop`            | 空                                                       | 设置为 `stopped`。                                      |
| `POST` | `/api/projects/:project/approve`         | 空                                                       | 设置为 `completed`。                                    |
| `POST` | `/api/projects/:project/request-changes` | `{ "recipient": "pm", "body": "..." }`                   | 回到 `running`，发送 `P1` 用户消息，并 tick scheduler。 |
| `POST` | `/api/projects/:project/messages`        | `{ "recipient": "pm", "priority": "P1", "body": "..." }` | 创建消息并 tick scheduler。                             |

    curl -X POST http://127.0.0.1:39400/api/projects/demo/messages \
      -H 'content-type: application/json' \
      -d '{"recipient":"pm","priority":"P1","body":"Start."}'

`/messages` body 可包含 `sender`、`recipient`、`channel`、`priority`、`body`。使用 `recipient` 或 `channel` 其一。Priority 默认 `P1`。

## SSE Stream

事件流以 Server-Sent Events 发送 SQLite events。它会先发送近期已有事件，然后每两秒轮询新事件。

    GET /api/projects/:project/stream

    event: message.created
    data: { ...event row... }

## Tool Support Routes

Docker runner 把工具展示给模型。需要 Suzumio 项目状态的工具使用 `POST /tool` 作为 controller support route；`shell.exec` 和 `web.fetch` 这类 runner-local tools 在 Docker 容器内执行，不调用该 route。`POST /turn-output` 用于提交最终 turn 文本。这些不是公共用户 API。

    POST /tool
    {
      "project": "demo",
      "agentId": "pm",
      "turnId": "turn_...",
      "token": "agent-private-token",
      "tool": "messages.send",
      "input": {
        "recipient": "user",
        "priority": "P1",
        "body": "Done."
      }
    }

Controller support route 校验 token 与 agent 匹配，并确认 controller-supported tool 在 agent allowlist 中。执行前记录 `tool_calls`，成功或失败后更新。

### `POST /turn-output`

    {
      "project": "demo",
      "agentId": "pm",
      "turnId": "turn_...",
      "token": "agent-private-token",
      "output": {
        "text": "Turn result text",
        "usage": { "model": "worker-main" }
      }
    }

Backend 只有在收到这个已鉴权提交后才把 turn 标记为完成。`/turn/input.json` 是只读输入和调试 contract；turn output 不再从容器可写文件读取。

## Core Tool Inputs

### `messages.send`

    {
      "recipient": "worker",
      "channel": "#project",
      "priority": "P2",
      "body": "Markdown message"
    }

使用 `recipient` 或 `channel` 其一，channel 必须在配置中声明。

### `artifacts.publish`

    {
      "path": "relative/path/in/workspace.txt",
      "name": "optional-name.txt",
      "description": "What this artifact contains"
    }

Path 相对 agent workspace。Suzumio 会复制文件或目录到 artifact registry 并记录 SHA-256 hash。

### `artifacts.list`

    {}

### `artifacts.read`

    {
      "id": "art_...",
      "maxBytes": 20000
    }

使用 `id` 或 `name` 其一。该工具读取 artifact registry 中的文本文件 artifact。对于配置挂载的只读 host 文件或目录，使用 mounted path 和 `shell.exec`，例如 `cp -r /mnt/reference /workspace/reference`。

### `shell.exec`

    {
      "command": "cp -r /mnt/reference ./reference && make test",
      "cwd": "/workspace",
      "timeoutMs": 120000,
      "maxOutputBytes": 40000
    }

在 Docker runner 容器内运行 bash。用于复制 mounted inputs、编译代码、运行二进制、测试或项目本地脚本。只给应该执行容器命令的 agent 授权。

### `completion.submit`

    {
      "report": "# Final Report\n\n..."
    }

该工具写入 `final-report.md`，把项目设为 `submitted`，等待用户审批。

### `web.fetch`

    {
      "url": "https://example.com/",
      "maxBytes": 20000,
      "timeoutMs": 30000,
      "format": "text"
    }

从 Docker runner 容器内获取 HTTP(S) URL。`format: "text"` 对 HTML 响应返回清洗文本，对其他内容类型返回原始文本；`format: "raw"` 返回未修改的响应文本。只给确实需要联网的 agent 授权。

## WebUI

根路径 `/` 提供内嵌 WebUI。第一版保持简单：项目选择器、消息表单、agents、messages、turns、events 和 artifacts。

<div class="footer">下一步：<a href="roadmap.html">路线图</a>。</div>
