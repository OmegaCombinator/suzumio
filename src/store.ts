import { copyFile, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { createId, nowIso, safeName } from "./id.js";
import { agentPaths, ensureProjectDirs, projectPaths, suzumioRoot, type ProjectPaths } from "./paths.js";
import type { AgentRecord, MessagePriority, MessageRecord, ProjectConfig, ProjectStatus, RunnerTurnOutput, TurnRecord } from "./types.js";

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

  setAgentStatus(agentId: string, status: AgentRecord["status"], activeTurnId?: string | null, containerName?: string | null): void {
    this.db.prepare("UPDATE agents SET status = ?, active_turn_id = ?, container_name = COALESCE(?, container_name), updated_at = ? WHERE project = ? AND id = ?").run(status, activeTurnId ?? null, containerName ?? null, nowIso(), this.project, agentId);
    this.appendEvent("agent.status", { agentId, status, activeTurnId });
  }

  sendMessage(input: { sender: string; recipient?: string; channel?: string; priority?: MessagePriority; body: string }): MessageRecord {
    if (!input.recipient && !input.channel) throw new Error("Message needs recipient or channel");
    if (input.recipient && input.channel) throw new Error("Message cannot have both recipient and channel");
    if (input.channel && !this.config().channels.includes(input.channel)) throw new Error(`Unknown channel: ${input.channel}`);
    const message: MessageRecord = {
      id: createId("msg"),
      project: this.project,
      sender: input.sender,
      recipient: input.recipient,
      channel: input.channel,
      priority: input.priority ?? "P2",
      body: input.body,
      createdAt: nowIso(),
    };
    this.db.prepare("INSERT INTO messages (id, project, sender, recipient, channel, priority, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(message.id, message.project, message.sender, message.recipient ?? null, message.channel ?? null, message.priority, message.body, message.createdAt);
    this.appendEvent("message.created", message);
    return message;
  }

  listMessages(limit = 100): MessageRecord[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE project = ? ORDER BY created_at DESC LIMIT ?").all(this.project, limit) as DbMessage[];
    return rows.reverse().map(messageFromRow);
  }

  unreadMessages(agentId: string): MessageRecord[] {
    const config = this.config();
    const rows = this.db.prepare(
      `SELECT m.* FROM messages m
       LEFT JOIN message_reads r ON r.message_id = m.id AND r.agent_id = ?
       WHERE m.project = ? AND r.message_id IS NULL
         AND m.sender != ?
         AND (m.recipient = ? OR (m.channel IS NOT NULL AND m.channel IN (${config.channels.map(() => "?").join(",")})))
       ORDER BY m.created_at ASC`,
    ).all(agentId, this.project, agentId, agentId, ...config.channels) as DbMessage[];
    return rows.map(messageFromRow);
  }

  markRead(agentId: string, messages: MessageRecord[], turnId: string): void {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO message_reads (message_id, agent_id, turn_id, read_at) VALUES (?, ?, ?, ?)");
    const now = nowIso();
    for (const message of messages) stmt.run(message.id, agentId, turnId, now);
  }

  createTurn(agent: AgentRecord, prompt: string): TurnRecord {
    const turnId = createId("turn");
    const turnDir = path.join(this.paths.turns, turnId);
    const inputPath = path.join(turnDir, "input.json");
    const outputPath = path.join(turnDir, "result.json");
    const now = nowIso();
    this.db.prepare("INSERT INTO turns (id, project, agent_id, status, prompt, input_path, output_path, started_at, emitted_messages) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(turnId, this.project, agent.id, "running", prompt, inputPath, outputPath, now, 0);
    this.setAgentStatus(agent.id, "running", turnId);
    this.appendEvent("turn.started", { turnId, agentId: agent.id });
    return { id: turnId, project: this.project, agentId: agent.id, status: "running", prompt, inputPath, outputPath, startedAt: now, emittedMessages: 0 };
  }

  setTurnContainer(turnId: string, containerName: string): void {
    this.db.prepare("UPDATE turns SET container_name = ? WHERE id = ? AND project = ?").run(containerName, turnId, this.project);
    const agentId = (this.db.prepare("SELECT agent_id FROM turns WHERE id = ? AND project = ?").get(turnId, this.project) as { agent_id: string }).agent_id;
    this.setAgentStatus(agentId, "running", turnId, containerName);
  }

  completeTurn(turnId: string, output: RunnerTurnOutput): void {
    const turn = this.turn(turnId);
    const emitted = this.countTurnMessages(turn.agentId, turn.startedAt);
    this.db.prepare("UPDATE turns SET status = ?, completed_at = ?, text = ?, usage_json = ?, emitted_messages = ? WHERE id = ? AND project = ?").run("completed", nowIso(), output.text, JSON.stringify(output.usage ?? {}), emitted, turnId, this.project);
    this.setAgentStatus(turn.agentId, "quiet", null);
    this.appendEvent("turn.completed", { turnId, agentId: turn.agentId, emittedMessages: emitted });
  }

  failTurn(turnId: string, error: string): void {
    const turn = this.turn(turnId);
    this.db.prepare("UPDATE turns SET status = ?, completed_at = ?, error = ? WHERE id = ? AND project = ?").run("failed", nowIso(), error, turnId, this.project);
    this.setAgentStatus(turn.agentId, "failed", null);
    this.appendEvent("turn.failed", { turnId, agentId: turn.agentId, error });
  }

  turn(turnId: string): TurnRecord {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ? AND project = ?").get(turnId, this.project) as DbTurn | undefined;
    if (!row) throw new Error(`Unknown turn: ${turnId}`);
    return turnFromRow(row);
  }

  listTurns(limit = 100): TurnRecord[] {
    const rows = this.db.prepare("SELECT * FROM turns WHERE project = ? ORDER BY started_at DESC LIMIT ?").all(this.project, limit) as DbTurn[];
    return rows.reverse().map(turnFromRow);
  }

  recordToolCall(input: { turnId: string; agentId: string; tool: string; input: unknown; status: "running" | "completed" | "failed"; output?: string; error?: string }): string {
    const id = createId("tool");
    const now = nowIso();
    this.db.prepare("INSERT INTO tool_calls (id, project, turn_id, agent_id, tool, input_json, status, output, error, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, this.project, input.turnId, input.agentId, input.tool, JSON.stringify(input.input ?? {}), input.status, input.output ?? null, input.error ?? null, now, input.status === "running" ? null : now);
    this.appendEvent("tool.called", { id, turnId: input.turnId, agentId: input.agentId, tool: input.tool, status: input.status });
    return id;
  }

  finishToolCall(id: string, status: "completed" | "failed", output?: string, error?: string): void {
    this.db.prepare("UPDATE tool_calls SET status = ?, output = ?, error = ?, completed_at = ? WHERE id = ? AND project = ?").run(status, output ?? null, error ?? null, nowIso(), id, this.project);
    this.appendEvent(status === "completed" ? "tool.completed" : "tool.failed", { id, output, error });
  }

  listToolCalls(limit = 100): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM tool_calls WHERE project = ? ORDER BY created_at DESC LIMIT ?").all(this.project, limit) as Record<string, unknown>[];
  }

  async publishArtifact(input: { creator: string; turnId: string; workspacePath: string; sourcePath: string; name?: string; description?: string }): Promise<Record<string, unknown>> {
    const resolved = path.resolve(input.workspacePath, input.sourcePath);
    assertInside(resolved, input.workspacePath);
    const info = await stat(resolved);
    const name = safeName(input.name ?? path.basename(resolved));
    const id = createId("art");
    const destination = path.join(this.paths.artifacts, `${id}_${name}`);
    if (info.isDirectory()) await cp(resolved, destination, { recursive: true, errorOnExist: true });
    else if (info.isFile()) await copyFile(resolved, destination);
    else throw new Error("Only file and directory artifacts are supported");
    const sha256 = info.isDirectory() ? await directorySha256(destination) : createHash("sha256").update(await readFile(destination)).digest("hex");
    const createdAt = nowIso();
    this.db.prepare("INSERT INTO artifacts (id, project, creator, turn_id, name, path, sha256, description, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, this.project, input.creator, input.turnId, name, destination, sha256, input.description ?? null, createdAt);
    const artifact = { id, project: this.project, creator: input.creator, turnId: input.turnId, name, path: destination, sha256, description: input.description, createdAt };
    this.appendEvent("artifact.published", artifact);
    return artifact;
  }

  listArtifacts(limit = 100): Record<string, unknown>[] {
    return this.db.prepare("SELECT * FROM artifacts WHERE project = ? ORDER BY created_at DESC LIMIT ?").all(this.project, limit) as Record<string, unknown>[];
  }

  async submitProject(input: { agentId: string; report: string }): Promise<string> {
    const reportPath = path.join(this.paths.root, "final-report.md");
    await writeFile(reportPath, input.report.trim() + "\n", "utf8");
    this.db.prepare("UPDATE projects SET status = ?, submitted_report = ?, updated_at = ? WHERE id = ?").run("submitted", reportPath, nowIso(), this.project);
    this.appendEvent("project.submitted", { agentId: input.agentId, reportPath });
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

  private countTurnMessages(agentId: string, startedAt: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM messages WHERE project = ? AND sender = ? AND created_at >= ?").get(this.project, agentId, startedAt) as { count: number };
    return row.count;
  }

  private createSchema(): void {
    this.db.exec(SCHEMA);
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
      await mkdir(paths.workspace, { recursive: true });
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

function assertInside(filePath: string, root: string): void {
  const resolved = path.resolve(filePath);
  const base = path.resolve(root);
  if (resolved === base || resolved.startsWith(base + path.sep)) return;
  throw new Error(`Path is outside workspace: ${filePath}`);
}

async function directorySha256(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const files = await directoryFiles(directory, directory);
  for (const file of files.sort((a, b) => a.relative.localeCompare(b.relative))) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(await readFile(file.absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function directoryFiles(root: string, directory: string): Promise<Array<{ absolute: string; relative: string }>> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: Array<{ absolute: string; relative: string }> = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await directoryFiles(root, absolute)));
    else if (entry.isFile()) files.push({ absolute, relative: path.relative(root, absolute) });
  }
  return files;
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
  active_turn_id: string | null;
  container_name: string | null;
  created_at: string;
  updated_at: string;
};

function agentFromRow(row: DbAgent): AgentRecord {
  return { id: row.id, project: row.project, role: row.role, displayName: row.display_name, status: row.status, prompt: row.prompt, model: row.model ?? undefined, tools: JSON.parse(row.tools_json) as string[], workspacePath: row.workspace_path, token: row.token, activeTurnId: row.active_turn_id ?? undefined, containerName: row.container_name ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at };
}

type DbMessage = { id: string; project: string; sender: string; recipient: string | null; channel: string | null; priority: MessagePriority; body: string; created_at: string };

function messageFromRow(row: DbMessage): MessageRecord {
  return { id: row.id, project: row.project, sender: row.sender, recipient: row.recipient ?? undefined, channel: row.channel ?? undefined, priority: row.priority, body: row.body, createdAt: row.created_at };
}

type DbTurn = { id: string; project: string; agent_id: string; status: TurnRecord["status"]; prompt: string; input_path: string; output_path: string; container_name: string | null; started_at: string; completed_at: string | null; text: string | null; error: string | null; emitted_messages: number; usage_json: string | null };

function turnFromRow(row: DbTurn): TurnRecord {
  return { id: row.id, project: row.project, agentId: row.agent_id, status: row.status, prompt: row.prompt, inputPath: row.input_path, outputPath: row.output_path, containerName: row.container_name ?? undefined, startedAt: row.started_at, completedAt: row.completed_at ?? undefined, text: row.text ?? undefined, error: row.error ?? undefined, emittedMessages: row.emitted_messages, usageJson: row.usage_json ?? undefined };
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
  active_turn_id TEXT,
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
CREATE TABLE IF NOT EXISTS message_reads (
  message_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (message_id, agent_id)
);
CREATE TABLE IF NOT EXISTS turns (
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
  turn_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_json TEXT NOT NULL,
  status TEXT NOT NULL,
  output TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  creator TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_project_created ON messages(project, created_at);
CREATE INDEX IF NOT EXISTS idx_events_project_created ON events(project, created_at);
CREATE INDEX IF NOT EXISTS idx_turns_project_started ON turns(project, started_at);
`;
