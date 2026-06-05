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
| `GET` | `/api/projects/:project` | Project summary，包含 redacted agents、recent activations 和 recent messages。 |

    curl http://127.0.0.1:39400/api/projects/demo

## Project Objects

| 方法  | 路径                                          | 说明                                            |
|-------|-----------------------------------------------|-------------------------------------------------|
| `GET` | `/api/projects/:project/agents`               | Agent records，token 已隐藏。                   |
| `GET` | `/api/projects/:project/agents/:agent/history?limit=100` | 分页读取单个 agent 的模型历史。       |
| `GET` | `/api/projects/:project/agents/:agent/history-archive/:compaction` | 读取一次 history compaction 的 raw 本地归档。 |
| `GET` | `/api/projects/:project/messages?limit=100`   | 近期消息。                                      |
| `GET` | `/api/projects/:project/events?limit=200`     | 近期事件。                                      |
| `GET` | `/api/projects/:project/activations?limit=100` | 近期 activation。                               |
| `GET` | `/api/projects/:project/activations/:id/context` | 单个 activation 的 scheduler prompt 和模型消息上下文快照。 |
| `GET` | `/api/projects/:project/tool-calls?limit=100` | 近期工具调用。                                  |
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

Docker runner 把所有模型可见工具展示给模型。Controller 提供 support API，用于权限、状态、持久化、tool-call 审计记录和自定义 toolpack support。`file.read`、`file.write`、`file.patch`、`shell.exec` 和 `web.fetch` 这类 runner-local tools 在 Docker 容器内执行。这些 route 不是公共用户 API。

| 方法   | 路径                                  | 用途                                                                                  |
|--------|---------------------------------------|---------------------------------------------------------------------------------------|
| `POST` | `/runner/tool-calls/start`            | 鉴权 agent/activation，校验工具属于已配置 toolpack 且在 allowlist 中，并创建 running 记录。 |
| `POST` | `/runner/tool-calls/finish`           | 校验 tool call 属于当前 agent activation，然后标记 completed 或 failed。                    |
| `POST` | `/runner/signals`                     | 允许 runner-side 或 local toolpack 代码创建 pending signal 或 closed effect。         |
| `POST` | `/runner/history/messages`            | 为当前 activation append 可见 assistant/history 记录。                                  |
| `POST` | `/runner/history/compact`             | 归档旧 agent history，并 append compaction summary marker。                             |
| `POST` | `/toolpacks/:toolpackId/support`      | 分发 built-in 或 local toolpack 的 controller-side support。                          |
| `POST` | `/activation-context`                 | 提交 running activation 的模型消息上下文快照。                                        |
| `POST` | `/activation-output`                  | 提交最终 activation 文本和 usage metadata。                                           |

Support 请求包含 `project`、`agentId`、`activationId` 和 agent private `token`。Toolpack support 还包含工具名和 input：

    POST /toolpacks/core/support
    {
      "project": "demo",
      "agentId": "pm",
      "activationId": "act_...",
      "token": "agent-private-token",
      "tool": "messages.send",
      "input": {
        "recipient": "user",
        "priority": "P1",
        "body": "Done."
      }
    }

Support host 会在调用 controller support 前校验 token、activation ownership、toolpack membership 和 agent allowlist。

