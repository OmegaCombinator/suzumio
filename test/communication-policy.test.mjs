import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NonPreemptiveSignalScheduler } from "../dist/scheduler.js";
import { ProjectStore } from "../dist/store.js";
import { ToolSupportHost } from "../dist/tools.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEDULER_TOOLPACK = path.join(REPO_ROOT, "toolpacks", "scheduler");
const PLAN_TOOLPACK = path.join(REPO_ROOT, "toolpacks", "plan");

function projectConfig(name, overrides = {}) {
  return {
    name,
    task: "Test communication policy.",
    scheduler: {
      kind: "nonpreemptive-signals",
      maxSignalsPerActivation: 20,
      allQuietNudge: {
        enabled: false,
        targetAgent: "pm",
        priority: "P2",
        cooldownMs: 300000,
        message: "All agents are quiet.",
      },
      ...(overrides.scheduler ?? {}),
    },
    communication: {
      coordinatorAgent: "pm",
      restrictNonCoordinatorToCoordinator: true,
      nonCoordinatorMaxPriority: "P2",
      pmRoutineVerifierPriority: "P3",
      ...(overrides.communication ?? {}),
    },
    backend: {
      kind: "docker-chat",
      image: "suzumio-runner:dev",
      controllerUrl: "http://127.0.0.1:39400",
      docker: { mounts: [], proxy: { inheritEnv: true, rewriteLocalhost: true } },
      runner: { mode: "ai" },
    },
    agents: {
      pm: { role: "pm", prompt: "", tools: ["messages.send"] },
      worker: { role: "worker", prompt: "", tools: ["messages.send"] },
      verifier: { role: "verifier", prompt: "", tools: ["messages.send"] },
    },
    channels: ["#project"],
    tools: { toolpacks: ["core"] },
    observability: { http: { enabled: true, host: "127.0.0.1", port: 39400 }, webui: { enabled: true } },
  };
}

async function withProject(config, fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "suzumio-policy-"));
  const store = await ProjectStore.initialize({ config, sourceText: "test", resolvedText: "test", root });
  store.close();
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createRunningActivation(root, project, agentId) {
  const store = new ProjectStore(project, root);
  try {
    const agent = store.requireAgent(agentId);
    const activation = store.createActivation(agent, "test activation");
    return { activation, token: agent.token };
  } finally {
    store.close();
  }
}

test("communication policy restricts non-coordinator messages", async () => {
  const config = projectConfig("policy-acl");
  await withProject(config, async (root) => {
    const host = new ToolSupportHost(root);
    const { activation, token } = await createRunningActivation(root, config.name, "worker");
    const base = { project: config.name, agentId: "worker", activationId: activation.id, token, tool: "messages.send" };

    await assert.rejects(
      () => host.support("core", { ...base, input: { recipient: "verifier", priority: "P1", body: "review this" } }),
      /message only pm/,
    );
    await assert.rejects(
      () => host.support("core", { ...base, input: { recipient: "user", priority: "P1", body: "report" } }),
      /message only pm/,
    );
    await assert.rejects(
      () => host.support("core", { ...base, input: { channel: "#project", priority: "P1", body: "broadcast" } }),
      /channels are not allowed/,
    );
    await assert.rejects(
      () => host.support("core", { ...base, input: { recipient: "pm", priority: "P0", body: "not an emergency" } }),
      /P2 or lower/,
    );

    const sent = await host.support("core", { ...base, input: { recipient: "pm", priority: "P2", body: "valid report" } });
    assert.match(sent.output, /Message sent and delivered/);
  });
});

test("messages.send defaults routine messages to P3", async () => {
  const config = projectConfig("policy-default-p3");
  await withProject(config, async (root) => {
    const host = new ToolSupportHost(root);
    const { activation, token } = await createRunningActivation(root, config.name, "worker");
    const base = { project: config.name, agentId: "worker", activationId: activation.id, token, tool: "messages.send" };

    const sent = await host.support("core", { ...base, input: { recipient: "pm", body: "routine status" } });
    assert.match(sent.output, /Message sent and delivered/);

    const checked = new ProjectStore(config.name, root);
    try {
      const messages = checked.listMessages(10);
      const message = messages.find((item) => item.body === "routine status");
      assert.equal(message?.priority, "P3");
      const signals = checked.pendingSignals("pm", 10);
      assert.equal(signals.length, 1);
      assert.equal(signals[0].priority, "P3");
    } finally {
      checked.close();
    }
  });
});

