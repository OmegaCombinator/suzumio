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

## Runner Support Routes

Docker runner 把所有模型可见工具展示给模型。Controller 提供 support API，用于权限、状态、持久化、tool-call 审计记录和自定义 toolpack support。`shell.exec` 和 `web.fetch` 这类 runner-local tools 在 Docker 容器内执行。这些 route 不是公共用户 API。

| 方法   | 路径                                  | 用途                                                                                  |
|--------|---------------------------------------|---------------------------------------------------------------------------------------|
| `POST` | `/runner/tool-calls/start`            | 鉴权 agent/turn，校验工具属于已配置 toolpack 且在 allowlist 中，并创建 running 记录。 |
| `POST` | `/runner/tool-calls/finish`           | 校验 tool call 属于当前 agent turn，然后标记 completed 或 failed。                    |
| `POST` | `/runner/signals`                     | 允许 runner-side 或 local toolpack 代码创建 pending signal 或 closed effect。         |
| `POST` | `/toolpacks/:toolpackId/support`      | 分发 built-in 或 local toolpack 的 controller-side support。                          |
| `POST` | `/turn-output`                        | 提交最终 turn 文本和 usage metadata。                                                 |

Support 请求包含 `project`、`agentId`、`turnId` 和 agent private `token`。Toolpack support 还包含工具名和 input：

    POST /toolpacks/core/support
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

Support host 会在调用 controller support 前校验 token、turn ownership、toolpack membership 和 agent allowlist。

### `POST /runner/signals`

    {
      "project": "demo",
      "agentId": "worker-1",
      "turnId": "turn_...",
      "token": "agent-private-token",
      "kind": "review.ready",
      "targetAgent": "pm",
      "priority": "P1",
      "payload": { "artifactId": "art_..." }
    }

设置 `targetAgent` 或 `targetChannel` 会创建可调度工作。省略 target 并设置 `usefulEffect: true` 会记录 closed useful effect，不唤醒任何 agent。带目标的 signal 不能显式 closed。

## 自定义 Toolpack Signals

Local runner module 和 controller module 都会收到带 `recordSignal` 的 context。自定义工具为其他 agent 产生工作，或记录 useful effect 时应调用它。

    export function createRunnerToolpack(context) {
      return {
        tools: {
          "review.ready": async (input) => {
            await context.recordSignal({
              kind: "review.ready",
              targetAgent: "pm",
              priority: "P1",
              payload: { summary: input.summary }
            });
            return { output: "PM notified." };
          }
        }
      };
    }

    export function createControllerToolpack(context) {
      return {
        async support(tool, input) {
          context.recordSignal({
            kind: "review.cached",
            payload: { cacheKey: input.cacheKey },
            usefulEffect: true
          });
          return { output: "Cached review state." };
        }
      };
    }

第一个例子为 `pm` 创建 pending work。第二个例子记录 closed useful effect，不调度任何 agent。

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

发给 agent 的消息会创建 pending `message.created` signal。频道消息会 fan out 到其他 agent。发给 `recipient: "user"` 的消息创建 closed useful effect，不唤醒 agent。

### `coordination.no_valuable_work`

    {
      "reason": "Waiting for worker-2's result.",
      "pm": "pm",
      "notifyPm": true
    }

声明调用者在未来 signal 到来前没有有价值的工作可做。非 PM agent 默认用 direct message 通知 `pm`。PM 调用时会记录 closed useful effect 并安静等待。

### `artifacts.publish`

    {
      "path": "relative/path/in/workspace.txt",
      "name": "optional-name.txt",
      "description": "What this artifact contains"
    }

Path 相对 agent workspace。Suzumio 会复制文件或目录到 artifact registry 并记录 SHA-256 hash。单独发布 artifact 不算 useful effect；artifact 准备好给别人使用时，agent 还应该发送消息或提交 completion。

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
