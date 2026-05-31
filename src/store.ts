import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { createId, nowIso } from "./id.js";
import { agentPaths, ensureProjectDirs, projectPaths, suzumioRoot, type ProjectPaths } from "./paths.js";
import type { ActivationRecord, AgentRecord, JsonObject, MessagePriority, MessageRecord, ProjectConfig, ProjectStatus, RunnerActivationOutput, SignalRecord } from "./types.js";

export class ProjectStore {
  readonly paths: ProjectPaths;
  readonly db: DatabaseSync;

  constructor(readonly project: string, readonly root?: string) {
    this.paths = projectPaths(project, root);
    this.db = new DatabaseSync(this.paths.db);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.createSchema();
  }

  static async initialize(input: { config: ProjectConfig; sourceText: string; resolvedText: string; root?: string }): Promise<ProjectStore> {
    const p = await ensureProjectDirs(input.config.name, input.root);
    await writeFile(p.sourceConfig, input.sourceText, "utf8");
    await writeFile(p.resolvedConfig, input.resolvedText, "utf8");
    const store = new ProjectStore(input.config.name, input.root);
    const existing = store.db.prepare("SELECT id FROM projects WHERE id = ?").get(input.config.name);
    if (existing) throw new Error(`Project already initialized: ${input.config.name}`);
    const now = nowIso();
    store.db.prepare("INSERT INTO projects (id, name, status, task, config_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(input.config.name, input.config.name, "initialized", input.config.task, JSON.stringify(input.config), now, now);
    for (const agent of await expandAgents(input.config, input.root)) store.insertAgent(agent);
    store.appendEvent("project.initialized", { configPath: p.resolvedConfig });
    return store;
  }

  static async list(root?: string): Promise<string[]> {
    const base = suzumioRoot(root);
    const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
    const projects: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dbPath = projectPaths(entry.name, root).db;
      try {
        await stat(dbPath);
        projects.push(entry.name);
      } catch {
        // Not a Suzumio project.
      }
    }
    return projects.sort((a, b) => a.localeCompare(b));
  }

  close(): void {
    this.db.close();
  }

  config(): ProjectConfig {
    const row = this.db.prepare("SELECT config_json FROM projects WHERE id = ?").get(this.project) as { config_json: string } | undefined;
    if (!row) throw new Error(`Unknown project: ${this.project}`);
    return JSON.parse(row.config_json) as ProjectConfig;
  }