test("core toolpack registers project stats for WebUI", async () => {
  const config = projectConfig("policy-webui-stats");
  await withProject(config, async (root) => {
    const host = new ToolSupportHost(root);
    const entries = await host.listWebui(config.name);
    const ids = entries.map((entry) => `${entry.toolpackId}/${entry.id}`).sort();
    assert.deepEqual(ids, [
      "core/completion.report",
      "core/coordination.signals",
      "core/file.activity",
      "core/messages.conversation",
      "core/messages.send",
      "core/project.stats",
    ]);
    const stats = entries.find((entry) => entry.toolpackId === "core" && entry.id === "project.stats");
    assert.ok(stats);
    assert.equal(stats.kind, "panel");

    const result = await host.invokeWebui(config.name, "core", "project.stats", {});
    assert.equal(result.title, "Project statistics");
    assert.match(result.output, /Agents: 3/);
    assert.ok(Array.isArray(result.metadata.metrics));
  });
});

test("builtin WebUI controls send messages and summarize activity", async () => {
  const config = projectConfig("policy-builtin-webui-controls");
  config.tools = { toolpacks: ["core", "shell", "web"] };
  config.agents.pm.tools = ["*"];
  config.agents.worker.tools = ["*"];
  await withProject(config, async (root) => {
    const host = new ToolSupportHost(root);
    const entries = await host.listWebui(config.name);
    const ids = entries.map((entry) => `${entry.toolpackId}/${entry.id}`);
    assert.ok(ids.includes("core/messages.send"));
    assert.ok(ids.includes("core/messages.conversation"));
    assert.ok(ids.includes("core/coordination.signals"));
    assert.ok(ids.includes("core/completion.report"));
    assert.ok(ids.includes("core/file.activity"));
    assert.ok(ids.includes("shell/shell.activity"));
    assert.ok(ids.includes("web/web.activity"));

    const sent = await host.invokeWebui(config.name, "core", "messages.send", { sender: "user", recipient: "worker", priority: "P2", body: "Please inspect the artifact." });
    assert.match(sent.output, /Message sent/);

    const conversation = await host.invokeWebui(config.name, "core", "messages.conversation", { agentA: "user", agentB: "worker", limit: 10 });
    assert.match(conversation.output, /Please inspect the artifact/);

    const signals = await host.invokeWebui(config.name, "core", "coordination.signals", { targetAgent: "worker", limit: 10 });
    assert.match(signals.output, /message\.created/);

    const { activation, token } = await createRunningActivation(root, config.name, "worker");
    const fileCall = await host.startToolCall({ project: config.name, agentId: "worker", activationId: activation.id, token, tool: "file.read", input: { path: "/workspace/README.md" } });
    await host.finishToolCall({ project: config.name, agentId: "worker", activationId: activation.id, token, toolCallId: fileCall.toolCallId, status: "completed", output: "ok" });
    const shellCall = await host.startToolCall({ project: config.name, agentId: "worker", activationId: activation.id, token, tool: "shell.exec", input: { command: "npm test", cwd: "/workspace" } });
    await host.finishToolCall({ project: config.name, agentId: "worker", activationId: activation.id, token, toolCallId: shellCall.toolCallId, status: "failed", error: "exit 1" });
    const webCall = await host.startToolCall({ project: config.name, agentId: "worker", activationId: activation.id, token, tool: "web.fetch", input: { url: "https://example.com/", format: "text" } });
    await host.finishToolCall({ project: config.name, agentId: "worker", activationId: activation.id, token, toolCallId: webCall.toolCallId, status: "completed", output: "example" });

    const fileActivity = await host.invokeWebui(config.name, "core", "file.activity", { limit: 10 });
    assert.match(fileActivity.output, /file\.read/);
    assert.match(fileActivity.output, /\/workspace\/README\.md/);
    const shellActivity = await host.invokeWebui(config.name, "shell", "shell.activity", { limit: 10 });
    assert.match(shellActivity.output, /npm test/);
    assert.match(shellActivity.output, /exit 1/);
    const webActivity = await host.invokeWebui(config.name, "web", "web.activity", { limit: 10 });
    assert.match(webActivity.output, /https:\/\/example\.com\//);

    const pmActivation = await createRunningActivation(root, config.name, "pm");
    await host.support("core", { project: config.name, agentId: "pm", activationId: pmActivation.activation.id, token: pmActivation.token, tool: "completion.submit", input: { report: "Final report from PM." } });
    const report = await host.invokeWebui(config.name, "core", "completion.report", {});
    assert.match(report.output, /Final report from PM/);
  });
});

test("tool status summarizes calls and submitted report", async () => {
  const config = projectConfig("policy-tool-status");
  config.agents.pm.tools = ["messages.send", "completion.submit"];
  await withProject(config, async (root) => {
    const host = new ToolSupportHost(root);
    const { activation, token } = await createRunningActivation(root, config.name, "worker");
    const started = await host.startToolCall({ project: config.name, agentId: "worker", activationId: activation.id, token, tool: "messages.send", input: { recipient: "pm", body: "hello" } });
    await host.finishToolCall({ project: config.name, agentId: "worker", activationId: activation.id, token, toolCallId: started.toolCallId, status: "failed", error: "network down" });

    const statuses = await host.listToolStatus(config.name);
    const messagesSend = statuses.find((item) => item.tool === "messages.send");
    assert.ok(messagesSend);
    assert.equal(messagesSend.callCount, 1);
    assert.equal(messagesSend.failedCount, 1);
    assert.equal(messagesSend.lastStatus, "failed");
    assert.equal(messagesSend.lastError, "network down");
    assert.equal(Object.hasOwn(messagesSend, "input_json"), false);

    const pmActivation = await createRunningActivation(root, config.name, "pm");
    await host.support("core", { project: config.name, agentId: "pm", activationId: pmActivation.activation.id, token: pmActivation.token, tool: "completion.submit", input: { report: "Final answer." } });
    const afterSubmit = await host.listToolStatus(config.name);
    const submit = afterSubmit.find((item) => item.tool === "completion.submit");
    assert.ok(submit);
    assert.ok(submit.enabledForAgents.includes("pm"));
    assert.match(submit.submittedReportPath, /final-report\.md$/);
  });
});

test("local WebUI-only toolpacks do not require a runner module", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "suzumio-webui-toolpack-"));
  try {
    const toolpack = path.join(root, "review-tools");
    await mkdir(toolpack, { recursive: true });
    await writeFile(path.join(toolpack, "suzumio.toolpack.json"), JSON.stringify({
      id: "review-tools",
      controller: "controller.mjs",
      tools: [],
      webui: [{ id: "review.stats", title: "Review stats", kind: "panel" }],
    }, null, 2));
    await writeFile(path.join(toolpack, "controller.mjs"), `export const webui = { "review.stats": async () => ({ title: "Review stats", output: "ok" }) };\n`);
    const config = projectConfig("policy-local-webui-only");
    config.tools = { toolpacks: [{ path: toolpack, id: "review-tools" }] };
    await withProject(config, async (projectRoot) => {
      const host = new ToolSupportHost(projectRoot);
      const entries = await host.listWebui(config.name);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].id, "review.stats");
      const result = await host.invokeWebui(config.name, "review-tools", "review.stats", {});
      assert.equal(result.output, "ok");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pending P2 and P3 signals are delivered one at a time", async () => {
  const config = projectConfig("policy-routine-single");
  await withProject(config, async (root) => {
    const store = new ProjectStore(config.name, root);
    try {
      store.recordSignal({ kind: "test.p3", targetAgent: "worker", priority: "P3", payload: { n: 0 } });
      store.recordSignal({ kind: "test.p2", targetAgent: "worker", priority: "P2", payload: { n: 1 } });
      store.recordSignal({ kind: "test.p2", targetAgent: "worker", priority: "P2", payload: { n: 2 } });
      store.recordSignal({ kind: "test.p2", targetAgent: "worker", priority: "P2", payload: { n: 3 } });

      const routine = store.pendingSignals("worker", 20);
      assert.equal(routine.length, 1);
      assert.equal(routine[0].priority, "P2");

      store.recordSignal({ kind: "test.p1", targetAgent: "worker", priority: "P1", payload: { n: 4 } });
      store.recordSignal({ kind: "test.p1", targetAgent: "worker", priority: "P1", payload: { n: 5 } });

      const highPriority = store.pendingSignals("worker", 20);
      assert.equal(highPriority.length, 2);
      assert.deepEqual(highPriority.map((signal) => signal.priority), ["P1", "P1"]);
    } finally {
      store.close();
    }
  });
});

