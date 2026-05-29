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
      for (const agent of store.listAgents()) await this.tickAgent(store, agent);
    } finally {
      store.close();
    }
  }

  async tickAll(): Promise<void> {
    for (const project of await ProjectStore.list(this.root)) await this.tickProject(project);
  }

  private async tickAgent(store: ProjectStore, agent: AgentRecord): Promise<void> {
    if (agent.status === "running" || agent.status === "stopped") return;
    const config = store.config();
    const signals = store.pendingSignals(agent.id, config.scheduler.maxPromptMessages);
    if (signals.length === 0) {
      if (agent.status !== "quiet" && agent.status !== "failed") store.setAgentStatus(agent.id, "quiet", null);
      return;
    }
    const prompt = renderTurnPrompt(config, agent, signals);
    const turn = store.createTurn(agent, prompt);
    store.markSignalsDelivered(agent.id, signals, turn.id);
    await this.backend.startTurn(store, agent, turn, prompt);
  }
}

export class NonPreemptiveMailboxScheduler extends NonPreemptiveSignalScheduler {}

function renderTurnPrompt(config: ProjectConfig, agent: AgentRecord, signals: SignalRecord[]): string {
  const mountedInputs = renderMountedInputs(config, agent);
  return [
    `# Project Task\n\n${config.task.trim()}`,
    `# Agent Identity\n\nID: ${agent.id}\nName: ${agent.displayName}\nRole: ${agent.role}`,
    agent.prompt.trim() ? `# Agent Instructions\n\n${agent.prompt.trim()}` : undefined,
    mountedInputs,
    "# New Signals",
    ...signals.map(renderSignal),
    "# Turn Rule\n\nWork until you have a useful result, blocker, message to send, no-valuable-work declaration, or final submission. If you publish an artifact, also notify the relevant agent or user. Do not poll for more work; new signals will be delivered in a later turn.",
  ]
    .filter(Boolean)
    .join("\n\n");
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
    return [`## ${signal.id} scheduler.no_effect_nudge`, `Priority: ${signal.priority}`, "", String(signal.payload.message ?? "Your previous turn produced no externally visible effect.")].join("\n");
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
