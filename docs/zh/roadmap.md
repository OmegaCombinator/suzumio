---
title: "Suzumio 路线图"
eyebrow: "路线图"
heroTitle: "让安静运行时更可靠"
lead: "第一版验证了核心形状：Docker-first turns、SQLite project truth、mailbox scheduling、audited support routes 和 WebUI observability。下一步应强化这些边界。"
---

## 近期工作

<div class="grid">

<div class="card"><h3>Runner event streaming</h3><p>在 turn 运行时，把模型 delta 和工具调用状态从容器流式传回 Suzumio。</p></div>

<div class="card"><h3>Container cleanup policy</h3><p>失败容器保留用于调试；成功容器可配置自动删除；暴露 cleanup 命令。</p></div>

<div class="card"><h3>更安全的 Docker runtime</h3><p>在 backend config 中加入 CPU、memory、network、user、read-only mount 和 capability 控制。</p></div>

<div class="card"><h3>更好的 WebUI</h3><p>加入过滤、artifact preview、resolved config view、turn input 和 result view，以及 live SSE updates。</p></div>

</div>

## Agent 和 Model Layer

- 改进 AI mode 的 tool-loop 和 streamed outputs。
- 加入持久 per-agent context summary，但不让 runner 拥有项目状态。
- 记录 model fallback、usage、finish reason 和 failure 的结构化 runner events。
- 改进显式 model selection 和 per-agent override 的 profile 组合。

## Tools

- 在内置 `core`、`artifacts`、`shell`、`web` 之外加入第三方 toolpack loading。
- 为高风险 shell action 加入 approval-required 模式。
- 增加 verification、code review、research、benchmark execution 等领域 profile。
- 加入 artifact download routes 和 hash verification commands。

## Scheduler

默认 scheduler 应保持非抢占式。未来可以在接口后添加其他 scheduler，但不能削弱默认安静语义。

- 暴露 scheduler decision log。
- 加入 manual wake 和 manual cancel 操作。
- 恢复 running turn 但容器消失的 crash 状态。
- 加入 project-level concurrency limits。

## Security

- 为用户 API 增加鉴权。
- 在 config snapshot 和 logs 中 redact secrets。
- 引入 least-privilege container defaults。
- 保持提交示例脱敏：不包含真实 API key、真实 gateway 或私有 provider 名称。

## Documentation

- 从 TypeScript/Zod schema 生成完整 config schema reference。
- 在 backend contract 稳定后加入图示。
- 增加 formalization、software development、research、benchmark project cookbook。
- 随着 API 和 CLI 行为变化同步更新中英文页面。

## 当前非目标

- Docker-first 语义稳定前不做 Kubernetes runtime。
- Mailbox turns 和 toolpacks 可靠前不引入复杂 workflow DSL。
- 默认不提供 in-process runner path；隔离仍是 baseline。
- 不做自动 PM chatter、progress nagging 或 heartbeat prompts。

<div class="footer">回到 <a href="index.html">概览</a>。</div>
