import type { ActivationRecord, AgentConfig, AgentRecord, DockerMountConfig, MessageRecord, ProjectConfig, SignalRecord } from "./types.js";
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
    } finally {
      store.close();
    }
  }

  async tickAll(): Promise<void> {
    for (const project of await ProjectStore.list(this.root)) await this.tickProject(project);
  }

  private async tickAgent(store: ProjectStore, agent: AgentRecord, agents: AgentRecord[]): Promise<void> {
    if (agent.status === "running" || agent.status === "stopped" || agent.activeActivationId) return;
    const config = store.config();
    const signals = store.pendingSignals(agent.id, config.scheduler.maxPromptMessages);
    if (signals.length === 0) {
      if (agent.status !== "quiet" && agent.status !== "failed") store.setAgentStatus(agent.id, "quiet", null);
      return;
    }
    const messages = store.agentMessageHistory(agent.id);
    const activations = store.agentActivationHistory(agent.id);
    const prompt = renderActivationPrompt(config, agent, agents, signals, messages, activations);
    const activation = store.createActivation(agent, prompt);
    store.markSignalsDelivered(agent.id, signals, activation.id);
    await this.backend.startActivation(store, agent, activation, prompt);
  }
}

export class NonPreemptiveMailboxScheduler extends NonPreemptiveSignalScheduler {}

function renderActivationPrompt(config: ProjectConfig, agent: AgentRecord, agents: AgentRecord[], signals: SignalRecord[], messages: MessageRecord[], activations: ActivationRecord[]): string {
  const isFirstActivation = activations.length === 0;
  const mountedInputs = renderMountedInputs(config, agent);
  return [
    isFirstActivation ? renderBootstrapContext(config, agent, mountedInputs) : renderContinueContext(),
    renderAgentRoster(agents),
    renderSharedArtifacts(agent, agents),
    renderConversationHistory(messages),
    renderActivationHistory(activations),
    "# New Signals",
    ...signals.map(renderSignal),
    "# Activation Rule\n\nTreat the conversation history and your previous activation outputs as your continuous working context. New Signals are the current wake-up triggers, not the whole context. Work until you have a useful result, blocker, message to send, wait-for-signal declaration, or final submission. If you are waiting for replies you requested, call coordination.wait_for_signal rather than continuing by assumption. Use the Project Agents roster as current status: an agent that is running on work you requested has not necessarily finished, so wait unless that work is explicitly irrelevant or superseded. Calling coordination.wait_for_signal or completion.submit ends this activation. If you write a shared artifact, also notify the relevant agent or user. Do not poll for more work; new signals will be delivered in a later activation.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderAgentRoster(agents: AgentRecord[]): string {
  return [
    "# Project Agents",
    "Use the ID exactly when sending a direct message to an agent.",
    ...agents.map((agent) => [`## ${agent.id}`, `Name: ${agent.displayName}`, `Role: ${agent.role}`, `Status: ${agent.status}`].join("\n")),
  ].join("\n\n");
}

function renderSharedArtifacts(agent: AgentRecord, agents: AgentRecord[]): string {
  return [
    "# Shared Artifacts",
    "Use these filesystem paths for durable files. Your directory is writable; other agent directories are read-only. Use shell commands to organize, filter, or summarize files as needed.",
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

function renderConversationHistory(messages: MessageRecord[]): string | undefined {
  if (messages.length === 0) return undefined;
  return ["# Conversation History", "Visible project messages so far. Use this as continuity from earlier activations; do not treat every old message as a new request.", ...messages.map(renderHistoryMessage)].join("\n\n");
}

function renderHistoryMessage(message: MessageRecord): string {
  return [
    `## ${message.id}`,
    `Time: ${message.createdAt}`,
    `From: ${message.sender}`,
    message.recipient ? `To: ${message.recipient}` : `Channel: ${message.channel}`,
    `Priority: ${message.priority}`,
    "",
    message.body.trim(),
  ].join("\n");
}

function renderActivationHistory(activations: ActivationRecord[]): string | undefined {
  const completed = activations.filter((activation) => activation.text || activation.error);
  if (completed.length === 0) return undefined;
  return ["# Your Previous Activation Outputs", "Your own prior activation results. Use them as persistent memory for your role.", ...completed.map(renderHistoryActivation)].join("\n\n");
}

function renderHistoryActivation(activation: ActivationRecord): string {
  return [`## ${activation.id}`, `Status: ${activation.status}`, `Started: ${activation.startedAt}`, activation.completedAt ? `Completed: ${activation.completedAt}` : undefined, "", activation.text ?? activation.error ?? ""].filter(Boolean).join("\n");
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
    return [`## ${signal.id} scheduler.no_effect_nudge`, `Priority: ${signal.priority}`, "", String(signal.payload.message ?? "Your previous activation produced no externally visible effect.")].join("\n");
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
