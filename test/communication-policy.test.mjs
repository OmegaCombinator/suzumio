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
