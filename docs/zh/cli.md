---
title: "Suzumio CLI 参考"
eyebrow: "CLI 参考"
heroTitle: "从终端操作项目"
lead: "CLI 是初始化项目、渲染配置、发送任务、查看运行状态和控制生命周期的最快方式。"
---

## Runtime Root

多数命令读取 `SUZUMIO_ROOT`。支持的命令也可以使用 `--root` 覆盖。

    export SUZUMIO_ROOT=/data/suzumio-runtime
    suzumio status
    suzumio status --root /data/suzumio-runtime

## 命令总览

| 命令                                                         | 适用场景                                                            |
|--------------------------------------------------------------|---------------------------------------------------------------------|
| `suzumio config render <file>`                               | 初始化前检查最终配置。                                              |
| `suzumio init <file>`                                        | 创建项目数据库和工作目录。                                          |
| `suzumio serve`                                              | 启动 HTTP API、controller support routes、WebUI 和 scheduler loop。 |
| `suzumio start <project>`                                    | 允许 scheduler 启动 eligible agents。                               |
| `suzumio send <project> <recipient> <priority> <message...>` | 向 agent 投递用户输入。                                             |
| `suzumio status [project]`                                   | 查看项目和 agent 状态。                                             |
| `suzumio messages <project>`                                 | 查看近期消息。                                                      |
| `suzumio activations <project>`                              | 查看 runner 输出和失败信息。                                        |
| `suzumio events <project>`                                   | 查看事件时间线。                                                    |
| `suzumio tick [project]`                                     | 手动运行一次 scheduler pass。                                       |
| `suzumio stop <project>`                                     | 停止调度。                                                          |
| `suzumio approve <project>`                                  | 把 submitted 项目标记为 completed。                                 |

## `suzumio config render`

    suzumio config render examples/import-demo.yaml

加载 YAML，解析 whole-field import，应用 `extends`，补默认值，验证配置，并打印最终 YAML。常见错误包括必需字段缺失、import 路径不存在、循环 import、scheduler/backend 类型不支持。

## `suzumio init`

    suzumio init examples/demo.yaml
    suzumio init examples/demo.yaml --root /tmp/suzumio-root

在 `SUZUMIO_ROOT` 下创建项目，写入 `source.yaml` 和 `resolved.yaml`，创建 `suzumio.sqlite`，展开 counted agents，创建 workspace，并记录 `project.initialized`。

## `suzumio serve`

    suzumio serve --host 0.0.0.0 --port 39400
    suzumio serve --host 127.0.0.1 --port 39400 --no-scheduler

启动 HTTP API、controller support routes、WebUI static assets、SSE endpoint 和 scheduler loop。使用 `--no-scheduler` 可以只启动 API，再用 `suzumio tick` 手动驱动调度。

| Flag             | 说明                                                    |
|------------------|---------------------------------------------------------|
| `--host`         | 绑定地址。Docker 容器需要访问 host 时通常用 `0.0.0.0`。 |
| `--port`         | HTTP 端口，必须与项目 `backend.controllerUrl` 匹配。    |
| `--root`         | 覆盖 `SUZUMIO_ROOT`。                                   |
| `--no-scheduler` | 不启动自动 scheduler tick。                             |

## `suzumio start` 和 `suzumio send`

    suzumio start demo
    suzumio send demo pm P1 "Start the project."
    suzumio send demo worker-1 P2 "Review artifact art_..."

`start` 将项目状态设为 `running` 并立即 tick 一次 scheduler；如果 agent 已有 pending signal，可能马上启动 activation。`send` 从虚拟 sender `user` 创建直接消息、创建 pending `message.created` signal，并 tick。优先级为 `P0`、`P1`、`P2`：`P0` 会中断并重启 running target，`P1` 尽量在下一次 tool boundary 投递，`P2` 等下一次 activation。

## 查看命令

    suzumio status
    suzumio status demo
    suzumio messages demo --limit 20
    suzumio activations demo --limit 10
    suzumio events demo --limit 50

查看命令直接读取 SQLite，不唤醒 agent，也不会修改项目状态。

## `suzumio tick` 和生命周期

    suzumio tick
    suzumio tick demo
    suzumio stop demo
    suzumio approve demo

`tick` 对全部项目或单个项目运行一次 scheduler pass。`stop` 将项目设为 `stopped`。`approve` 在用户审阅 submitted report 后将项目设为 `completed`。

## Exit Code 和脚本化

命令遇到配置错误、项目缺失、priority 无效或 store 失败时返回非零。脚本中建议先用 `config render` 和 `status` 检查再启动长任务。

<div class="footer">下一步：<a href="architecture.html">架构</a>。</div>
