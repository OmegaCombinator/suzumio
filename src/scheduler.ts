import type { AgentConfig, AgentRecord, DockerMountConfig, MessageRecord, ProjectConfig } from "./types.js";
import { DockerChatBackend } from "./backend.js";
import { ProjectStore } from "./store.js";

export class NonPreemptiveMailboxScheduler {
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
    const unread = store.unreadMessages(agent.id);
    if (unread.length === 0) {
      if (agent.status !== "quiet" && agent.status !== "failed") store.setAgentStatus(agent.id, "quiet", null);
      return;
    }
    const config = store.config();
    const selected = unread.slice(0, config.scheduler.maxPromptMessages);
    const prompt = renderTurnPrompt(config, agent, selected);
    const turn = store.createTurn(agent, prompt);
    store.markRead(agent.id, selected, turn.id);
    await this.backend.startTurn(store, agent, turn, prompt);
  }
}

function renderTurnPrompt(config: ProjectConfig, agent: AgentRecord, messages: MessageRecord[]): string {
  const mountedInputs = renderMountedInputs(config, agent);
  return [
    `# Project Task\n\n${config.task.trim()}`,
    agent.prompt.trim() ? `# Agent Instructions\n\n${agent.prompt.trim()}` : undefined,
    mountedInputs,
    "# New Inbound Messages",
    ...messages.map((message) => [`## ${message.id}`, `From: ${message.sender}`, message.recipient ? `To: ${message.recipient}` : `Channel: ${message.channel}`, `Priority: ${message.priority}`, `Time: ${message.createdAt}`, "", message.body.trim()].join("\n")),
    "# Turn Rule\n\nWork until you have a useful result, blocker, artifact, message to send, or final submission. Do not poll for more messages; new messages will be delivered in a later turn.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function renderMountedInputs(config: ProjectConfig, agent: AgentRecord): string | undefined {
  const spec = agentSpec(config, agent);
  const mounts = [...(config.backend.docker?.mounts ?? []), ...(spec?.mounts ?? [])];
  if (mounts.length === 0) return undefined;
  return ["# Mounted Inputs", ...mounts.map((mount) => mountLine(mount))].join("\n");
}

function mountLine(mount: DockerMountConfig): string {
  const access = mount.readonly ? "read-only" : "read-write";
  return `- ${mount.target} (${access})${mount.description ? `: ${mount.description}` : ""}`;
}

function agentSpec(config: ProjectConfig, agent: AgentRecord): AgentConfig | undefined {
  return config.agents[agent.id] ?? config.agents[agent.id.replace(/-\d+$/, "")];
}