test("external scheduler toolpack sends due scheduled messages", async () => {
  const config = projectConfig("policy-scheduler-toolpack");
  config.tools = { toolpacks: ["core", { path: SCHEDULER_TOOLPACK, id: "scheduler" }] };
  config.agents.pm.tools = ["messages.send", "schedule.*"];
  await withProject(config, async (root) => {
    const host = new ToolSupportHost(root);
    const { activation, token } = await createRunningActivation(root, config.name, "pm");
    const base = { project: config.name, agentId: "pm", activationId: activation.id, token, tool: "schedule.once" };

    const dueAt = new Date(Date.now() - 1000).toISOString();
    const scheduled = await host.support("scheduler", { ...base, input: { at: dueAt, recipient: "worker", body: "Check the build in one hour." } });
    assert.match(scheduled.output, /Scheduled sch_/);

    const store = new ProjectStore(config.name, root);
    store.setProjectStatus("running");
    store.close();

    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    const checked = new ProjectStore(config.name, root);
    try {
      const message = checked.listMessages(10).find((item) => item.body === "Check the build in one hour.");
      assert.equal(message?.sender, "scheduler");
      assert.equal(message?.recipient, "worker");
      assert.equal(message?.priority, "P3");
      const signals = checked.pendingSignals("worker", 10);
      assert.equal(signals.length, 1);
      assert.equal(signals[0].kind, "message.created");
      assert.equal(signals[0].priority, "P3");
    } finally {
      checked.close();
    }

    const jobs = await host.invokeWebui(config.name, "scheduler", "schedule.jobs", { includeInactive: true });
    assert.match(jobs.output, /done\/once/);
  });
});

