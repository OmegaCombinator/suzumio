import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NonPreemptiveSignalScheduler } from "../dist/scheduler.js";
import { ProjectStore } from "../dist/store.js";
import { ToolSupportHost } from "../dist/tools.js";

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
        priority: "P1",
        cooldownMs: 300000,
        message: "All agents are quiet.",
      },
      ...(overrides.scheduler ?? {}),
    },
    communication: {
      coordinatorAgent: "pm",
      restrictNonCoordinatorToCoordinator: true,
      nonCoordinatorMaxPriority: "P1",
      pmRoutineVerifierPriority: "P2",
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
      /P1 or lower/,
    );

    const sent = await host.support("core", { ...base, input: { recipient: "pm", priority: "P1", body: "valid report" } });
    assert.match(sent.output, /Message sent and delivered/);
  });
});

test("messages.send defaults routine messages to P2", async () => {
  const config = projectConfig("policy-default-p2");
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
      assert.equal(message?.priority, "P2");
      const signals = checked.pendingSignals("pm", 10);
      assert.equal(signals.length, 1);
      assert.equal(signals[0].priority, "P2");
    } finally {
      checked.close();
    }
  });
});

test("pending P2 signals are delivered one at a time", async () => {
  const config = projectConfig("policy-p2-single");
  await withProject(config, async (root) => {
    const store = new ProjectStore(config.name, root);
    try {
      store.recordSignal({ kind: "test.p2", targetAgent: "worker", priority: "P2", payload: { n: 1 } });
      store.recordSignal({ kind: "test.p2", targetAgent: "worker", priority: "P2", payload: { n: 2 } });
      store.recordSignal({ kind: "test.p2", targetAgent: "worker", priority: "P2", payload: { n: 3 } });

      const p2Only = store.pendingSignals("worker", 20);
      assert.equal(p2Only.length, 1);
      assert.equal(p2Only[0].priority, "P2");

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
        priority: "P1",
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
      assert.equal(signals[0].priority, "P1");
      assert.match(String(signals[0].payload.message), /All agents are quiet/);
    } finally {
      checked.close();
    }
  });
});
