import type { AgentConfig, AgentRecord, DockerMountConfig, ProjectConfig, SignalRecord } from "./types.js";
import { DockerChatBackend } from "./backend.js";
import { ProjectStore } from "./store.js";

export class NonPreemptiveSignalScheduler {
  private readonly backend: DockerChatBackend;

  constructor(private readonly root?: string) {
    this.backend = new DockerChatBackend(root);
  }

  async tickProject(project: string): Promise<void> {
    const store = new ProjectStore(project, this.root);
    try {
      const projectRow = store.projectRow();
      if (projectRow.status !== "running") return;
      const agents = store.listAgents();
      for (const agent of agents) await this.tickAgent(store, agent, agents);
      this.maybeNudgeAllQuiet(store);
    } finally {
      store.close();
    }
  }

  async tickAll(): Promise<void> {
    for (const project of await ProjectStore.list(this.root)) await this.tickProject(project);
  }

  private async tickAgent(store: ProjectStore, agent: AgentRecord, agents: AgentRecord[]): Promise<void> {
    const config = store.config();
    if (agent.status === "stopped") return;
    let restartSignals: SignalRecord[] | undefined;

    if (agent.status === "running" || agent.activeActivationId) {
      const pending = store.pendingSignals(agent.id, signalsPerActivation(config));
      const p0 = pending.filter((signal) => signal.priority === "P0");
      if (p0.length === 0) return;
      restartSignals = pending.filter((signal) => signal.priority === "P0" || signal.priority === "P1");
      if (agent.activeActivationId) {
        const activation = store.activation(agent.activeActivationId);
        store.cancelActivation(activation.id, `Interrupted by P0 signal ${p0[0]!.id}`);
        await this.backend.stopActivation(activation).catch((error) => store.appendEvent("activation.stop_failed", { activationId: activation.id, agentId: agent.id, error: error instanceof Error ? error.message : String(error) }));
      } else {
        store.setAgentStatus(agent.id, "quiet", null);
      }
      agent = store.requireAgent(agent.id);
    }

    const signals = restartSignals ?? store.pendingSignals(agent.id, signalsPerActivation(config));
    if (signals.length === 0) {
      if (agent.status !== "quiet" && agent.status !== "failed") store.setAgentStatus(agent.id, "quiet", null);
      return;
    }
    const hasPreviousActivations = store.agentActivationHistory(agent.id, 1).length > 0;
    const prompt = renderActivationPrompt(config, agent, agents, signals, hasPreviousActivations);
    const activation = store.createActivation(agent, prompt);
    store.appendAgentHistoryMessage({
      agentId: agent.id,
      activationId: activation.id,
      role: "user",
      kind: "activation_prompt",
      content: prompt,
      metadata: { delivery: "activation_start", signalIds: signals.map((signal) => signal.id), priorities: signals.map((signal) => signal.priority) },
    });
    store.markSignalsDelivered(agent.id, signals, activation.id);
    await this.backend.startActivation(store, agent, activation, prompt);
  }

  private maybeNudgeAllQuiet(store: ProjectStore): void {
    const config = store.config();
    const nudge = config.scheduler.allQuietNudge;
    if (!nudge?.enabled) return;
    const agents = store.listAgents();
    if (agents.length === 0 || !agents.some((agent) => agent.id === nudge.targetAgent)) return;
    if (!agents.every((agent) => agent.status === "quiet")) return;
    if (store.hasPendingSignals()) return;
    const last = store.latestSignalCreatedAt({ kind: "scheduler.all_quiet_nudge", targetAgent: nudge.targetAgent });
    if (last && Date.now() - Date.parse(last) < nudge.cooldownMs) return;
    store.recordSignal({
      kind: "scheduler.all_quiet_nudge",
      targetAgent: nudge.targetAgent,
      priority: nudge.priority,
      payload: {
        message: nudge.message,
        reason: "all agents quiet and no pending signals",
        agentStatuses: agents.map((agent) => ({ id: agent.id, status: agent.status })),
      },
      usefulEffect: true,
    });
  }
}

export class NonPreemptiveMailboxScheduler extends NonPreemptiveSignalScheduler {}