test("external scheduler toolpack can wait for a live recipient model", async () => {
  const config = projectConfig("policy-scheduler-wait-live");
  config.tools = { toolpacks: ["core", { path: SCHEDULER_TOOLPACK, id: "scheduler" }] };
  config.agents.pm.tools = ["messages.send", "schedule.*"];
  await withProject(config, async (root) => {
    const host = new ToolSupportHost(root);
    const { activation, token } = await createRunningActivation(root, config.name, "pm");
    const base = { project: config.name, agentId: "pm", activationId: activation.id, token, tool: "schedule.once" };
    const dueAt = new Date(Date.now() - 1000).toISOString();
    await host.support("scheduler", { ...base, input: { at: dueAt, recipient: "pm", waitForQuiet: true, body: "Continue after the current model turn." } });

    let store = new ProjectStore(config.name, root);
    store.setProjectStatus("running");
    store.close();
    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    let checked = new ProjectStore(config.name, root);
    try {
      assert.equal(checked.listMessages(10).some((item) => item.body === "Continue after the current model turn."), false);
    } finally {
      checked.close();
    }

    store = new ProjectStore(config.name, root);
    store.cancelActivation(activation.id, "test completed running turn");
    store.close();
    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    checked = new ProjectStore(config.name, root);
    try {
      const message = checked.listMessages(10).find((item) => item.body === "Continue after the current model turn.");
      assert.equal(message?.recipient, "pm");
      assert.equal(message?.priority, "P3");
    } finally {
      checked.close();
    }
  });
});