  projectRow(): Record<string, unknown> {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(this.project) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Unknown project: ${this.project}`);
    return row;
  }

  setProjectStatus(status: ProjectStatus): void {
    this.db.prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), this.project);
    this.appendEvent("project.status", { status });
  }

  listAgents(): AgentRecord[] {
    const rows = this.db.prepare("SELECT * FROM agents WHERE project = ? ORDER BY id").all(this.project) as DbAgent[];
    return rows.map(agentFromRow);
  }

  requireAgent(agentId: string): AgentRecord {
    const row = this.db.prepare("SELECT * FROM agents WHERE project = ? AND id = ?").get(this.project, agentId) as DbAgent | undefined;
    if (!row) throw new Error(`Unknown agent: ${agentId}`);
    return agentFromRow(row);
  }

  setAgentStatus(agentId: string, status: AgentRecord["status"], activeActivationId?: string | null, containerName?: string | null): void {
    this.db.prepare("UPDATE agents SET status = ?, active_activation_id = ?, container_name = COALESCE(?, container_name), updated_at = ? WHERE project = ? AND id = ?").run(status, activeActivationId ?? null, containerName ?? null, nowIso(), this.project, agentId);
    this.appendEvent("agent.status", { agentId, status, activeActivationId });
  }

  sendMessage(input: { sender: string; recipient?: string; channel?: string; priority?: MessagePriority; body: string; sourceAgent?: string; sourceActivation?: string }): MessageRecord {
    if (!input.recipient && !input.channel) throw new Error("Message needs recipient or channel");
    if (input.recipient && input.channel) throw new Error("Message cannot have both recipient and channel");
    if (input.recipient && input.recipient !== "user") this.requireAgent(input.recipient);
    if (input.channel && !this.config().channels.includes(input.channel)) throw new Error(`Unknown channel: ${input.channel}`);
    const priority = signalPriority(input.priority ?? "P2");
    const message: MessageRecord = {
      id: createId("msg"),
      project: this.project,
      sender: input.sender,
      recipient: input.recipient,
      channel: input.channel,
      priority,
      body: input.body,
      createdAt: nowIso(),
    };
    this.db.prepare("INSERT INTO messages (id, project, sender, recipient, channel, priority, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(message.id, message.project, message.sender, message.recipient ?? null, message.channel ?? null, message.priority, message.body, message.createdAt);
    this.appendEvent("message.created", message);
    this.recordSignal({ kind: "message.created", sourceAgent: input.sourceAgent, sourceActivation: input.sourceActivation, targetAgent: signalAgent(input.recipient), targetChannel: input.channel, priority: message.priority, payload: message as unknown as JsonObject });
    return message;
  }

  listMessages(limit = 100): MessageRecord[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE project = ? ORDER BY created_at DESC LIMIT ?").all(this.project, limit) as DbMessage[];
    return rows.reverse().map(messageFromRow);
  }

  agentMessageHistory(agentId: string, limit = 1000): MessageRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM messages
       WHERE project = ?
         AND (sender = ? OR recipient = ? OR channel IS NOT NULL)
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(this.project, agentId, agentId, limit) as DbMessage[];
    return rows.reverse().map(messageFromRow);
  }

  createActivation(agent: AgentRecord, prompt: string): ActivationRecord {
    const activationId = createId("act");
    const activationDir = path.join(this.paths.activations, activationId);
    const inputPath = path.join(activationDir, "input.json");
    const outputPath = path.join(activationDir, "result.json");
    const now = nowIso();
    this.db.prepare("INSERT INTO activations (id, project, agent_id, status, prompt, input_path, output_path, started_at, emitted_messages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(activationId, this.project, agent.id, "running", prompt, inputPath, outputPath, now, 0);
    this.setAgentStatus(agent.id, "running", activationId);
    this.appendEvent("activation.started", { activationId, agentId: agent.id });
    return { id: activationId, project: this.project, agentId: agent.id, status: "running", prompt, inputPath, outputPath, startedAt: now, emittedMessages: 0 };
  }

  setActivationContainer(activationId: string, containerName: string): void {
    this.db.prepare("UPDATE activations SET container_name = ? WHERE id = ? AND project = ?").run(containerName, activationId, this.project);
    const agentId = (this.db.prepare("SELECT agent_id FROM activations WHERE id = ? AND project = ?").get(activationId, this.project) as { agent_id: string }).agent_id;
    this.setAgentStatus(agentId, "running", activationId, containerName);
  }

  completeActivation(activationId: string, output: RunnerActivationOutput): void {
    const activation = this.activation(activationId);
    const emitted = this.countActivationMessages(activation.agentId, activation.startedAt);
    this.db.prepare("UPDATE activations SET status = ?, completed_at = ?, text = ?, usage_json = ?, emitted_messages = ? WHERE id = ? AND project = ?").run("completed", nowIso(), output.text, JSON.stringify(output.usage ?? {}), emitted, activationId, this.project);
    this.setAgentStatus(activation.agentId, "quiet", null);
    const usefulEffects = this.countActivationUsefulEffects(activationId);
    this.appendEvent("activation.completed", { activationId, agentId: activation.agentId, emittedMessages: emitted, usefulEffects });
    if (usefulEffects === 0 && !this.activationWasNoEffectNudge(activationId)) {
      this.recordSignal({
        kind: "scheduler.no_effect_nudge",
        targetAgent: activation.agentId,
        priority: "P1",
        payload: {
          previousActivationId: activationId,
          message: "Your previous activation produced no externally visible effect. Send a message, publish an artifact, submit completion, or report a blocker.",
        },
      });
    } else if (usefulEffects === 0) {
      this.notifyPmOfAgentIssue({
        agentId: activation.agentId,
        activationId,
        priority: "P1",
        title: "Agent produced no useful effect after a scheduler nudge",
        details: "The agent was already woken by scheduler.no_effect_nudge, but the activation still ended without messages, completion, wait-for-signal, or another useful signal. Please inspect the activation and either send a direct recovery instruction, reassign the work, or stop the agent.",
      });
    }
  }

  failActivation(activationId: string, error: string): void {
    const activation = this.activation(activationId);
    if (activation.status === "completed" || activation.status === "failed" || activation.status === "cancelled") return;
    this.db.prepare("UPDATE activations SET status = ?, completed_at = ?, error = ? WHERE id = ? AND project = ?").run("failed", nowIso(), error, activationId, this.project);
    this.setAgentStatus(activation.agentId, "failed", null);
    this.appendEvent("activation.failed", { activationId, agentId: activation.agentId, error });
    this.notifyPmOfAgentIssue({
      agentId: activation.agentId,
      activationId,
      priority: "P0",
      title: "Agent activation failed",
      details: truncate(error, 4000),
    });
  }

  activation(activationId: string): ActivationRecord {
    const row = this.db.prepare("SELECT * FROM activations WHERE id = ? AND project = ?").get(activationId, this.project) as DbActivation | undefined;
    if (!row) throw new Error(`Unknown activation: ${activationId}`);
    return activationFromRow(row);
  }

  listActivations(limit = 100): ActivationRecord[] {
    const rows = this.db.prepare("SELECT * FROM activations WHERE project = ? ORDER BY started_at DESC LIMIT ?").all(this.project, limit) as DbActivation[];
    return rows.reverse().map(activationFromRow);
  }

  agentActivationHistory(agentId: string, limit = 50): ActivationRecord[] {
    const rows = this.db.prepare("SELECT * FROM activations WHERE project = ? AND agent_id = ? ORDER BY started_at DESC LIMIT ?").all(this.project, agentId, limit) as DbActivation[];
    return rows.reverse().map(activationFromRow);
  }

  recordToolCall(input: { activationId: string; agentId: string; tool: string; input: unknown; status: "running" | "completed" | "failed"; output?: string; error?: string }): string {
    const id = createId("tool");
    const now = nowIso();
    this.db.prepare("INSERT INTO tool_calls (id, project, activation_id, agent_id, tool, input_json, status, output, error, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, this.project, input.activationId, input.agentId, input.tool, JSON.stringify(input.input ?? {}), input.status, input.output ?? null, input.error ?? null, now, input.status === "running" ? null : now);
    this.appendEvent("tool.called", { id, activationId: input.activationId, agentId: input.agentId, tool: input.tool, status: input.status });
    return id;
  }

  finishToolCall(id: string, status: "completed" | "failed", output?: string, error?: string): void {
    this.db.prepare("UPDATE tool_calls SET status = ?, output = ?, error = ?, completed_at = ? WHERE id = ? AND project = ?").run(status, output ?? null, error ?? null, nowIso(), id, this.project);
    this.appendEvent(status === "completed" ? "tool.completed" : "tool.failed", { id, output, error });
  }

  finishToolCallForActivation(id: string, agentId: string, activationId: string, status: "completed" | "failed", output?: string, error?: string): void {
    const row = this.db.prepare("SELECT id FROM tool_calls WHERE id = ? AND project = ? AND agent_id = ? AND activation_id = ?").get(id, this.project, agentId, activationId) as { id: string } | undefined;
    if (!row) throw new Error(`Unknown tool call for activation: ${id}`);
    this.finishToolCall(id, status, output, error);
  }

  listToolCalls(limit = 100): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM tool_calls WHERE project = ? ORDER BY created_at DESC LIMIT ?").all(this.project, limit) as Record<string, unknown>[];
  }

  recordSignal(input: { kind: string; sourceAgent?: string; sourceActivation?: string; targetAgent?: string; targetChannel?: string; priority?: MessagePriority; payload?: JsonObject; status?: "pending" | "closed"; usefulEffect?: boolean }): SignalRecord[] {
    const targets = this.signalTargets(input);
    const signals: SignalRecord[] = [];
    const createdAt = nowIso();
    const priority = signalPriority(input.priority ?? "P2");
    for (const target of targets) {
      const id = createId("sig");
      const status = signalStatus(input.status, target.targetAgent ? "pending" : "closed");
      const usefulEffect = input.usefulEffect ?? defaultUsefulEffect(input.kind, status);
      this.db.prepare("INSERT INTO signals (id, project, kind, source_agent, source_activation, target_agent, target_channel, priority, payload_json, status, useful_effect, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, this.project, input.kind, input.sourceAgent ?? null, input.sourceActivation ?? null, target.targetAgent ?? null, target.targetChannel ?? null, priority, JSON.stringify(input.payload ?? {}), status, usefulEffect ? 1 : 0, createdAt);
      const signal = { id, project: this.project, kind: input.kind, sourceAgent: input.sourceAgent, sourceActivation: input.sourceActivation, targetAgent: target.targetAgent, targetChannel: target.targetChannel, priority, payload: input.payload ?? {}, status, usefulEffect, createdAt } satisfies SignalRecord;
      signals.push(signal);
      this.appendEvent("signal.created", signal);
    }
    return signals;
  }

  pendingSignals(agentId: string, limit = 20): SignalRecord[] {
    const rows = this.db.prepare(
      `SELECT * FROM signals
       WHERE project = ? AND target_agent = ? AND status = 'pending'
       ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, created_at ASC
       LIMIT ?`,
    ).all(this.project, agentId, limit) as DbSignal[];
    return rows.map(signalFromRow);
  }

  markSignalsDelivered(agentId: string, signals: SignalRecord[], activationId: string): void {
    const stmt = this.db.prepare("UPDATE signals SET status = 'delivered', delivered_at = ?, delivered_activation_id = ? WHERE project = ? AND id = ? AND target_agent = ? AND status = 'pending'");
    const now = nowIso();
    for (const signal of signals) stmt.run(now, activationId, this.project, signal.id, agentId);
  }

  async submitProject(input: { agentId: string; report: string; activationId?: string }): Promise<string> {
    const reportPath = path.join(this.paths.root, "final-report.md");
    await writeFile(reportPath, input.report.trim() + "\n", "utf8");
    this.db.prepare("UPDATE projects SET status = ?, submitted_report = ?, updated_at = ? WHERE id = ?").run("submitted", reportPath, nowIso(), this.project);
    this.appendEvent("project.submitted", { agentId: input.agentId, reportPath });
    this.recordSignal({ kind: "completion.submitted", sourceAgent: input.agentId, sourceActivation: input.activationId, payload: { reportPath }, status: "closed", usefulEffect: true });
    return reportPath;
  }

  appendEvent(type: string, data: unknown): void {
    this.db.prepare("INSERT INTO events (id, project, type, data_json, created_at) VALUES (?, ?, ?, ?, ?)").run(createId("evt"), this.project, type, JSON.stringify(data ?? {}), nowIso());
  }

  listEvents(limit = 200): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM events WHERE project = ? ORDER BY created_at DESC LIMIT ?").all(this.project, limit) as Record<string, unknown>[];
  }

  private insertAgent(agent: AgentRecord): void {
    this.db.prepare("INSERT INTO agents (id, project, role, display_name, status, prompt, model, tools_json, workspace_path, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(agent.id, agent.project, agent.role, agent.displayName, agent.status, agent.prompt, agent.model ?? null, JSON.stringify(agent.tools), agent.workspacePath, agent.token, agent.createdAt, agent.updatedAt);
  }

  private countActivationMessages(agentId: string, startedAt: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE project = ? AND sender = ? AND created_at >= ?").get(this.project, agentId, startedAt) as { count: number };
    return row.count;
  }

  private countActivationUsefulEffects(activationId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM signals WHERE project = ? AND source_activation = ? AND useful_effect != 0").get(this.project, activationId) as { count: number };
    return row.count;
  }

  private activationWasNoEffectNudge(activationId: string): boolean {
    const row = this.db.prepare("SELECT id FROM signals WHERE project = ? AND delivered_activation_id = ? AND kind = 'scheduler.no_effect_nudge' LIMIT 1").get(this.project, activationId) as { id: string } | undefined;
    return row !== undefined;
  }

  private notifyPmOfAgentIssue(input: { agentId: string; activationId: string; priority: MessagePriority; title: string; details: string }): void {
    const body = [`${input.title}.`, "", `Agent: ${input.agentId}`, `Activation: ${input.activationId}`, "", input.details].join("\n");
    if (input.agentId === "pm") {
      this.sendMessage({ sender: "system", recipient: "user", priority: input.priority, sourceAgent: input.agentId, sourceActivation: input.activationId, body });
      return;
    }
    if (!this.listAgents().some((agent) => agent.id === "pm")) {
      this.sendMessage({ sender: "system", recipient: "user", priority: input.priority, sourceAgent: input.agentId, sourceActivation: input.activationId, body });
      return;
    }
    this.sendMessage({
      sender: "system",
      recipient: "pm",
      priority: input.priority,
      sourceAgent: input.agentId,
      sourceActivation: input.activationId,
      body,
    });
  }

  private signalTargets(input: { sourceAgent?: string; targetAgent?: string; targetChannel?: string }): Array<{ targetAgent?: string; targetChannel?: string }> {
    const targetAgent = signalAgent(input.targetAgent);
    if (targetAgent) {
      this.requireAgent(targetAgent);
      return [{ targetAgent }];
    }
    if (!input.targetChannel) return [{}];
    if (!this.config().channels.includes(input.targetChannel)) throw new Error(`Unknown channel: ${input.targetChannel}`);
    const agents = this.listAgents().filter((agent) => agent.id !== input.sourceAgent).map((agent) => ({ targetAgent: agent.id, targetChannel: input.targetChannel }));
    return agents.length ? agents : [{ targetChannel: input.targetChannel }];
  }

  private createSchema(): void {
    this.db.exec(SCHEMA);
    this.migrateActivationSchema();
  }

  private migrateActivationSchema(): void {
    this.addColumnIfMissing("agents", "active_activation_id", "TEXT");
    if (this.columnExists("agents", "active_turn_id")) this.db.exec("UPDATE agents SET active_activation_id = active_turn_id WHERE active_activation_id IS NULL AND active_turn_id IS NOT NULL");

    if (this.tableExists("turns")) {
      this.db.exec(`INSERT OR IGNORE INTO activations (id, project, agent_id, status, prompt, input_path, output_path, container_name, started_at, completed_at, text, error, emitted_messages, usage_json)
        SELECT id, project, agent_id, status, prompt, input_path, output_path, container_name, started_at, completed_at, text, error, emitted_messages, usage_json FROM turns`);
    }

    this.addColumnIfMissing("tool_calls", "activation_id", "TEXT");
    if (this.columnExists("tool_calls", "turn_id")) this.db.exec("UPDATE tool_calls SET activation_id = turn_id WHERE activation_id IS NULL AND turn_id IS NOT NULL");

    this.addColumnIfMissing("signals", "source_activation", "TEXT");
    if (this.columnExists("signals", "source_turn")) this.db.exec("UPDATE signals SET source_activation = source_turn WHERE source_activation IS NULL AND source_turn IS NOT NULL");
    this.addColumnIfMissing("signals", "delivered_activation_id", "TEXT");
    if (this.columnExists("signals", "delivered_turn_id")) this.db.exec("UPDATE signals SET delivered_activation_id = delivered_turn_id WHERE delivered_activation_id IS NULL AND delivered_turn_id IS NOT NULL");

  }

  private tableExists(table: string): boolean {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { name: string } | undefined;
    return row !== undefined;
  }

  private columnExists(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === column);
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    if (!this.tableExists(table) || this.columnExists(table, column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export async function sourceAndResolvedText(sourcePath: string, resolved: unknown): Promise<{ sourceText: string; resolvedText: string }> {
  return { sourceText: await readFile(sourcePath, "utf8"), resolvedText: YAML.stringify(resolved, { lineWidth: 120 }) };
}

async function expandAgents(config: ProjectConfig, root?: string): Promise<AgentRecord[]> {
  const records: AgentRecord[] = [];
  for (const [baseId, spec] of Object.entries(config.agents)) {
    const count = spec.count ?? 1;
    for (let index = 1; index <= count; index += 1) {
      const id = count === 1 ? baseId : `${baseId}-${index}`;
      const paths = agentPaths(config.name, id, root);
      const artifacts = path.join(projectPaths(config.name, root).artifacts, id);
      await mkdir(paths.workspace, { recursive: true });
      await mkdir(artifacts, { recursive: true });
      const now = nowIso();
      records.push({
        id,
        project: config.name,
        role: spec.role ?? baseId,
        displayName: displayName(spec, id, index),
        status: "quiet",
        prompt: spec.prompt ?? "",
        model: spec.model,
        tools: spec.tools ?? [],
        workspacePath: paths.workspace,
        token: randomBytes(24).toString("base64url"),
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  return records;
}

function displayName(spec: { displayName?: string; names?: string[] }, id: string, index: number): string {
  return spec.names?.[index - 1] ?? spec.displayName ?? id;
}

type DbAgent = {
  id: string;
  project: string;
  role: string;
  display_name: string;
  status: AgentRecord["status"];
  prompt: string;
  model: string | null;
  tools_json: string;
  workspace_path: string;
  token: string;
  active_activation_id: string | null;
  container_name: string | null;
  created_at: string;
  updated_at: string;
};

function agentFromRow(row: DbAgent): AgentRecord {
  return { id: row.id, project: row.project, role: row.role, displayName: row.display_name, status: row.status, prompt: row.prompt, model: row.model ?? undefined, tools: JSON.parse(row.tools_json) as string[], workspacePath: row.workspace_path, token: row.token, activeActivationId: row.active_activation_id ?? undefined, containerName: row.container_name ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
}

type DbMessage = { id: string; project: string; sender: string; recipient: string | null; channel: string | null; priority: MessagePriority; body: string; created_at: string };

function messageFromRow(row: DbMessage): MessageRecord {
  return { id: row.id, project: row.project, sender: row.sender, recipient: row.recipient ?? undefined, channel: row.channel ?? undefined, priority: row.priority, body: row.body, createdAt: row.created_at };
}

type DbActivation = { id: string; project: string; agent_id: string; status: ActivationRecord["status"]; prompt: string; input_path: string; output_path: string; container_name: string | null; started_at: string; completed_at: string | null; text: string | null; error: string | null; emitted_messages: number; usage_json: string | null };

function activationFromRow(row: DbActivation): ActivationRecord {
  return { id: row.id, project: row.project, agentId: row.agent_id, status: row.status, prompt: row.prompt, inputPath: row.input_path, outputPath: row.output_path, containerName: row.container_name ?? undefined, startedAt: row.started_at, completedAt: row.completed_at ?? undefined, text: row.text ?? undefined, error: row.error ?? undefined, emittedMessages: row.emitted_messages, usageJson: row.usage_json ?? undefined };
}

type DbSignal = { id: string; project: string; kind: string; source_agent: string | null; source_activation: string | null; target_agent: string | null; target_channel: string | null; priority: MessagePriority; payload_json: string; status: SignalRecord["status"]; useful_effect: number; created_at: string; delivered_at: string | null; delivered_activation_id: string | null };

function signalFromRow(row: DbSignal): SignalRecord {
  return { id: row.id, project: row.project, kind: row.kind, sourceAgent: row.source_agent ?? undefined, sourceActivation: row.source_activation ?? undefined, targetAgent: row.target_agent ?? undefined, targetChannel: row.target_channel ?? undefined, priority: row.priority, payload: JSON.parse(row.payload_json) as JsonObject, status: row.status, usefulEffect: row.useful_effect !== 0, createdAt: row.created_at, deliveredAt: row.delivered_at ?? undefined, deliveredActivationId: row.delivered_activation_id ?? undefined };
}

function signalAgent(value: string | undefined): string | undefined {
  return value === "user" ? undefined : value;
}

function signalPriority(value: unknown): MessagePriority {
  if (value === "P0" || value === "P1" || value === "P2" || value === "P3") return value;
  throw new Error(`Invalid priority: ${String(value)}`);
}

function signalStatus(value: unknown, fallback: SignalRecord["status"]): SignalRecord["status"] {
  if (value === undefined) return fallback;
  if (value === "closed") {
    if (fallback === "pending") throw new Error("Targeted signals cannot be closed; omit the target or omit status");
    return "closed";
  }
  if (value === "pending") return fallback === "closed" ? "closed" : "pending";
  throw new Error(`Invalid signal status: ${String(value)}`);
}

function defaultUsefulEffect(kind: string, status: SignalRecord["status"]): boolean {
  if (kind === "scheduler.no_effect_nudge") return false;
  if (status === "pending") return true;
  return kind === "message.created" || kind === "completion.submitted" || kind === "coordination.wait_for_signal";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}\n...[truncated]`;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  task TEXT NOT NULL,
  config_json TEXT NOT NULL,
  submitted_report TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT NOT NULL,
  project TEXT NOT NULL,
  role TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model TEXT,
  tools_json TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  token TEXT NOT NULL,
  active_activation_id TEXT,
  container_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project, id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT,
  channel TEXT,
  priority TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activations (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt TEXT NOT NULL,
  input_path TEXT NOT NULL,
  output_path TEXT NOT NULL,
  container_name TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  text TEXT,
  error TEXT,
  emitted_messages INTEGER NOT NULL DEFAULT 0,
  usage_json TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  type TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  output TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_agent TEXT,
  source_activation TEXT,
  target_agent TEXT,
  target_channel TEXT,
  priority TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  useful_effect INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  delivered_activation_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project, created_at);
CREATE INDEX IF NOT EXISTS idx_events_project_created ON events(project, created_at);
CREATE INDEX IF NOT EXISTS idx_activations_project_started ON activations(project, started_at);
CREATE INDEX IF NOT EXISTS idx_signals_project_target ON signals(project, target_agent, status, created_at);
CREATE INDEX IF NOT EXISTS idx_signals_project_source ON signals(project, source_activation, useful_effect);
`;