function renderActivationPrompt(config: ProjectConfig, agent: AgentRecord, agents: AgentRecord[], signals: SignalRecord[], hasPreviousActivations: boolean): string {
  const isFirstActivation = !hasPreviousActivations;
  const mountedInputs = renderMountedInputs(config, agent);
  return [
    isFirstActivation ? renderBootstrapContext(config, agent, mountedInputs) : renderContinueContext(),
    isFirstActivation ? renderAgentRoster(agents) : undefined,
    isFirstActivation ? renderSharedArtifacts(agent, agents) : undefined,
    "# New Signals",
    ...signals.map(renderSignal),
    renderToolAndReportingContract(config, agent, agents),
    renderActivationRule(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderToolAndReportingContract(config: ProjectConfig, agent: AgentRecord, agents: AgentRecord[]): string {
  const communication = config.communication ?? { coordinatorAgent: "pm", restrictNonCoordinatorToCoordinator: false, nonCoordinatorMaxPriority: "P1", pmRoutineVerifierPriority: "P2" };
  const coordinator = communication.coordinatorAgent;
  const hasCoordinator = agents.some((item) => item.id === coordinator);
  const isCoordinator = agent.id === coordinator;
  const defaultRecipient = hasCoordinator ? `\`${coordinator}\`` : "the requested recipient, a configured channel, or `user`";
  const communicationRule = communication.restrictNonCoordinatorToCoordinator
    ? isCoordinator
      ? `Communication policy: you are the coordinator. You may message any project agent or \`user\`. For routine non-urgent verifier review/delegation, prefer \`${communication.pmRoutineVerifierPriority}\`; use \`P1\` when the review unblocks active work. Keep \`P0\` for true emergencies only.`
      : `Communication policy: only send direct messages to \`${coordinator}\`; do not message \`user\`, channels, verifier, scout, or other formalizers directly. Your allowed message priorities are \`${communication.nonCoordinatorMaxPriority}\` or lower; do not use \`P0\`.`
    : undefined;
  return [
    "# Tool And Reporting Contract",
    `Available tools for you: ${agent.tools.length ? agent.tools.join(", ") : "none"}.`,
    "New Signals are your current assignments. Use the newest direct assignment unless a higher-priority signal blocks it.",
    "Default message priority is `P2`. Use `P1` for work-unblocking assignments, review requests, candidate handoffs, and blocker reports. Use `P0` only for true interrupt-worthy emergencies: human stop, destructive repository conflict, secret/safety issue, or a blocker where continuing the current activation would be harmful.",
    communicationRule,
    "Use `file.read`, `file.write`, and `file.patch` for file inspection and edits when available. Use `shell.exec` for searches, git, Acorn verification, and commands that genuinely need a shell. Shell output and files are private until you report them.",
    "Use `/workspace` for mutable working files. Use `/artifacts/<agent-id>` for published handoff snapshots and do not modify an artifact snapshot after you announce it.",
    "Before ending every activation, create one externally visible effect with the appropriate tool.",
    "Do not send ACK-only messages such as 'received', 'noted', or 'standing by'. A successful `messages.send` call is already delivered; no confirmation reply is needed.",
    `If you completed work or hit a blocker, call \`messages.send\`. Use the requested recipient; if none is specified and you are not \`pm\`, send to ${defaultRecipient}.`,
    `If you are \`${coordinator}\` and you handled the signal by delegating work, call \`messages.send\` to the target agent or \`user\`.`,
    "If you already reported and are waiting, call `coordination.wait_for_signal` with `notifyPm:false`.",
    `Only \`${coordinator}\` should call \`completion.submit\`, and only for the final project report.`,
    hasCoordinator
      ? `If the task, recipient, or required tool is unclear, call \`messages.send\` with a blocker to \`${coordinator}\`, or to \`user\` if you are \`${coordinator}\`. Do not end silently.`
      : "If the task, recipient, or required tool is unclear, call `messages.send` with a blocker to the requested recipient, a configured channel, or `user`. Do not end silently.",
  ].join("\n");
}

function renderActivationRule(): string {
  return [
    "# Activation Rule",
    "Treat earlier model messages in this agent session as continuity only. New Signals are wake-up triggers and the only newly delivered items for this activation.",
    "Work until you have a useful result, blocker, message to send, wait-for-signal declaration, or final submission.",
    "If a signal asks you to report to a specific recipient, you must call `messages.send` to that recipient in this activation.",
    "Calling `coordination.wait_for_signal` or `completion.submit` ends this activation. Do not poll for more work; new signals will be delivered in a later activation.",
  ].join("\n\n");
}

function renderAgentRoster(agents: AgentRecord[]): string {
  return [
    "# Project Agents",
    "Use the ID exactly when sending a direct message to an agent.",
    ...agents.map((agent) => [`## ${agent.id}`, `Name: ${agent.displayName}`, `Role: ${agent.role}`].join("\n")),
  ].join("\n\n");
}

function renderSharedArtifacts(agent: AgentRecord, agents: AgentRecord[]): string {
  return [
    "# Shared Artifacts",
    "Use `/workspace` for mutable work across activations. Use these artifact paths for durable published snapshots. Your artifact directory is writable; other agent directories are read-only. Treat announced artifact subdirectories as immutable handoff records.",
    ...agents.map((item) => `- /artifacts/${item.id} (${item.id === agent.id ? "read-write, yours" : "read-only"})`),
  ].join("\n");
}

function renderBootstrapContext(config: ProjectConfig, agent: AgentRecord, mountedInputs: string | undefined): string {
  return [
    `# Project Task\n\n${config.task.trim()}`,
    `# Agent Identity\n\nID: ${agent.id}\nName: ${agent.displayName}\nRole: ${agent.role}`,
    agent.prompt.trim() ? `# Agent Instructions\n\n${agent.prompt.trim()}` : undefined,
    mountedInputs,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderContinueContext(): string {
  return "# Continue Existing Context\n\nContinue the same ongoing agent session. Do not restart the project, repeat static setup, or treat old messages as new requests.";
}

function renderSignal(signal: SignalRecord): string {
  if (signal.kind === "message.created") {
    const message = signal.payload as Record<string, unknown>;
    return [
      `## ${signal.id} message.created`,
      `Message: ${String(message.id ?? signal.id)}`,
      `From: ${String(message.sender ?? "unknown")}`,
      typeof message.recipient === "string" ? `To: ${message.recipient}` : `Channel: ${String(message.channel ?? signal.targetChannel ?? "")}`,
      `Priority: ${String(message.priority ?? signal.priority)}`,
      `Time: ${String(message.createdAt ?? signal.createdAt)}`,
      "",
      String(message.body ?? "").trim(),
    ].join("\n");
  }
  if (signal.kind === "scheduler.no_effect_nudge") {
    return [`## ${signal.id} scheduler.no_effect_nudge`, `Priority: ${signal.priority}`, "", String(signal.payload.message ?? "Your previous activation produced no externally visible effect. Before ending, call messages.send, coordination.wait_for_signal, or completion.submit as appropriate.")].join("\n");
  }
  if (signal.kind === "scheduler.all_quiet_nudge") {
    return [`## ${signal.id} scheduler.all_quiet_nudge`, `Priority: ${signal.priority}`, "", String(signal.payload.message ?? "All agents are quiet and no pending signals exist. Rehydrate work by sending targeted messages before waiting.")].join("\n");
  }
  return [`## ${signal.id} ${signal.kind}`, `Priority: ${signal.priority}`, `Time: ${signal.createdAt}`, "", JSON.stringify(signal.payload, null, 2)].join("\n");
}

function renderMountedInputs(config: ProjectConfig, agent: AgentRecord): string | undefined {
  const spec = agentSpec(config, agent);
  const mounts = [...(config.backend.docker?.mounts ?? []), ...(spec?.mounts ?? [])];
  if (mounts.length === 0) return undefined;
  return ["# Mounted Inputs", "These paths are read-only unless marked read-write. Copy inputs into /workspace before modifying them.", ...mounts.map((mount) => mountLine(mount))].join("\n");
}

function mountLine(mount: DockerMountConfig): string {
  const access = mount.readonly ? "read-only" : "read-write";
  return `- ${mount.target} (${access})${mount.description ? `: ${mount.description}` : ""}`;
}

function agentSpec(config: ProjectConfig, agent: AgentRecord): AgentConfig | undefined {
  return config.agents[agent.id] ?? config.agents[agent.id.replace(/-\d+$/, "")];
}

function signalsPerActivation(config: ProjectConfig): number {
  return config.scheduler.maxSignalsPerActivation ?? config.scheduler.maxPromptMessages ?? 20;
}
