import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { createId, nowIso } from "./id.js";
import { agentPaths, ensureProjectDirs, projectPaths, suzumioRoot, type ProjectPaths } from "./paths.js";
import type { ActivationContextSnapshot, ActivationRecord, AgentHistoryCompaction, AgentHistoryMessage, AgentHistoryPage, AgentHistoryPart, AgentHistoryPartType, AgentHistoryRole, AgentRecord, JsonObject, MessagePriority, MessageRecord, NoEffectNudgeConfig, ProjectConfig, ProjectStatus, RunnerActivationOutput, SignalRecord } from "./types.js";

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

  message(messageId: string): MessageRecord {
    const row = this.db.prepare("SELECT * FROM messages WHERE project = ? AND id = ?").get(this.project, messageId) as DbMessage | undefined;
    if (!row) throw new Error(`Unknown message: ${messageId}`);
    return messageFromRow(row);
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
    const noEffectNudge = this.config().scheduler.noEffectNudge ?? defaultNoEffectNudgeConfig();
    const previousNoEffectNudgeAttempt = this.deliveredNoEffectNudgeAttempt(activationId);
    const maxConsecutive = noEffectNudge.maxConsecutive ?? 0;
    const canNudge = maxConsecutive === 0 || previousNoEffectNudgeAttempt < maxConsecutive;
    if (usefulEffects === 0 && noEffectNudge.enabled && canNudge) {
      const attempt = previousNoEffectNudgeAttempt + 1;
      const delayMs = noEffectNudgeDelayMs(noEffectNudge, attempt);
      const notBefore = delayMs === 0 ? undefined : new Date(Date.now() + delayMs).toISOString();
      this.recordSignal({
        kind: "scheduler.no_effect_nudge",
        targetAgent: activation.agentId,
        priority: noEffectNudge.priority,
        notBefore,
        payload: {
          previousActivationId: activationId,
          attempt,
          maxConsecutive,
          delayMs,
          notBefore,
          message: activation.agentId === "pm"
            ? "Your previous activation produced no externally visible effect. Before ending this activation, use messages.send to delegate work or report a blocker to user, coordination.wait_for_signal after reporting, or completion.submit for a final report. Do not only run shell commands."
            : "Your previous activation produced no externally visible effect. Before ending this activation, use messages.send to report results, artifact paths, or a blocker to the requested recipient or coordinator, or use coordination.wait_for_signal after reporting. Do not only run shell commands.",
        },
      });
    }
  }

  cancelActivation(activationId: string, reason: string): void {
    const activation = this.activation(activationId);
    if (activation.status === "completed" || activation.status === "failed" || activation.status === "cancelled") return;
    this.db.prepare("UPDATE activations SET status = ?, completed_at = ?, error = ? WHERE id = ? AND project = ?").run("cancelled", nowIso(), reason, activationId, this.project);
    this.setAgentStatus(activation.agentId, "quiet", null);
    this.appendAgentHistoryMessage({
      agentId: activation.agentId,
      activationId,
      role: "assistant",
      kind: "activation_cancelled",
      content: `Activation ${activationId} was interrupted and cancelled. Reason: ${reason}`,
      metadata: { reason },
    });
    this.appendEvent("activation.cancelled", { activationId, agentId: activation.agentId, reason });
  }

  setActivationContext(activationId: string, context: ActivationContextSnapshot): void {
    const activation = this.activation(activationId);
    this.db.prepare("UPDATE activations SET context_json = ? WHERE id = ? AND project = ?").run(JSON.stringify(context), activationId, this.project);
    this.appendEvent("activation.context_recorded", { activationId, agentId: activation.agentId, messageCount: context.messageCount, totalChars: context.totalChars });
  }

  failActivation(activationId: string, error: string): void {
    const activation = this.activation(activationId);
    if (activation.status === "completed" || activation.status === "failed" || activation.status === "cancelled") return;
    this.db.prepare("UPDATE activations SET status = ?, completed_at = ?, error = ? WHERE id = ? AND project = ?").run("failed", nowIso(), error, activationId, this.project);
    this.setAgentStatus(activation.agentId, "failed", null);
    this.appendAgentHistoryMessage({
      agentId: activation.agentId,
      activationId,
      role: "assistant",
      kind: "activation_failed",
      content: `Activation ${activationId} failed.\n\n${error}`,
      metadata: { error },
    });
    this.appendEvent("activation.failed", { activationId, agentId: activation.agentId, error });
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
    this.appendAgentHistoryMessage({
      agentId: input.agentId,
      activationId: input.activationId,
      role: "tool_call",
      kind: "tool_call",
      content: renderToolCallContent(input.tool, input.input),
      metadata: { toolCallId: id, tool: input.tool, status: input.status },
      parts: [{ type: "tool_call", toolCallId: id, toolName: input.tool, inputJson: JSON.stringify(input.input ?? {}) }],
    });
    return id;
  }

  finishToolCall(id: string, status: "completed" | "failed", output?: string, error?: string): void {
    const call = this.db.prepare("SELECT * FROM tool_calls WHERE id = ? AND project = ?").get(id, this.project) as DbToolCall | undefined;
    if (!call) throw new Error(`Unknown tool call: ${id}`);
    this.db.prepare("UPDATE tool_calls SET status = ?, output = ?, error = ?, completed_at = ? WHERE id = ? AND project = ?").run(status, output ?? null, error ?? null, nowIso(), id, this.project);
    this.appendEvent(status === "completed" ? "tool.completed" : "tool.failed", { id, output, error });
    this.appendAgentHistoryMessage({
      agentId: call.agent_id,
      activationId: call.activation_id,
      role: "tool_result",
      kind: status === "completed" ? "tool_result" : "tool_error",
      content: renderToolResultContent(call.tool, status, output, error),
      metadata: { toolCallId: id, tool: call.tool, status },
      parts: [{ type: "tool_result", toolCallId: id, toolName: call.tool, output, error }],
    });
  }

  finishToolCallForActivation(id: string, agentId: string, activationId: string, status: "completed" | "failed", output?: string, error?: string): void {
    const row = this.db.prepare("SELECT id FROM tool_calls WHERE id = ? AND project = ? AND agent_id = ? AND activation_id = ?").get(id, this.project, agentId, activationId) as { id: string } | undefined;
    if (!row) throw new Error(`Unknown tool call for activation: ${id}`);
    this.finishToolCall(id, status, output, error);
  }

  listToolCalls(limit = 100): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM tool_calls WHERE project = ? ORDER BY created_at DESC LIMIT ?").all(this.project, limit) as Record<string, unknown>[];
  }

  appendAgentHistoryMessage(input: { agentId: string; activationId?: string; role: AgentHistoryRole; kind: string; content: string; metadata?: JsonObject; parts?: AgentHistoryPartInput[] }): AgentHistoryMessage {
    this.requireAgent(input.agentId);
    const id = createId("hist");
    const createdAt = nowIso();
    const sequence = this.nextAgentHistorySequence(input.agentId);
    const metadata = input.metadata ?? {};
    this.db.prepare("INSERT INTO agent_history_messages (id, project, agent_id, activation_id, role, kind, content, sequence, metadata_json, compaction_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, this.project, input.agentId, input.activationId ?? null, input.role, input.kind, input.content, sequence, JSON.stringify(metadata), null, createdAt);
    const parts = (input.parts?.length ? input.parts : [{ type: textPartType(input.role), text: input.content }]).map((part, index) => this.insertAgentHistoryPart(input.agentId, id, input.activationId, index, part, createdAt));
    this.appendEvent("agent_history.message", { id, agentId: input.agentId, activationId: input.activationId, role: input.role, kind: input.kind, chars: input.content.length });
    return { id, project: this.project, agentId: input.agentId, activationId: input.activationId, role: input.role, kind: input.kind, content: input.content, sequence, archived: false, metadata, parts, createdAt };
  }

  activeAgentHistory(agentId: string): AgentHistoryMessage[] {
    this.requireAgent(agentId);
    const rows = this.db.prepare(
      `SELECT * FROM agent_history_messages
       WHERE project = ? AND agent_id = ? AND compaction_id IS NULL
       ORDER BY CASE role WHEN 'compaction' THEN 0 ELSE 1 END, sequence ASC`,
    ).all(this.project, agentId) as DbAgentHistoryMessage[];
    return this.historyMessagesFromRows(rows);
  }

  listAgentHistory(agentId: string, input: { limit?: number; beforeSequence?: number; includeArchived?: boolean } = {}): AgentHistoryPage {
    this.requireAgent(agentId);
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)));
    const params: Array<string | number> = [this.project, agentId];
    const filters = ["project = ?", "agent_id = ?"];
    if (!input.includeArchived) filters.push("compaction_id IS NULL");
    if (input.beforeSequence !== undefined) {
      filters.push("sequence < ?");
      params.push(input.beforeSequence);
    }
    params.push(limit);
    const rows = this.db.prepare(`SELECT * FROM agent_history_messages WHERE ${filters.join(" AND ")} ORDER BY sequence DESC LIMIT ?`).all(...params) as DbAgentHistoryMessage[];
    const messages = this.historyMessagesFromRows(rows);
    return { agentId, messages, nextBefore: messages.length === limit ? messages[messages.length - 1]?.sequence : undefined };
  }

  historyCompaction(compactionId: string): AgentHistoryCompaction {
    const row = this.db.prepare("SELECT * FROM agent_history_compactions WHERE project = ? AND id = ?").get(this.project, compactionId) as DbAgentHistoryCompaction | undefined;
    if (!row) throw new Error(`Unknown history compaction: ${compactionId}`);
    return compactionFromRow(row);
  }

  async historyArchive(compactionId: string): Promise<{ compaction: AgentHistoryCompaction; archive: unknown }> {
    const compaction = this.historyCompaction(compactionId);
    const archive = JSON.parse(await readFile(compaction.archivePath, "utf8")) as unknown;
    return { compaction, archive };
  }

  async compactAgentHistory(input: { agentId: string; activationId?: string; summary: string; keepTail?: number; reason?: string; selectedModel?: string }): Promise<{ compaction?: AgentHistoryCompaction; history: AgentHistoryMessage[] }> {
    const active = this.activeAgentHistory(input.agentId);
    const keepTail = Math.max(1, Math.min(100, Math.floor(input.keepTail ?? 12)));
    const head = active.slice(0, Math.max(0, active.length - keepTail));
    if (head.length === 0) return { history: active };

    const compactionId = createId("cmp");
    const archiveDir = path.join(this.paths.root, "history", input.agentId);
    await mkdir(archiveDir, { recursive: true });
    const archivePath = path.join(archiveDir, `${compactionId}.json`);
    const archive = {
      version: 1,
      compactionId,
      project: this.project,
      agentId: input.agentId,
      activationId: input.activationId,
      reason: input.reason,
      selectedModel: input.selectedModel,
      createdAt: nowIso(),
      messages: head,
    };
    const archiveText = JSON.stringify(archive, null, 2) + "\n";
    await writeFile(archivePath, archiveText, "utf8");

    const sequences = head.map((message) => message.sequence);
    const startSequence = Math.min(...sequences);
    const endSequence = Math.max(...sequences);
    const summary = input.summary.trim() || "Older agent history was compacted; no summary text was produced.";
    const summaryMessage = this.appendAgentHistoryMessage({
      agentId: input.agentId,
      activationId: input.activationId,
      role: "compaction",
      kind: "history_compaction",
      content: summary,
      metadata: { compactionId, archivePath, archivedMessageCount: head.length, startSequence, endSequence, reason: input.reason, selectedModel: input.selectedModel },
      parts: [{ type: "compaction", text: summary, metadata: { compactionId, archivePath } }],
    });
    const stmt = this.db.prepare("UPDATE agent_history_messages SET compaction_id = ? WHERE project = ? AND id = ?");
    for (const message of head) stmt.run(compactionId, this.project, message.id);
    const createdAt = nowIso();
    this.db.prepare("INSERT INTO agent_history_compactions (id, project, agent_id, activation_id, summary_message_id, archive_path, start_sequence, end_sequence, archived_message_count, raw_chars, summary, reason, selected_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(compactionId, this.project, input.agentId, input.activationId ?? null, summaryMessage.id, archivePath, startSequence, endSequence, head.length, archiveText.length, summary, input.reason ?? null, input.selectedModel ?? null, createdAt);
    const compaction: AgentHistoryCompaction = { id: compactionId, project: this.project, agentId: input.agentId, activationId: input.activationId, summaryMessageId: summaryMessage.id, archivePath, startSequence, endSequence, archivedMessageCount: head.length, rawChars: archiveText.length, summary, reason: input.reason, selectedModel: input.selectedModel, createdAt };
    this.appendEvent("agent_history.compacted", { compactionId, agentId: input.agentId, activationId: input.activationId, archivedMessageCount: head.length, rawChars: archiveText.length });
    return { compaction, history: this.activeAgentHistory(input.agentId) };
  }

  deliverToolBoundarySignals(agentId: string, activationId: string, limit = 20): { signals: SignalRecord[]; content?: string } {
    const rows = this.db.prepare(
      `SELECT * FROM signals
       WHERE project = ? AND target_agent = ? AND status = 'pending' AND priority = 'P1'
       ORDER BY created_at ASC
       LIMIT ?`,
    ).all(this.project, agentId, Math.max(1, Math.min(100, limit))) as DbSignal[];
    const signals = rows.map(signalFromRow);
    if (signals.length === 0) return { signals };
    const content = [
      "# New P1 Signals Delivered At Tool Boundary",
      "These signals arrived while this activation was running. Treat them as newly delivered instructions after the tool result above.",
      ...signals.map(renderSignalForHistory),
    ].join("\n\n");
    this.markSignalsDelivered(agentId, signals, activationId);
    this.appendAgentHistoryMessage({
      agentId,
      activationId,
      role: "user",
      kind: "tool_boundary_signals",
      content,
      metadata: { delivery: "tool_boundary", signalIds: signals.map((signal) => signal.id) },
    });
    return { signals, content };
  }

  projectStats(): Record<string, number> {
    const messageCount = countRows(this.db, "messages", this.project);
    const activationCount = countRows(this.db, "activations", this.project);
    const failedActivationCount = countRows(this.db, "activations", this.project, "status = 'failed'");
    const runningActivationCount = countRows(this.db, "activations", this.project, "status = 'running'");
    const toolCallCount = countRows(this.db, "tool_calls", this.project);
    const historyMessageCount = countRows(this.db, "agent_history_messages", this.project);
    const historyCompactionCount = countRows(this.db, "agent_history_compactions", this.project);
    const eventCount = countRows(this.db, "events", this.project);
    return { messageCount, activationCount, failedActivationCount, runningActivationCount, toolCallCount, historyMessageCount, historyCompactionCount, eventCount };
  }

  recordSignal(input: { kind: string; sourceAgent?: string; sourceActivation?: string; targetAgent?: string; targetChannel?: string; priority?: MessagePriority; payload?: JsonObject; status?: "pending" | "closed"; usefulEffect?: boolean; notBefore?: string }): SignalRecord[] {
    const targets = this.signalTargets(input);
    const signals: SignalRecord[] = [];
    const createdAt = nowIso();
    const notBefore = input.notBefore ?? createdAt;
    const priority = signalPriority(input.priority ?? "P2");
    for (const target of targets) {
      const id = createId("sig");
      const status = signalStatus(input.status, target.targetAgent ? "pending" : "closed");
      const usefulEffect = input.usefulEffect ?? defaultUsefulEffect(input.kind, status);
      this.db.prepare("INSERT INTO signals (id, project, kind, source_agent, source_activation, target_agent, target_channel, priority, payload_json, status, useful_effect, created_at, not_before) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, this.project, input.kind, input.sourceAgent ?? null, input.sourceActivation ?? null, target.targetAgent ?? null, target.targetChannel ?? null, priority, JSON.stringify(input.payload ?? {}), status, usefulEffect ? 1 : 0, createdAt, notBefore);
      const signal = { id, project: this.project, kind: input.kind, sourceAgent: input.sourceAgent, sourceActivation: input.sourceActivation, targetAgent: target.targetAgent, targetChannel: target.targetChannel, priority, payload: input.payload ?? {}, status, usefulEffect, createdAt, notBefore: notBefore === createdAt ? undefined : notBefore } satisfies SignalRecord;
      signals.push(signal);
      this.appendEvent("signal.created", signal);
    }
    return signals;
  }

  pendingSignals(agentId: string, limit = 20): SignalRecord[] {
    const now = nowIso();
    const highPriorityRows = this.db.prepare(
      `SELECT * FROM signals
       WHERE project = ? AND target_agent = ? AND status = 'pending' AND priority IN ('P0', 'P1') AND not_before <= ?
       ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 ELSE 2 END, created_at ASC
       LIMIT ?`,
    ).all(this.project, agentId, now, limit) as DbSignal[];
    if (highPriorityRows.length > 0) return highPriorityRows.map(signalFromRow);
    const p2Rows = this.db.prepare(
      `SELECT * FROM signals
       WHERE project = ? AND target_agent = ? AND status = 'pending' AND priority = 'P2' AND not_before <= ?
       ORDER BY created_at ASC
       LIMIT 1`,
    ).all(this.project, agentId, now) as DbSignal[];
    return p2Rows.map(signalFromRow);
  }

  hasPendingSignals(): boolean {
    const row = this.db.prepare("SELECT id FROM signals WHERE project = ? AND status = 'pending' AND not_before <= ? LIMIT 1").get(this.project, nowIso()) as { id: string } | undefined;
    return row !== undefined;
  }

  latestSignalCreatedAt(input: { kind: string; targetAgent?: string }): string | undefined {
    const row = this.db
      .prepare(
        `SELECT created_at FROM signals
         WHERE project = ? AND kind = ? AND (? IS NULL OR target_agent = ?)
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(this.project, input.kind, input.targetAgent ?? null, input.targetAgent ?? null) as { created_at: string } | undefined;
    return row?.created_at;
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

  latestEvent(input: { type: string; match?: (data: JsonObject) => boolean }): { data: JsonObject; createdAt: string } | undefined {
    const rows = this.db.prepare("SELECT data_json, created_at FROM events WHERE project = ? AND type = ? ORDER BY created_at DESC").all(this.project, input.type) as Array<{ data_json: string; created_at: string }>;
    for (const row of rows) {
      const data = parseJsonObject(row.data_json);
      if (!input.match || input.match(data)) return { data, createdAt: row.created_at };
    }
    return undefined;
  }

  private nextAgentHistorySequence(agentId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS sequence FROM agent_history_messages WHERE project = ? AND agent_id = ?").get(this.project, agentId) as { sequence: number };
    return row.sequence + 1;
  }

  private insertAgentHistoryPart(agentId: string, messageId: string, activationId: string | undefined, partIndex: number, part: AgentHistoryPartInput, createdAt: string): AgentHistoryPart {
    const id = createId("hpart");
    const metadata = part.metadata ?? {};
    this.db.prepare("INSERT INTO agent_history_parts (id, project, agent_id, message_id, activation_id, part_index, type, text, tool_call_id, tool_name, input_json, output, error, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, this.project, agentId, messageId, activationId ?? null, partIndex, part.type, part.text ?? null, part.toolCallId ?? null, part.toolName ?? null, part.inputJson ?? null, part.output ?? null, part.error ?? null, JSON.stringify(metadata), createdAt);
    return { id, project: this.project, agentId, messageId, activationId, partIndex, type: part.type, text: part.text, toolCallId: part.toolCallId, toolName: part.toolName, inputJson: part.inputJson, output: part.output, error: part.error, metadata, createdAt };
  }

  private historyMessagesFromRows(rows: DbAgentHistoryMessage[]): AgentHistoryMessage[] {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    const parts = this.db.prepare(`SELECT * FROM agent_history_parts WHERE project = ? AND message_id IN (${placeholders}) ORDER BY message_id, part_index ASC`).all(this.project, ...ids) as DbAgentHistoryPart[];
    const byMessage = new Map<string, AgentHistoryPart[]>();
    for (const part of parts) {
      const item = historyPartFromRow(part);
      const list = byMessage.get(item.messageId) ?? [];
      list.push(item);
      byMessage.set(item.messageId, list);
    }
    return rows.map((row) => historyMessageFromRow(row, byMessage.get(row.id) ?? []));
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

  private deliveredNoEffectNudgeAttempt(activationId: string): number {
    const row = this.db.prepare("SELECT payload_json FROM signals WHERE project = ? AND delivered_activation_id = ? AND kind = 'scheduler.no_effect_nudge' ORDER BY created_at DESC LIMIT 1").get(this.project, activationId) as { payload_json: string } | undefined;
    if (!row) return 0;
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const attempt = payload.attempt;
    return typeof attempt === "number" && Number.isFinite(attempt) ? Math.max(1, Math.trunc(attempt)) : 1;
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
    this.addColumnIfMissing("signals", "not_before", "TEXT");
    if (this.columnExists("signals", "not_before")) this.db.exec("UPDATE signals SET not_before = created_at WHERE not_before IS NULL");
    if (this.columnExists("signals", "not_before")) this.db.exec("CREATE INDEX IF NOT EXISTS idx_signals_project_target_ready ON signals(project, target_agent, status, not_before, created_at)");
    if (this.columnExists("signals", "source_activation")) this.db.exec("CREATE INDEX IF NOT EXISTS idx_signals_project_source ON signals(project, source_activation, useful_effect)");
    this.addColumnIfMissing("activations", "context_json", "TEXT");

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

type DbActivation = { id: string; project: string; agent_id: string; status: ActivationRecord["status"]; prompt: string; input_path: string; output_path: string; container_name: string | null; started_at: string; completed_at: string | null; text: string | null; error: string | null; emitted_messages: number; usage_json: string | null; context_json: string | null };

function activationFromRow(row: DbActivation): ActivationRecord {
  return { id: row.id, project: row.project, agentId: row.agent_id, status: row.status, prompt: row.prompt, inputPath: row.input_path, outputPath: row.output_path, containerName: row.container_name ?? undefined, startedAt: row.started_at, completedAt: row.completed_at ?? undefined, text: row.text ?? undefined, error: row.error ?? undefined, emittedMessages: row.emitted_messages, usageJson: row.usage_json ?? undefined, contextJson: row.context_json ?? undefined };
}

type DbToolCall = { id: string; project: string; activation_id: string; agent_id: string; tool: string; input_json: string; status: "running" | "completed" | "failed"; output: string | null; error: string | null; created_at: string; completed_at: string | null };

type AgentHistoryPartInput = {
  type: AgentHistoryPartType;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  inputJson?: string;
  output?: string;
  error?: string;
  metadata?: JsonObject;
};

type DbAgentHistoryMessage = { id: string; project: string; agent_id: string; activation_id: string | null; role: AgentHistoryRole; kind: string; content: string; sequence: number; metadata_json: string; compaction_id: string | null; created_at: string };

type DbAgentHistoryPart = { id: string; project: string; agent_id: string; message_id: string; activation_id: string | null; part_index: number; type: AgentHistoryPartType; text: string | null; tool_call_id: string | null; tool_name: string | null; input_json: string | null; output: string | null; error: string | null; metadata_json: string; created_at: string };

type DbAgentHistoryCompaction = { id: string; project: string; agent_id: string; activation_id: string | null; summary_message_id: string; archive_path: string; start_sequence: number; end_sequence: number; archived_message_count: number; raw_chars: number; summary: string; reason: string | null; selected_model: string | null; created_at: string };

function historyMessageFromRow(row: DbAgentHistoryMessage, parts: AgentHistoryPart[]): AgentHistoryMessage {
  return { id: row.id, project: row.project, agentId: row.agent_id, activationId: row.activation_id ?? undefined, role: row.role, kind: row.kind, content: row.content, sequence: row.sequence, compactionId: row.compaction_id ?? undefined, archived: row.compaction_id !== null, metadata: parseJsonObject(row.metadata_json), parts, createdAt: row.created_at };
}

function historyPartFromRow(row: DbAgentHistoryPart): AgentHistoryPart {
  return { id: row.id, project: row.project, agentId: row.agent_id, messageId: row.message_id, activationId: row.activation_id ?? undefined, partIndex: row.part_index, type: row.type, text: row.text ?? undefined, toolCallId: row.tool_call_id ?? undefined, toolName: row.tool_name ?? undefined, inputJson: row.input_json ?? undefined, output: row.output ?? undefined, error: row.error ?? undefined, metadata: parseJsonObject(row.metadata_json), createdAt: row.created_at };
}

function compactionFromRow(row: DbAgentHistoryCompaction): AgentHistoryCompaction {
  return { id: row.id, project: row.project, agentId: row.agent_id, activationId: row.activation_id ?? undefined, summaryMessageId: row.summary_message_id, archivePath: row.archive_path, startSequence: row.start_sequence, endSequence: row.end_sequence, archivedMessageCount: row.archived_message_count, rawChars: row.raw_chars, summary: row.summary, reason: row.reason ?? undefined, selectedModel: row.selected_model ?? undefined, createdAt: row.created_at };
}

function parseJsonObject(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function countRows(db: DatabaseSync, table: string, project: string, where?: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project = ?${where ? ` AND ${where}` : ""}`).get(project) as { count: number };
  return row.count;
}

type DbSignal = { id: string; project: string; kind: string; source_agent: string | null; source_activation: string | null; target_agent: string | null; target_channel: string | null; priority: MessagePriority; payload_json: string; status: SignalRecord["status"]; useful_effect: number; created_at: string; not_before: string | null; delivered_at: string | null; delivered_activation_id: string | null };

function signalFromRow(row: DbSignal): SignalRecord {
  const notBefore = row.not_before && row.not_before !== row.created_at ? row.not_before : undefined;
  return { id: row.id, project: row.project, kind: row.kind, sourceAgent: row.source_agent ?? undefined, sourceActivation: row.source_activation ?? undefined, targetAgent: row.target_agent ?? undefined, targetChannel: row.target_channel ?? undefined, priority: row.priority, payload: JSON.parse(row.payload_json) as JsonObject, status: row.status, usefulEffect: row.useful_effect !== 0, createdAt: row.created_at, notBefore, deliveredAt: row.delivered_at ?? undefined, deliveredActivationId: row.delivered_activation_id ?? undefined };
}

function signalAgent(value: string | undefined): string | undefined {
  return value === "user" ? undefined : value;
}

function signalPriority(value: unknown): MessagePriority {
  if (value === "P0" || value === "P1" || value === "P2") return value;
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

function defaultNoEffectNudgeConfig(): NoEffectNudgeConfig {
  return { enabled: true, priority: "P2", maxConsecutive: 0, initialDelayMs: 30_000, backoffFactor: 2, maxDelayMs: 300_000 };
}

function noEffectNudgeDelayMs(config: Partial<NoEffectNudgeConfig>, attempt: number): number {
  if (attempt <= 1) return 0;
  const initialDelayMs = Math.max(0, Math.trunc(config.initialDelayMs ?? 30_000));
  const maxDelayMs = Math.max(0, Math.trunc(config.maxDelayMs ?? 300_000));
  const factor = Math.max(1, config.backoffFactor ?? 2);
  const uncapped = initialDelayMs * factor ** Math.max(0, attempt - 2);
  if (!Number.isFinite(uncapped)) return maxDelayMs;
  return Math.min(maxDelayMs, Math.trunc(uncapped));
}

function textPartType(role: AgentHistoryRole): AgentHistoryPartType {
  if (role === "tool_call") return "tool_call";
  if (role === "tool_result") return "tool_result";
  if (role === "compaction") return "compaction";
  return "text";
}

function renderToolCallContent(tool: string, input: unknown): string {
  return [`# Tool Call`, `Tool: ${tool}`, "", JSON.stringify(input ?? {}, null, 2)].join("\n");
}

function renderToolResultContent(tool: string, status: "completed" | "failed", output?: string, error?: string): string {
  return [`# Tool Result`, `Tool: ${tool}`, `Status: ${status}`, error ? `Error: ${error}` : undefined, output ? ["", output].join("\n") : undefined].filter(Boolean).join("\n");
}

function renderSignalForHistory(signal: SignalRecord): string {
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
  usage_json TEXT,
  context_json TEXT
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
  not_before TEXT,
  delivered_at TEXT,
  delivered_activation_id TEXT
);
CREATE TABLE IF NOT EXISTS agent_history_messages (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  activation_id TEXT,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  compaction_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_history_parts (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  activation_id TEXT,
  part_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  text TEXT,
  tool_call_id TEXT,
  tool_name TEXT,
  input_json TEXT,
  output TEXT,
  error TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_history_compactions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  activation_id TEXT,
  summary_message_id TEXT NOT NULL,
  archive_path TEXT NOT NULL,
  start_sequence INTEGER NOT NULL,
  end_sequence INTEGER NOT NULL,
  archived_message_count INTEGER NOT NULL,
  raw_chars INTEGER NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT,
  selected_model TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project, created_at);
CREATE INDEX IF NOT EXISTS idx_events_project_created ON events(project, created_at);
CREATE INDEX IF NOT EXISTS idx_activations_project_started ON activations(project, started_at);
CREATE INDEX IF NOT EXISTS idx_signals_project_target ON signals(project, target_agent, status, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_history_project_agent_sequence ON agent_history_messages(project, agent_id, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_history_project_agent_active ON agent_history_messages(project, agent_id, compaction_id, sequence);
CREATE INDEX IF NOT EXISTS idx_agent_history_parts_message ON agent_history_parts(project, message_id, part_index);
CREATE INDEX IF NOT EXISTS idx_agent_history_compactions_agent ON agent_history_compactions(project, agent_id, created_at);
`;
