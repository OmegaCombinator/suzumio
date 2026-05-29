---
title: "Suzumio Roadmap"
eyebrow: "Roadmap"
heroTitle: "Make the quiet runtime stronger"
lead: "The first version proves the shape: Docker-first turns, SQLite project truth, signal scheduling, audited support routes, and WebUI observability. The next work should harden those boundaries."
---

## Near Term

<div class="grid">

<div class="card"><h3>Runner event streaming</h3><p>Stream model deltas and tool call state from the container to Suzumio while a turn is running.</p></div>

<div class="card"><h3>Container cleanup policy</h3><p>Keep failed containers for debugging, auto-remove successful containers when configured, and expose cleanup commands.</p></div>

<div class="card"><h3>Safer Docker runtime</h3><p>Add CPU, memory, network, user, read-only mount, and capability controls to backend config.</p></div>

<div class="card"><h3>Better WebUI</h3><p>Add filtering, artifact previews, resolved config view, turn input and result views, and live SSE updates.</p></div>

</div>

## Agent and Model Layer

- Improve AI mode tool-loop handling and streamed outputs.
- Add durable per-agent context summaries without letting the runner own project state.
- Add structured runner events for model fallback, usage, finish reasons, and failures.
- Improve profile composition for explicit model selections and per-agent overrides.

## Tools

- Harden third-party toolpack loading beyond the first local `.mjs` support.
- Add approval-required modes for high-risk shell actions.
- Add domain-specific profiles such as verification, code review, research, and benchmark execution.
- Add artifact download routes and hash verification commands.

## Scheduler

The default scheduler should remain non-preemptive. Future schedulers can be added behind an interface, but they should not weaken the default quiet semantics.

- Expose a scheduler decision log.
- Add manual wake and manual cancel operations.
- Add crash recovery for running turns whose containers disappeared.
- Add project-level concurrency limits.

## Security

- Add user-facing API authentication.
- Redact secrets in config snapshots and logs.
- Introduce least-privilege container defaults.
- Keep committed examples sanitized: no real API keys, real gateways, or private provider names.

## Documentation

- Add a complete config schema reference generated from the TypeScript/Zod schema.
- Add diagrams once the backend contract stabilizes.
- Add cookbook examples for formalization, software development, research, and benchmark projects.
- Keep English and Chinese pages aligned as API and CLI behavior changes.

## Non-goals For Now

- No Kubernetes runtime until Docker-first semantics are stable.
- No complicated workflow DSL before signal turns and toolpacks are reliable.
- No default in-process runner path; isolation remains the baseline.
- No automatic project-manager chatter, progress nagging, or heartbeat prompts.

<div class="footer">Back to <a href="index.html">Overview</a>.</div>