test("external plan toolpack tracks item statuses and archives completed plans", async () => {
  const config = projectConfig("policy-plan-toolpack");
  config.tools = { toolpacks: ["core", { path: PLAN_TOOLPACK, id: "plan" }] };
  config.agents.pm.tools = ["messages.send", "plan.*"];
  await withProject(config, async (root) => {
    const host = new ToolSupportHost(root);
    const { activation, token } = await createRunningActivation(root, config.name, "pm");
    const base = { project: config.name, agentId: "pm", activationId: activation.id, token };

    const created = await host.support("plan", { ...base, tool: "plan.create", input: { title: "Proof pass", itemsText: "Inspect files\nRun tests", nudgeCooldownMs: 0 } });
    assert.match(created.output, /Plan pln_/);
    assert.match(created.output, /1\. item_1 \[tbd\] Inspect files/);

    await host.support("plan", { ...base, tool: "plan.set_item_status", input: { itemId: "item_1", status: "done", note: "files inspected" } });
    const updated = await host.support("plan", { ...base, tool: "plan.set_item_status", input: { itemIndex: 2, status: "wont_do", note: "tests moved to verifier" } });
    assert.match(updated.output, /Status: done/);
    assert.match(updated.output, /item_2 \[wont_do\] Run tests/);

    const webuiStatus = await host.invokeWebui(config.name, "plan", "plan.board", {});
    assert.match(webuiStatus.output, /Proof pass/);
    assert.equal(webuiStatus.metadata.activePlan.status, "done");

    const closed = await host.support("plan", { ...base, tool: "plan.close", input: { status: "done", reason: "complete" } });
    assert.match(closed.output, /No active plan/);
    assert.match(closed.output, /Archived plans:/);
  });
});

test("external plan toolpack nudges incomplete plans only when target model is not alive", async () => {
  const config = projectConfig("policy-plan-nudge");
  config.tools = { toolpacks: ["core", { path: PLAN_TOOLPACK, id: "plan" }] };
  config.agents.pm.tools = ["messages.send", "plan.*"];
  await withProject(config, async (root) => {
    const host = new ToolSupportHost(root);
    const { activation, token } = await createRunningActivation(root, config.name, "pm");
    const base = { project: config.name, agentId: "pm", activationId: activation.id, token, tool: "plan.create" };
    await host.support("plan", { ...base, input: { title: "Keep working", targetAgent: "pm", itemsText: "Finish implementation\nUpdate docs", nudgeCooldownMs: 0 } });

    let store = new ProjectStore(config.name, root);
    store.setProjectStatus("running");
    store.close();
    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    let checked = new ProjectStore(config.name, root);
    try {
      assert.equal(checked.pendingSignals("pm", 10).some((signal) => signal.kind === "plan.continuation_nudge"), false);
    } finally {
      checked.close();
    }

    store = new ProjectStore(config.name, root);
    store.cancelActivation(activation.id, "test completed running turn");
    store.close();
    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    checked = new ProjectStore(config.name, root);
    try {
      const nudges = checked.pendingSignals("pm", 10).filter((signal) => signal.kind === "plan.continuation_nudge");
      assert.equal(nudges.length, 1);
      assert.equal(nudges[0].priority, "P2");
      assert.match(String(nudges[0].payload.message), /Continue the active plan/);
      assert.deepEqual(nudges[0].payload.remainingItems.map((item) => item.id), ["item_1", "item_2"]);
    } finally {
      checked.close();
    }
  });
});