### `POST /runner/signals`

    {
      "project": "demo",
      "agentId": "worker-1",
      "activationId": "act_...",
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

### `POST /activation-output`

    {
      "project": "demo",
      "agentId": "pm",
      "activationId": "act_...",
      "token": "agent-private-token",
      "output": {
        "text": "Activation result text",
        "usage": { "model": "worker-main" }
      }
    }

Backend 只有在收到这个已鉴权提交后才把 activation 标记为完成。`/activation/input.json` 是只读输入和调试 contract；activation output 不再从容器可写文件读取。

### `POST /activation-context`

Docker chat runner 会在主模型调用前提交 context snapshot。公开的 activation context API 用它展示实际发送给模型的 messages。旧 activation 没有该字段时，会回退显示 activation prompt。

### Agent History APIs

`GET /api/projects/:project/agents/:agent/history` 按最新记录优先返回 history rows，支持 `limit`、`before` 和 `includeArchived=0`。每行包含 role、kind、activation id、sequence number、metadata 和截断后的 content。响应里的 `nextBefore` 可用于继续加载更旧页面。

Compaction row 的 metadata 中包含 `compactionId`。`GET /api/projects/:project/agents/:agent/history-archive/:compaction` 会读取 compact 前保存的完整 raw archive。WebUI 普通刷新不拉取 archived payload。

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

### `coordination.wait_for_signal`

    {
      "reason": "Waiting for worker-2's result.",
      "pm": "pm",
      "notifyPm": true
    }

声明当前进展依赖未来 signal，并结束当前 activation。非 PM agent 默认用 direct message 通知 `pm`。PM 调用时会记录 closed useful effect 并安静等待。

### `file.read`

    {
      "path": "/workspace/src/example.txt",
      "offset": 1,
      "limit": 200,
      "maxBytes": 50000
    }

读取 `/workspace`、`/artifacts` 或 `/mnt` 下的文件或目录。相对路径会按 `/workspace` 解析。文件输出会带行号，`offset` 从 1 开始，`limit` 默认 200、上限 2000，`maxBytes` 默认 50000、上限 100000。

### `file.write`

    {
      "path": "/workspace/notes/result.md",
      "content": "Markdown content\n",
      "createDirs": true
    }

完整写入 `/workspace` 或当前 agent 自己的 `/artifacts/<agent-id>` 目录下的文件。相对路径会按 `/workspace` 解析。`file.patch` 处理 targeted edits。

### `file.patch`

    {
      "operations": [
        {
          "op": "update",
          "path": "/workspace/notes/result.md",
          "search": "old text",
          "replace": "new text"
        }
      ]
    }

在 `/workspace` 或当前 agent 自己的 `/artifacts/<agent-id>` 目录下应用精确文本编辑。支持 `add`、`update` 和 `delete`。`update` 需要精确的 `search` 文本；默认必须恰好匹配一次。只有确实要替换全部出现位置时才设置 `replaceAll: true`。

### `shell.exec`

    {
      "command": "cp -r /mnt/reference ./reference && make test",
      "cwd": "/workspace",
      "timeoutMs": 120000,
      "maxOutputBytes": 40000
    }

在 Docker runner 容器内运行 bash。典型操作包括复制 mounted inputs、编译代码、运行二进制、测试和项目本地脚本。只给执行容器命令的 agent 授权。

### `completion.submit`

    {
      "report": "# Final Report\n\n..."
    }

该工具写入 `final-report.md`，把项目设为 `submitted`，等待用户审批。Agent 只有在已经整合相关当前信息、且自己请求的实质回复不再 outstanding 时才应调用它。

### `web.fetch`

    {
      "url": "https://example.com/",
      "maxBytes": 20000,
      "timeoutMs": 30000,
      "format": "text"
    }

从 Docker runner 容器内获取 HTTP(S) URL。`format: "text"` 对 HTML 响应返回清洗文本，对其他内容类型返回原始文本；`format: "raw"` 返回未修改的响应文本。只给确实需要联网的 agent 授权。

## WebUI

根路径 `/` 提供由 `webui/` 构建的 Preact WebUI。它调用上面的 API routes 并定期刷新。开发 WebUI 时，运行 `npm run webui:dev` 并打开 `http://127.0.0.1:5173`；Vite 会把 `/api` 和 `/health` 代理到 `39400` 上的 backend。Control room 包含项目选择、状态操作、消息编辑、agent roster、per-agent history、messages、activations、单次 activation 的模型上下文快照、tool calls、event timeline、resolved YAML 和 submitted report 视图。项目 overview 只刷新轻量 summary；大型 logs、agent histories、config、events、tool calls、archives 和 context payload 都按需加载。

<div class="footer">下一步：<a href="roadmap.html">路线图</a>。</div>