test("no-effect nudge honors a configured finite limit", async () => {
  const config = projectConfig("policy-no-effect-repeat", {
    scheduler: {
      noEffectNudge: { enabled: true, priority: "P2", maxConsecutive: 2, initialDelayMs: 0, backoffFactor: 2, maxDelayMs: 300000 },
    },
  });
  await withProject(config, async (root) => {
    const store = new ProjectStore(config.name, root);
    try {
      const worker = store.requireAgent("worker");

      const first = store.createActivation(worker, "first");
      store.completeActivation(first.id, { text: "" });
      const firstNudge = store.pendingSignals("worker", 10);
      assert.equal(firstNudge.length, 1);
      assert.equal(firstNudge[0].kind, "scheduler.no_effect_nudge");
      assert.equal(firstNudge[0].priority, "P2");
      assert.equal(firstNudge[0].payload.attempt, 1);

      const second = store.createActivation(worker, "second");
      store.markSignalsDelivered("worker", firstNudge, second.id);
      store.completeActivation(second.id, { text: "" });
      const secondNudge = store.pendingSignals("worker", 10);
      assert.equal(secondNudge.length, 1);
      assert.equal(secondNudge[0].kind, "scheduler.no_effect_nudge");
      assert.equal(secondNudge[0].payload.attempt, 2);

      const third = store.createActivation(worker, "third");
      store.markSignalsDelivered("worker", secondNudge, third.id);
      store.completeActivation(third.id, { text: "" });
      const afterLimit = store.pendingSignals("worker", 10);
      assert.equal(afterLimit.length, 0);
    } finally {
      store.close();
    }
  });
});

test("no-effect nudge continues with exponential backoff", async () => {
  const config = projectConfig("policy-no-effect-backoff", {
    scheduler: {
      noEffectNudge: { enabled: true, priority: "P2", maxConsecutive: 0, initialDelayMs: 1000, backoffFactor: 2, maxDelayMs: 5000 },
    },
  });
  await withProject(config, async (root) => {
    const store = new ProjectStore(config.name, root);
    try {
      const worker = store.requireAgent("worker");

      const first = store.createActivation(worker, "first");
      store.completeActivation(first.id, { text: "" });
      const firstNudge = store.pendingSignals("worker", 10);
      assert.equal(firstNudge.length, 1);
      assert.equal(firstNudge[0].payload.attempt, 1);
      assert.equal(firstNudge[0].payload.delayMs, 0);

      const second = store.createActivation(worker, "second");
      store.markSignalsDelivered("worker", firstNudge, second.id);
      store.completeActivation(second.id, { text: "" });
      assert.equal(store.pendingSignals("worker", 10).length, 0);

      const delayed = store.db.prepare("SELECT id, payload_json, not_before FROM signals WHERE project = ? AND kind = 'scheduler.no_effect_nudge' AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(config.name);
      assert.ok(delayed);
      const delayedPayload = JSON.parse(delayed.payload_json);
      assert.equal(delayedPayload.attempt, 2);
      assert.equal(delayedPayload.delayMs, 1000);
      assert.ok(Date.parse(delayed.not_before) > Date.now());

      store.db.prepare("UPDATE signals SET not_before = created_at WHERE project = ? AND id = ?").run(config.name, delayed.id);
      const secondNudge = store.pendingSignals("worker", 10);
      assert.equal(secondNudge.length, 1);
      assert.equal(secondNudge[0].payload.attempt, 2);

      const third = store.createActivation(worker, "third");
      store.markSignalsDelivered("worker", secondNudge, third.id);
      store.completeActivation(third.id, { text: "" });
      const later = store.db.prepare("SELECT payload_json FROM signals WHERE project = ? AND kind = 'scheduler.no_effect_nudge' AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(config.name);
      assert.ok(later);
      const laterPayload = JSON.parse(later.payload_json);
      assert.equal(laterPayload.attempt, 3);
      assert.equal(laterPayload.delayMs, 2000);
    } finally {
      store.close();
    }
  });
});

test("all-quiet scheduler nudge creates a pending PM signal", async () => {
  const config = projectConfig("policy-all-quiet", {
    scheduler: {
      allQuietNudge: {
        enabled: true,
        targetAgent: "pm",
        priority: "P2",
        cooldownMs: 300000,
        message: "All agents are quiet and no work is pending.",
      },
    },
  });
  await withProject(config, async (root) => {
    const store = new ProjectStore(config.name, root);
    store.setProjectStatus("running");
    store.close();

    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    const checked = new ProjectStore(config.name, root);
    try {
      const signals = checked.pendingSignals("pm", 10);
      assert.equal(signals.length, 1);
      assert.equal(signals[0].kind, "scheduler.all_quiet_nudge");
      assert.equal(signals[0].priority, "P2");
      assert.match(String(signals[0].payload.message), /All agents are quiet/);
    } finally {
      checked.close();
    }
  });
});

test("quiet agent monitor sends PM messages and repeats after interval", async () => {
  const config = projectConfig("policy-quiet-monitor", {
    scheduler: {
      quietAgentMonitor: {
        enabled: true,
        rules: [
          {
            id: "worker-quiet",
            agent: "worker",
            recipient: "pm",
            sender: "monitor",
            priority: "P2",
            initialDelayMs: 30 * 60 * 1000,
            repeatDelayMs: 15 * 60 * 1000,
            message: "{{agent}} has been quiet for {{quietMinutes}} minutes; attempt {{attempt}}.",
          },
        ],
      },
    },
  });
  await withProject(config, async (root) => {
    const quietSince = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const store = new ProjectStore(config.name, root);
    try {
      store.setProjectStatus("running");
      store.db.prepare("UPDATE agents SET updated_at = ? WHERE project = ? AND id = ?").run(quietSince, config.name, "worker");
    } finally {
      store.close();
    }

    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    const checked = new ProjectStore(config.name, root);
    try {
      const messages = checked.listMessages(10).filter((message) => message.sender === "monitor");
      assert.equal(messages.length, 1);
      assert.equal(messages[0].recipient, "pm");
      assert.equal(messages[0].priority, "P2");
      assert.match(messages[0].body, /worker has been quiet for 31 minutes; attempt 1\./);

      const signals = checked.pendingSignals("pm", 10);
      assert.equal(signals.length, 1);
      assert.equal(signals[0].kind, "message.created");
      checked.markSignalsDelivered("pm", signals, "act_test_monitor_delivery");
    } finally {
      checked.close();
    }

    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    const afterImmediateTick = new ProjectStore(config.name, root);
    try {
      assert.equal(afterImmediateTick.listMessages(10).filter((message) => message.sender === "monitor").length, 1);
      const oldEventTime = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      afterImmediateTick.db.prepare("UPDATE events SET created_at = ? WHERE project = ? AND type = ?").run(oldEventTime, config.name, "scheduler.quiet_agent_monitor.message_sent");
    } finally {
      afterImmediateTick.close();
    }

    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    const afterRepeat = new ProjectStore(config.name, root);
    try {
      const messages = afterRepeat.listMessages(10).filter((message) => message.sender === "monitor");
      assert.equal(messages.length, 2);
      assert.match(messages[1].body, /attempt 2\./);
    } finally {
      afterRepeat.close();
    }
  });
});

test("failed nudge creates delayed retry signals with backoff", async () => {
  const config = projectConfig("policy-failed-nudge", {
    scheduler: {
      failedNudge: {
        enabled: true,
        priority: "P2",
        maxConsecutive: 2,
        initialDelayMs: 1000,
        backoffFactor: 2,
        maxDelayMs: 5000,
        message: "Retry after failure.",
      },
    },
  });
  await withProject(config, async (root) => {
    const store = new ProjectStore(config.name, root);
    try {
      store.setProjectStatus("running");
      const worker = store.requireAgent("worker");
      const first = store.createActivation(worker, "first");
      store.failActivation(first.id, "provider timeout");
    } finally {
      store.close();
    }

    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    const afterFirst = new ProjectStore(config.name, root);
    let firstNudge;
    try {
      firstNudge = afterFirst.db.prepare("SELECT id, payload_json, not_before FROM signals WHERE project = ? AND kind = 'scheduler.failed_nudge' ORDER BY created_at DESC LIMIT 1").get(config.name);
      assert.ok(firstNudge);
      const payload = JSON.parse(firstNudge.payload_json);
      assert.equal(payload.attempt, 1);
      assert.equal(payload.delayMs, 1000);
      assert.equal(payload.error, "provider timeout");
      assert.ok(Date.parse(firstNudge.not_before) > Date.now());

      afterFirst.db.prepare("UPDATE signals SET not_before = created_at WHERE project = ? AND id = ?").run(config.name, firstNudge.id);
      const ready = afterFirst.pendingSignals("worker", 10);
      assert.equal(ready.length, 1);
      assert.equal(ready[0].kind, "scheduler.failed_nudge");

      const worker = afterFirst.requireAgent("worker");
      const second = afterFirst.createActivation(worker, "second");
      afterFirst.markSignalsDelivered("worker", ready, second.id);
      afterFirst.failActivation(second.id, "provider timeout again");
    } finally {
      afterFirst.close();
    }

    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    const afterSecond = new ProjectStore(config.name, root);
    try {
      const secondNudge = afterSecond.db.prepare("SELECT payload_json, not_before FROM signals WHERE project = ? AND kind = 'scheduler.failed_nudge' AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(config.name);
      assert.ok(secondNudge);
      const payload = JSON.parse(secondNudge.payload_json);
      assert.equal(payload.attempt, 2);
      assert.equal(payload.delayMs, 2000);
      assert.ok(Date.parse(secondNudge.not_before) > Date.now());
    } finally {
      afterSecond.close();
    }
  });
});

test("failed agent monitor sends PM messages and repeats after interval", async () => {
  const config = projectConfig("policy-failed-monitor", {
    scheduler: {
      failedAgentMonitor: {
        enabled: true,
        rules: [
          {
            id: "worker-failed",
            agent: "worker",
            recipient: "pm",
            sender: "monitor",
            priority: "P2",
            initialDelayMs: 30 * 60 * 1000,
            repeatDelayMs: 15 * 60 * 1000,
            message: "{{agent}} failed for {{failedMinutes}} minutes after {{activationId}}; attempt {{attempt}}; error {{error}}.",
          },
        ],
      },
    },
  });
  await withProject(config, async (root) => {
    let activationId;
    const failedSince = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    const store = new ProjectStore(config.name, root);
    try {
      store.setProjectStatus("running");
      const worker = store.requireAgent("worker");
      const activation = store.createActivation(worker, "failed");
      activationId = activation.id;
      store.failActivation(activation.id, "model timeout");
      store.db.prepare("UPDATE activations SET completed_at = ? WHERE project = ? AND id = ?").run(failedSince, config.name, activation.id);
      store.db.prepare("UPDATE agents SET updated_at = ? WHERE project = ? AND id = ?").run(failedSince, config.name, "worker");
    } finally {
      store.close();
    }

    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    const checked = new ProjectStore(config.name, root);
    try {
      const messages = checked.listMessages(10).filter((message) => message.sender === "monitor");
      assert.equal(messages.length, 1);
      assert.equal(messages[0].recipient, "pm");
      assert.equal(messages[0].priority, "P2");
      assert.match(messages[0].body, new RegExp(`worker failed for 31 minutes after ${activationId}; attempt 1; error model timeout\\.`));

      const signals = checked.pendingSignals("pm", 10);
      assert.equal(signals.length, 1);
      assert.equal(signals[0].kind, "message.created");
      checked.markSignalsDelivered("pm", signals, "act_test_failed_monitor_delivery");
    } finally {
      checked.close();
    }

    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    const afterImmediateTick = new ProjectStore(config.name, root);
    try {
      assert.equal(afterImmediateTick.listMessages(10).filter((message) => message.sender === "monitor").length, 1);
      const oldEventTime = new Date(Date.now() - 16 * 60 * 1000).toISOString();
      afterImmediateTick.db.prepare("UPDATE events SET created_at = ? WHERE project = ? AND type = ?").run(oldEventTime, config.name, "scheduler.failed_agent_monitor.message_sent");
    } finally {
      afterImmediateTick.close();
    }

    await new NonPreemptiveSignalScheduler(root).tickProject(config.name);

    const afterRepeat = new ProjectStore(config.name, root);
    try {
      const messages = afterRepeat.listMessages(10).filter((message) => message.sender === "monitor");
      assert.equal(messages.length, 2);
      assert.match(messages[1].body, /attempt 2/);
    } finally {
      afterRepeat.close();
    }
  });
});
