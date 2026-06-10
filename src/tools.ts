import { pathToFileURL } from "node:url";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentRecord, JsonObject, MessagePriority, ProjectConfig, ToolDefinition, ToolpackConfigEntry, ToolStatusEntry, ToolWebuiDefinition, ToolWebuiEntry } from "./types.js";
import { ProjectStore } from "./store.js";

export type ToolCallOutput = {
  title?: string;
  output: string;
  metadata?: JsonObject;
};

export type ResolvedToolpack = {
  id: string;
  kind: "builtin" | "local";
  root?: string;
  runnerModule: string;
  controllerModule?: string;
  tools: ToolDefinition[];
  webui: ToolWebuiDefinition[];
};

export type ToolSupportInput = {
  project: string;
  agentId: string;
  activationId: string;
  token: string;
  tool: string;
  input: unknown;
};

export type ToolCallStartInput = {
  project: string;
  agentId: string;
  activationId: string;
  token: string;
  tool: string;
  input: unknown;
};

export type ToolCallFinishInput = {
  project: string;
  agentId: string;
  activationId: string;
  token: string;
  toolCallId: string;
  status: "completed" | "failed";
  output?: string;
  error?: string;
};

export type ToolCallFinishOutput = {
  status: "completed" | "failed";
  deliveredSignals?: number;
  signalText?: string;
};

export type SignalInput = {
  project: string;
  agentId: string;
  activationId: string;
  token: string;
  kind: string;
  targetAgent?: string;
  targetChannel?: string;
  priority?: MessagePriority;
  payload?: JsonObject;
  usefulEffect?: boolean;
};

type ControllerContext = {
  store: ProjectStore;
  agent: AgentRecord;
  activationId: string;
  recordSignal: (input: { kind: string; targetAgent?: string; targetChannel?: string; priority?: MessagePriority; payload?: JsonObject; status?: "pending" | "closed"; usefulEffect?: boolean }) => void;
};

type ControllerHandler = (context: ControllerContext, input: unknown) => Promise<ToolCallOutput>;

type ToolWebuiContext = {
  store: ProjectStore;
  project: string;
  toolpackId: string;
  recordSignal: (input: { kind: string; targetAgent?: string; targetChannel?: string; priority?: MessagePriority; payload?: JsonObject; status?: "pending" | "closed"; usefulEffect?: boolean }) => void;
};

type ToolWebuiHandler = (context: ToolWebuiContext, input: unknown) => Promise<ToolCallOutput>;

type BuiltinToolpack = {
  id: string;
  tools: ToolDefinition[];
  support: Record<string, ControllerHandler>;
  webui: ToolWebuiDefinition[];
  webuiSupport: Record<string, ToolWebuiHandler>;
};

export class ToolSupportHost {
  constructor(private readonly root?: string) {}

  async startToolCall(input: ToolCallStartInput): Promise<{ toolCallId: string }> {
    const store = new ProjectStore(input.project, this.root);
    try {
      const agent = this.authorize(store, input.agentId, input.token, input.activationId);
      await this.requireTool(store, agent, input.tool);
      return { toolCallId: store.recordToolCall({ activationId: input.activationId, agentId: agent.id, tool: input.tool, input: input.input, status: "running" }) };
    } finally {
      store.close();
    }
  }

  async finishToolCall(input: ToolCallFinishInput): Promise<ToolCallFinishOutput> {
    const store = new ProjectStore(input.project, this.root);
    try {
      const agent = this.authorize(store, input.agentId, input.token, input.activationId, { requireRunning: false });
      store.finishToolCallForActivation(input.toolCallId, agent.id, input.activationId, input.status, input.output, input.error);
      const activation = store.activation(input.activationId);
      const delivered = input.status === "completed" && activation.status === "running" ? store.deliverToolBoundarySignals(agent.id, input.activationId) : { signals: [] };
      return { status: input.status, deliveredSignals: delivered.signals.length || undefined, signalText: delivered.content };
    } finally {
      store.close();
    }
  }

  async recordRunnerSignal(input: SignalInput): Promise<{ status: string }> {
    const store = new ProjectStore(input.project, this.root);
    try {
      const agent = this.authorize(store, input.agentId, input.token, input.activationId);
      store.recordSignal({ kind: input.kind, sourceAgent: agent.id, sourceActivation: input.activationId, targetAgent: input.targetAgent, targetChannel: input.targetChannel, priority: input.priority, payload: input.payload ?? {}, usefulEffect: input.usefulEffect });
      return { status: "recorded" };
    } finally {
      store.close();
    }
  }

  async support(toolpackId: string, input: ToolSupportInput): Promise<ToolCallOutput> {
    const store = new ProjectStore(input.project, this.root);
    try {
      const agent = this.authorize(store, input.agentId, input.token, input.activationId);
      const toolpacks = await resolveToolpacks(store.config().tools.toolpacks);
      const toolpack = toolpacks.find((item) => item.id === toolpackId);
      if (!toolpack) throw new Error(`Unknown toolpack: ${toolpackId}`);
      if (!toolpack.tools.some((tool) => tool.name === input.tool)) throw new Error(`Tool ${input.tool} is not in toolpack ${toolpackId}`);
      if (!isAllowed(input.tool, agent.tools)) throw new Error(`Tool not allowed for ${agent.id}: ${input.tool}`);
      const context = controllerContext(store, agent, input.activationId);
      if (toolpack.kind === "builtin") return await builtinSupport(toolpack.id, input.tool, context, input.input);
      return await externalSupport(toolpack, input.tool, context, input.input);
    } finally {
      store.close();
    }
  }

  async listWebui(project: string): Promise<ToolWebuiEntry[]> {
    const store = new ProjectStore(project, this.root);
    try {
      return (await resolveToolpacks(store.config().tools.toolpacks)).flatMap((toolpack) => toolpack.webui.map((entry) => ({ ...entry, toolpackId: toolpack.id, toolpackKind: toolpack.kind })));
    } finally {
      store.close();
    }
  }

  async listToolStatus(project: string): Promise<ToolStatusEntry[]> {
    const store = new ProjectStore(project, this.root);
    try {
      const config = store.config();
      const agents = store.listAgents();
      const statuses = new Map<string, ToolStatusEntry>();
      for (const toolpack of await resolveToolpacks(config.tools.toolpacks)) {
        for (const tool of toolpack.tools) {
          statuses.set(tool.name, {
            tool: tool.name,
            toolpackId: toolpack.id,
            toolpackKind: toolpack.kind,
            description: tool.description,
            enabledForAgents: agents.filter((agent) => isAllowed(tool.name, agent.tools)).map((agent) => agent.id),
            callCount: 0,
            runningCount: 0,
            completedCount: 0,
            failedCount: 0,
          });
        }
      }
      for (const row of toolCallAggregateRows(store)) {
        const status = statuses.get(row.tool) ?? unknownToolStatus(row.tool);
        status.callCount = row.callCount;
        status.runningCount = row.runningCount;
        status.completedCount = row.completedCount;
        status.failedCount = row.failedCount;
        statuses.set(row.tool, status);
      }
      for (const row of latestToolCallRows(store)) {
        const status = statuses.get(row.tool) ?? unknownToolStatus(row.tool);
        status.lastStatus = row.status;
        status.lastAgentId = row.agentId;
        status.lastAt = row.completedAt ?? row.createdAt;
        status.lastError = truncateForStatus(row.error, 600);
        statuses.set(row.tool, status);
      }
      const submittedReport = store.projectRow().submitted_report;
      if (typeof submittedReport === "string" && submittedReport) {
        const status = statuses.get("completion.submit") ?? unknownToolStatus("completion.submit");
        status.submittedReportPath = submittedReport;
        statuses.set(status.tool, status);
      }
      return [...statuses.values()].sort((a, b) => a.tool.localeCompare(b.tool));
    } finally {
      store.close();
    }
  }

  async invokeWebui(project: string, toolpackId: string, entryId: string, input: unknown): Promise<ToolCallOutput> {
    const store = new ProjectStore(project, this.root);
    try {
      const toolpacks = await resolveToolpacks(store.config().tools.toolpacks);
      const toolpack = toolpacks.find((item) => item.id === toolpackId);
      if (!toolpack) throw new Error(`Unknown toolpack: ${toolpackId}`);
      if (!toolpack.webui.some((entry) => entry.id === entryId)) throw new Error(`Unknown WebUI tool entry ${entryId} in ${toolpackId}`);
      const context = webuiContext(store, toolpack.id);
      if (toolpack.kind === "builtin") return await builtinWebui(toolpack.id, entryId, context, input);
      return await externalWebui(toolpack, entryId, context, input);
    } finally {
      store.close();
    }
  }

  private authorize(store: ProjectStore, agentId: string, token: string, activationId: string, options: { requireRunning?: boolean } = {}): AgentRecord {
    const agent = store.requireAgent(agentId);
    if (agent.token !== token) throw new Error("Invalid agent token");
    const activation = store.activation(activationId);
    if (activation.agentId !== agent.id) throw new Error(`Activation ${activationId} does not belong to ${agent.id}`);
    if (options.requireRunning !== false && activation.status !== "running") throw new Error(`Activation ${activationId} is ${activation.status}; no more tool calls are accepted`);
    return agent;
  }

  private async requireTool(store: ProjectStore, agent: AgentRecord, toolName: string): Promise<void> {
    const found = (await resolveToolpacks(store.config().tools.toolpacks)).some((toolpack) => toolpack.tools.some((tool) => tool.name === toolName));
    if (!found) throw new Error(`Unknown tool: ${toolName}`);
    if (!isAllowed(toolName, agent.tools)) throw new Error(`Tool not allowed for ${agent.id}: ${toolName}`);
  }
}

type ToolCallAggregateRow = {
  tool: string;
  callCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
};

type LatestToolCallRow = {
  tool: string;
  status: "running" | "completed" | "failed";
  agentId: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
};

type DirectMessageRow = {
  id: string;
  sender: string;
  recipient?: string;
  channel?: string;
  priority: MessagePriority;
  body: string;
  createdAt: string;
};

type DirectMessagePairRow = {
  sender: string;
  recipient: string;
  count: number;
  lastAt: string;
};

type SignalAggregateRow = {
  status: "pending" | "delivered" | "closed";
  priority: MessagePriority;
  count: number;
};

type RecentSignalRow = {
  id: string;
  kind: string;
  sourceAgent?: string;
  targetAgent?: string;
  targetChannel?: string;
  priority: MessagePriority;
  status: "pending" | "delivered" | "closed";
  createdAt: string;
  payloadSummary: string;
};

type RecentToolActivityRow = {
  id: string;
  tool: string;
  agentId: string;
  status: "running" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  summary: string;
  error?: string;
};

function directConversationMessages(store: ProjectStore, agentA: string, agentB: string, limit: number): DirectMessageRow[] {
  const rows = store.db.prepare(
    `SELECT id, sender, recipient, channel, priority, body, created_at
     FROM messages
     WHERE project = ?
       AND channel IS NULL
       AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(store.project, agentA, agentB, agentB, agentA, limit) as Array<Record<string, unknown>>;
  return rows.reverse().map(messageRowFromDb);
}

function recentDirectMessagePairs(store: ProjectStore, limit: number): DirectMessagePairRow[] {
  const rows = store.db.prepare(
    `SELECT sender, recipient, COUNT(*) AS count, MAX(created_at) AS last_at
     FROM messages
     WHERE project = ? AND channel IS NULL AND recipient IS NOT NULL
     GROUP BY sender, recipient
     ORDER BY last_at DESC
     LIMIT ?`,
  ).all(store.project, limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ sender: String(row.sender), recipient: String(row.recipient), count: numberField(row.count), lastAt: String(row.last_at) }));
}

function messageRowFromDb(row: Record<string, unknown>): DirectMessageRow {
  return {
    id: String(row.id),
    sender: String(row.sender),
    recipient: optionalString(row.recipient),
    channel: optionalString(row.channel),
    priority: priorityArg(row.priority),
    body: String(row.body ?? ""),
    createdAt: String(row.created_at),
  };
}

function formatMessageRecord(message: DirectMessageRow): string {
  const target = message.recipient ?? message.channel ?? "broadcast";
  return [`## ${message.createdAt} ${message.priority} ${message.sender} -> ${target}`, `id: ${message.id}`, "", truncateForStatus(message.body, 12_000) ?? ""].join("\n");
}

function signalAggregateRows(store: ProjectStore): SignalAggregateRow[] {
  const rows = store.db.prepare(
    `SELECT status, priority, COUNT(*) AS count
     FROM signals
     WHERE project = ?
     GROUP BY status, priority
     ORDER BY status, priority`,
  ).all(store.project) as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const status = signalStatusArg(row.status);
    if (!status) return [];
    return [{ status, priority: priorityArg(row.priority), count: numberField(row.count) }];
  });
}

function recentSignalRows(store: ProjectStore, input: { targetAgent?: string; status?: "pending" | "delivered" | "closed"; limit: number }): RecentSignalRow[] {
  const filters = ["project = ?"];
  const params: Array<string | number> = [store.project];
  if (input.targetAgent) {
    filters.push("target_agent = ?");
    params.push(input.targetAgent);
  }
  if (input.status) {
    filters.push("status = ?");
    params.push(input.status);
  }
  params.push(input.limit);
  const rows = store.db.prepare(
    `SELECT id, kind, source_agent, target_agent, target_channel, priority, status, payload_json, created_at
     FROM signals
     WHERE ${filters.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const status = signalStatusArg(row.status);
    if (!status) return [];
    return [{
      id: String(row.id),
      kind: String(row.kind),
      sourceAgent: optionalString(row.source_agent),
      targetAgent: optionalString(row.target_agent),
      targetChannel: optionalString(row.target_channel),
      priority: priorityArg(row.priority),
      status,
      createdAt: String(row.created_at),
      payloadSummary: summarizeSignalPayload(row.payload_json),
    }];
  });
}

function signalStatusCounts(rows: SignalAggregateRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + row.count;
  return counts;
}

function formatSignalRecord(signal: RecentSignalRow): string {
  const target = signal.targetAgent ?? signal.targetChannel ?? "no target";
  const source = signal.sourceAgent ? ` from ${signal.sourceAgent}` : "";
  return `- ${signal.createdAt} [${signal.priority}/${signal.status}] ${signal.kind}${source} -> ${target}: ${signal.payloadSummary}`;
}

function summarizeSignalPayload(value: unknown): string {
  const payload = parseJsonObject(value);
  if (typeof payload.id === "string" && typeof payload.body === "string") return `message ${payload.id}, ${payload.body.length} chars`;
  if (typeof payload.reason === "string") return truncateOneLine(payload.reason, 180);
  if (typeof payload.message === "string") return truncateOneLine(payload.message, 180);
  const keys = Object.keys(payload);
  return keys.length ? `keys: ${keys.slice(0, 8).join(", ")}` : "no payload";
}

function toolActivityReport(store: ProjectStore, title: string, tools: string[], input: unknown, summarize: (tool: string, input: JsonObject) => string): ToolCallOutput {
  const args = objectInput(input);
  const limit = boundedNumber(args.limit, 20, 100);
  const aggregateByTool = new Map(toolCallAggregateRows(store).filter((row) => tools.includes(row.tool)).map((row) => [row.tool, row]));
  const metrics = tools.map((tool) => {
    const row = aggregateByTool.get(tool);
    return {
      label: tool,
      value: row?.callCount ?? 0,
      description: `${row?.runningCount ?? 0} running, ${row?.completedCount ?? 0} completed, ${row?.failedCount ?? 0} failed`,
    };
  });
  const recent = recentToolActivityRows(store, tools, limit, summarize);
  const output = [
    `${title}:`,
    ...metrics.map((metric) => `- ${metric.label}: ${metric.value} (${metric.description})`),
    "",
    "Recent activity:",
    ...(recent.length ? recent.map(formatToolActivityRecord) : ["- none"]),
  ].join("\n");
  return { title, output, metadata: { metrics, recent } };
}

function recentToolActivityRows(store: ProjectStore, tools: string[], limit: number, summarize: (tool: string, input: JsonObject) => string): RecentToolActivityRow[] {
  if (tools.length === 0) return [];
  const placeholders = tools.map(() => "?").join(", ");
  const rows = store.db.prepare(
    `SELECT id, tool, agent_id, status, input_json, error, created_at, completed_at
     FROM tool_calls
     WHERE project = ? AND tool IN (${placeholders})
     ORDER BY created_at DESC
     LIMIT ?`,
  ).all(store.project, ...tools, limit) as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const status = toolCallStatusArg(row.status);
    if (!status) return [];
    const tool = String(row.tool);
    const input = parseJsonObject(row.input_json);
    return [{
      id: String(row.id),
      tool,
      agentId: String(row.agent_id),
      status,
      createdAt: String(row.created_at),
      completedAt: optionalString(row.completed_at),
      summary: summarize(tool, input),
      error: truncateForStatus(optionalString(row.error), 600),
    }];
  });
}

function formatToolActivityRecord(row: RecentToolActivityRow): string {
  const closed = row.completedAt ? `, closed ${row.completedAt}` : "";
  const error = row.error ? `\n  error: ${truncateOneLine(row.error, 220)}` : "";
  return `- ${row.createdAt} [${row.status}] ${row.agentId} ${row.tool}: ${row.summary}${closed}${error}`;
}

function summarizeFileToolInput(tool: string, input: JsonObject): string {
  if (tool === "file.patch") {
    const operations = Array.isArray(input.operations) ? input.operations.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
    const paths = operations.flatMap((item) => optionalString(item.path) ? [optionalString(item.path)!] : []);
    return `${operations.length} operations${paths.length ? `: ${paths.slice(0, 6).join(", ")}${paths.length > 6 ? ", ..." : ""}` : ""}`;
  }
  return optionalString(input.path) ?? "path not recorded";
}

function summarizeShellInput(_tool: string, input: JsonObject): string {
  const command = optionalString(input.command) ?? "command not recorded";
  const cwd = optionalString(input.cwd);
  return `${cwd ? `${cwd}: ` : ""}${truncateOneLine(command, 220)}`;
}

function summarizeWebInput(_tool: string, input: JsonObject): string {
  const url = optionalString(input.url) ?? "url not recorded";
  const format = optionalString(input.format);
  return `${truncateOneLine(url, 220)}${format ? ` (${format})` : ""}`;
}

function toolCallAggregateRows(store: ProjectStore): ToolCallAggregateRow[] {
  const rows = store.db.prepare(
    `SELECT tool,
            COUNT(*) AS call_count,
            SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
     FROM tool_calls
     WHERE project = ?
     GROUP BY tool`,
  ).all(store.project) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    tool: String(row.tool),
    callCount: numberField(row.call_count),
    runningCount: numberField(row.running_count),
    completedCount: numberField(row.completed_count),
    failedCount: numberField(row.failed_count),
  }));
}

function latestToolCallRows(store: ProjectStore): LatestToolCallRow[] {
  const rows = store.db.prepare(
    `SELECT current.tool, current.status, current.agent_id, current.created_at, current.completed_at, current.error
     FROM tool_calls current
     WHERE current.project = ?
       AND NOT EXISTS (
         SELECT 1 FROM tool_calls newer
         WHERE newer.project = current.project
           AND newer.tool = current.tool
           AND (newer.created_at > current.created_at OR (newer.created_at = current.created_at AND newer.id > current.id))
       )`,
  ).all(store.project) as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const status = stringField(row.status, "status");
    if (status !== "running" && status !== "completed" && status !== "failed") return [];
    return [{
      tool: stringField(row.tool, "tool"),
      status,
      agentId: stringField(row.agent_id, "agent_id"),
      createdAt: stringField(row.created_at, "created_at"),
      completedAt: optionalString(row.completed_at),
      error: optionalString(row.error),
    }];
  });
}

function unknownToolStatus(tool: string): ToolStatusEntry {
  return { tool, enabledForAgents: [], callCount: 0, runningCount: 0, completedCount: 0, failedCount: 0 };
}

function numberField(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function truncateForStatus(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n\n[truncated ${value.length - maxChars} chars]`;
}

export async function resolveToolpacks(entries: ToolpackConfigEntry[]): Promise<ResolvedToolpack[]> {
  const resolved: ResolvedToolpack[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const toolpack = typeof entry === "string" ? builtinToolpack(entry) : await localToolpack(entry.path, entry.id);
    if (seen.has(toolpack.id)) throw new Error(`Duplicate toolpack: ${toolpack.id}`);
    seen.add(toolpack.id);
    resolved.push(toolpack);
  }
  assertNoDuplicateTools(resolved);
  return resolved;
}

export async function toolDefinitions(agent: AgentRecord, toolpacks: ToolpackConfigEntry[]): Promise<ToolDefinition[]> {
  return (await resolveToolpacks(toolpacks)).flatMap((toolpack) => toolpack.tools).filter((definition) => isAllowed(definition.name, agent.tools));
}

export async function toolWebuiDefinitions(toolpacks: ToolpackConfigEntry[]): Promise<ToolWebuiEntry[]> {
  return (await resolveToolpacks(toolpacks)).flatMap((toolpack) => toolpack.webui.map((entry) => ({ ...entry, toolpackId: toolpack.id, toolpackKind: toolpack.kind })));
}

export function isAllowed(tool: string, allowlist: string[]): boolean {
  let allowed = false;
  for (const pattern of allowlist) {
    if (pattern === tool || pattern === "*" || (pattern.endsWith(".*") && tool.startsWith(pattern.slice(0, -1)))) allowed = true;
  }
  return allowed;
}

function controllerContext(store: ProjectStore, agent: AgentRecord, activationId: string): ControllerContext {
  return {
    store,
    agent,
    activationId,
    recordSignal: (input) => {
      store.recordSignal({ kind: input.kind, sourceAgent: agent.id, sourceActivation: activationId, targetAgent: input.targetAgent, targetChannel: input.targetChannel, priority: input.priority, payload: input.payload ?? {}, status: input.status, usefulEffect: input.usefulEffect });
    },
  };
}

function webuiContext(store: ProjectStore, toolpackId: string): ToolWebuiContext {
  return {
    store,
    project: store.project,
    toolpackId,
    recordSignal: (input) => {
      store.recordSignal({ kind: input.kind, targetAgent: input.targetAgent, targetChannel: input.targetChannel, priority: input.priority, payload: input.payload ?? {}, status: input.status, usefulEffect: input.usefulEffect });
    },
  };
}

function builtinToolpack(id: string): ResolvedToolpack {
  const toolpack = BUILTIN_TOOLPACKS[id];
  if (!toolpack) throw new Error(`Unknown built-in toolpack: ${id}`);
  return { id: toolpack.id, kind: "builtin", runnerModule: `builtin:${toolpack.id}`, tools: toolpack.tools, webui: toolpack.webui };
}

async function localToolpack(root: string, expectedId: string | undefined): Promise<ResolvedToolpack> {
  const manifestPath = path.join(root, "suzumio.toolpack.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const id = stringField(manifest.id, "id");
  assertToolpackId(id);
  if (expectedId && expectedId !== id) throw new Error(`Toolpack id mismatch: expected ${expectedId}, got ${id}`);
  const tools = toolsField(manifest.tools);
  const webui = webuiField(manifest.webui);
  const runner = path.resolve(root, optionalString(manifest.runner) ?? "runner.mjs");
  const controller = path.resolve(root, optionalString(manifest.controller) ?? "controller.mjs");
  if (tools.length === 0 && webui.length === 0) throw new Error(`Toolpack ${id} declares no tools or WebUI entries`);
  if (tools.length > 0) assertInside(runner, root);
  assertInside(controller, root);
  if (tools.length > 0) assertMjs(runner, "runner");
  assertMjs(controller, "controller");
  if (tools.length > 0) await stat(runner);
  await stat(controller);
  return { id, kind: "local", root, runnerModule: runner, controllerModule: controller, tools, webui };
}

function assertNoDuplicateTools(toolpacks: ResolvedToolpack[]): void {
  const seen = new Map<string, string>();
  for (const toolpack of toolpacks) {
    for (const tool of toolpack.tools) {
      const previous = seen.get(tool.name);
      if (previous) throw new Error(`Duplicate tool ${tool.name} in ${previous} and ${toolpack.id}`);
      seen.set(tool.name, toolpack.id);
    }
  }
}

async function externalSupport(toolpack: ResolvedToolpack, tool: string, context: ControllerContext, input: unknown): Promise<ToolCallOutput> {
  if (!toolpack.controllerModule) throw new Error(`Toolpack ${toolpack.id} has no controller module`);
  const module = await import(pathToFileURL(toolpack.controllerModule).href);
  const factory = module.createControllerToolpack ?? module.default;
  if (typeof factory !== "function") throw new Error(`Controller module for ${toolpack.id} must export createControllerToolpack`);
  const instance = await factory(context);
  const support = instance?.support;
  if (typeof support === "function") return support(tool, input);
  const handlers = instance?.tools ?? instance;
  const handler = handlers?.[tool];
  if (typeof handler !== "function") return { title: "toolpack support", output: `Controller side for ${toolpack.id} did not handle ${tool}.`, metadata: { toolpack: toolpack.id, tool } };
  return handler(input);
}

async function externalWebui(toolpack: ResolvedToolpack, entryId: string, context: ToolWebuiContext, input: unknown): Promise<ToolCallOutput> {
  if (!toolpack.controllerModule) throw new Error(`Toolpack ${toolpack.id} has no controller module`);
  const module = await import(pathToFileURL(toolpack.controllerModule).href);
  const factory = module.createWebuiToolpack;
  const instance = typeof factory === "function" ? await factory(context) : module.webui ?? module.default;
  if (typeof instance === "function") return instance(entryId, input);
  const handlers = instance?.webui ?? instance?.tools ?? instance;
  const handler = handlers?.[entryId];
  if (typeof handler !== "function") return { title: "toolpack webui", output: `WebUI side for ${toolpack.id} did not handle ${entryId}.`, metadata: { toolpack: toolpack.id, entryId } };
  return handler(input);
}

function builtinSupport(toolpackId: string, tool: string, context: ControllerContext, input: unknown): Promise<ToolCallOutput> {
  const handler = BUILTIN_TOOLPACKS[toolpackId]?.support[tool];
  if (!handler) return Promise.resolve({ title: "toolpack support", output: `Controller side for ${toolpackId} did not handle ${tool}.`, metadata: { toolpack: toolpackId, tool } });
  return handler(context, input);
}

function builtinWebui(toolpackId: string, entryId: string, context: ToolWebuiContext, input: unknown): Promise<ToolCallOutput> {
  const handler = BUILTIN_TOOLPACKS[toolpackId]?.webuiSupport[entryId];
  if (!handler) return Promise.resolve({ title: "toolpack webui", output: `WebUI side for ${toolpackId} did not handle ${entryId}.`, metadata: { toolpack: toolpackId, entryId } });
  return handler(context, input);
}

const BUILTIN_TOOLPACKS: Record<string, BuiltinToolpack> = {
  core: {
    id: "core",
    tools: [messagesSendDefinition(), waitForSignalDefinition(), completionSubmitDefinition(), fileReadDefinition(), fileWriteDefinition(), filePatchDefinition()],
    support: {
      "messages.send": messagesSendSupport,
      "coordination.wait_for_signal": waitForSignalSupport,
      "completion.submit": completionSubmitSupport,
    },
    webui: [
      projectStatsWebuiDefinition(),
      messagesConversationWebuiDefinition(),
      messagesSendWebuiDefinition(),
      coordinationSignalsWebuiDefinition(),
      completionReportWebuiDefinition(),
      fileActivityWebuiDefinition(),
    ],
    webuiSupport: {
      "project.stats": projectStatsWebuiSupport,
      "messages.conversation": messagesConversationWebuiSupport,
      "messages.send": messagesSendWebuiSupport,
      "coordination.signals": coordinationSignalsWebuiSupport,
      "completion.report": completionReportWebuiSupport,
      "file.activity": fileActivityWebuiSupport,
    },
  },
  shell: { id: "shell", tools: [shellExecDefinition()], support: {}, webui: [shellActivityWebuiDefinition()], webuiSupport: { "shell.activity": shellActivityWebuiSupport } },
  web: { id: "web", tools: [webFetchDefinition()], support: {}, webui: [webActivityWebuiDefinition()], webuiSupport: { "web.activity": webActivityWebuiSupport } },
};

function projectStatsWebuiDefinition(): ToolWebuiDefinition {
  return {
    id: "project.stats",
    title: "Project statistics",
    description: "Live project, agent, activation, message, history, and tool-call counts from Suzumio's SQLite store.",
    kind: "panel",
  };
}

async function projectStatsWebuiSupport({ store }: ToolWebuiContext): Promise<ToolCallOutput> {
  const row = store.projectRow();
  const stats = store.projectStats();
  const agents = store.listAgents();
  const agentStatuses = countBy(agents.map((agent) => agent.status));
  const metrics = [
    { label: "Status", value: String(row.status) },
    { label: "Agents", value: agents.length, description: formatCounts(agentStatuses) },
    { label: "Messages", value: stats.messageCount },
    { label: "Activations", value: stats.activationCount, description: `${stats.runningActivationCount} running, ${stats.failedActivationCount} failed` },
    { label: "Tool calls", value: stats.toolCallCount },
    { label: "History", value: stats.historyMessageCount, description: `${stats.historyCompactionCount} compactions` },
    { label: "Events", value: stats.eventCount },
  ];
  return {
    title: "Project statistics",
    output: metrics.map((item) => `${item.label}: ${item.value}${item.description ? ` (${item.description})` : ""}`).join("\n"),
    metadata: { metrics, stats, agentStatuses, projectStatus: row.status },
  };
}

function messagesConversationWebuiDefinition(): ToolWebuiDefinition {
  return {
    id: "messages.conversation",
    title: "Agent conversation",
    description: "Inspect direct messages between two participants, such as user and pm or two agents.",
    kind: "panel",
    submitLabel: "Load conversation",
    inputSchema: {
      type: "object",
      properties: {
        agentA: { type: "string", default: "user", description: "First participant id. Use user for user-originated messages." },
        agentB: { type: "string", default: "pm", description: "Second participant id." },
        limit: { type: "number", default: 40, description: "Maximum direct messages to show." },
      },
      additionalProperties: false,
    },
  };
}

async function messagesConversationWebuiSupport({ store }: ToolWebuiContext, input: unknown): Promise<ToolCallOutput> {
  const args = objectInput(input);
  const agentA = optionalString(args.agentA);
  const agentB = optionalString(args.agentB);
  const limit = boundedNumber(args.limit, 40, 200);
  const agents = store.listAgents();
  const roster = ["user", ...agents.map((agent) => agent.id)].join(", ");
  if (!agentA || !agentB) {
    const pairs = recentDirectMessagePairs(store, 12);
    const output = [
      "Choose two participants and refresh this panel.",
      `Known participants: ${roster}`,
      "",
      "Recent direct pairs:",
      ...(pairs.length ? pairs.map((pair) => `- ${pair.sender} -> ${pair.recipient}: ${pair.count} messages, last ${pair.lastAt}`) : ["- none"]),
    ].join("\n");
    return { title: "Agent conversation", output, metadata: { participants: roster, recentPairs: pairs } };
  }
  const messages = directConversationMessages(store, agentA, agentB, limit);
  const metrics = [
    { label: "Messages", value: messages.length, description: `${agentA} <-> ${agentB}` },
    { label: "Participants", value: 2, description: `${agentA}, ${agentB}` },
  ];
  const output = [
    `Conversation: ${agentA} <-> ${agentB}`,
    `Known participants: ${roster}`,
    "",
    ...(messages.length ? messages.map(formatMessageRecord) : ["No direct messages found for this pair."]),
  ].join("\n\n");
  return { title: "Agent conversation", output, metadata: { metrics, messages } };
}

function messagesSendWebuiDefinition(): ToolWebuiDefinition {
  return {
    id: "messages.send",
    title: "Send agent message",
    description: "Send a user-facing message to an agent or channel. This creates the same scheduler signal as the public messages API.",
    kind: "action",
    submitLabel: "Send message",
    inputSchema: {
      type: "object",
      properties: {
        sender: { type: "string", default: "user", description: "Sender id. Use user for human-originated messages." },
        recipient: { type: "string", description: "Direct recipient agent id, or user. Leave empty to use the coordinator or first agent." },
        channel: { type: "string", description: "Optional project channel such as #project. Leave recipient empty when using a channel." },
        priority: { type: "string", enum: ["P0", "P1", "P2"], default: "P2", description: "Message priority." },
        body: { type: "string", description: "Markdown body to send." },
      },
      required: ["body"],
      additionalProperties: false,
    },
  };
}

async function messagesSendWebuiSupport({ store }: ToolWebuiContext, input: unknown): Promise<ToolCallOutput> {
  const args = objectInput(input);
  const agents = store.listAgents();
  const sender = optionalString(args.sender) ?? "user";
  if (sender !== "user" && !agents.some((agent) => agent.id === sender)) throw new Error(`Unknown sender: ${sender}`);
  const channel = optionalString(args.channel);
  let recipient = optionalString(args.recipient);
  if (!recipient && !channel) {
    const coordinator = store.config().communication?.coordinatorAgent ?? "pm";
    recipient = agents.some((agent) => agent.id === coordinator) ? coordinator : agents[0]?.id;
  }
  const priority = priorityArg(args.priority ?? "P2");
  const body = stringArg(args, "body");
  const message = store.sendMessage({ sender, recipient, channel, priority, body });
  const target = message.recipient ?? message.channel ?? "broadcast";
  const metrics = [
    { label: "Priority", value: message.priority },
    { label: "Body chars", value: message.body.length },
  ];
  return {
    title: "message sent",
    output: [`Message sent: ${message.id}`, `Route: ${message.sender} -> ${target}`, `Priority: ${message.priority}`, "", message.body].join("\n"),
    metadata: { metrics, messageId: message.id, message },
  };
}

function coordinationSignalsWebuiDefinition(): ToolWebuiDefinition {
  return {
    id: "coordination.signals",
    title: "Signal queue",
    description: "Inspect pending, delivered, and closed scheduler signals created by messages and coordination tools.",
    kind: "panel",
    submitLabel: "Refresh signals",
    inputSchema: {
      type: "object",
      properties: {
        targetAgent: { type: "string", description: "Optional target agent filter." },
        status: { type: "string", enum: ["pending", "delivered", "closed"], description: "Optional signal status filter." },
        limit: { type: "number", default: 25, description: "Maximum recent signals to show." },
      },
      additionalProperties: false,
    },
  };
}

async function coordinationSignalsWebuiSupport({ store }: ToolWebuiContext, input: unknown): Promise<ToolCallOutput> {
  const args = objectInput(input);
  const targetAgent = optionalString(args.targetAgent);
  const status = signalStatusArg(args.status);
  const limit = boundedNumber(args.limit, 25, 100);
  const aggregates = signalAggregateRows(store);
  const recent = recentSignalRows(store, { targetAgent, status, limit });
  const statusCounts = signalStatusCounts(aggregates);
  const metrics = [
    { label: "Pending", value: statusCounts.pending ?? 0 },
    { label: "Delivered", value: statusCounts.delivered ?? 0 },
    { label: "Closed", value: statusCounts.closed ?? 0 },
    { label: "Recent", value: recent.length, description: targetAgent ? `target ${targetAgent}` : "all targets" },
  ];
  const output = [
    "Signal summary:",
    ...aggregates.map((row) => `- ${row.status} ${row.priority}: ${row.count}`),
    "",
    "Recent signals:",
    ...(recent.length ? recent.map(formatSignalRecord) : ["- none"]),
  ].join("\n");
  return { title: "Signal queue", output, metadata: { metrics, aggregates, recent } };
}

function completionReportWebuiDefinition(): ToolWebuiDefinition {
  return {
    id: "completion.report",
    title: "Completion report",
    description: "Show the current completion.submit state and the submitted report path/content when present.",
    kind: "panel",
  };
}

async function completionReportWebuiSupport({ store }: ToolWebuiContext): Promise<ToolCallOutput> {
  const row = store.projectRow();
  const reportPath = typeof row.submitted_report === "string" && row.submitted_report ? row.submitted_report : undefined;
  if (!reportPath) {
    const metrics = [{ label: "Submit status", value: "not submitted", description: String(row.status) }];
    return { title: "Completion report", output: `Project status: ${String(row.status)}\nNo completion.submit report has been recorded.`, metadata: { metrics, projectStatus: row.status } };
  }
  let report = "";
  let readError: string | undefined;
  try {
    report = await readFile(reportPath, "utf8");
  } catch (cause) {
    readError = cause instanceof Error ? cause.message : String(cause);
  }
  const metrics = [
    { label: "Submit status", value: "submitted", description: String(row.status) },
    { label: "Report chars", value: report.length },
  ];
  const output = readError
    ? `Project status: ${String(row.status)}\nReport path: ${reportPath}\nRead error: ${readError}`
    : `Project status: ${String(row.status)}\nReport path: ${reportPath}\n\n${truncateForStatus(report, 20_000) ?? ""}`;
  return { title: "Completion report", output, metadata: { metrics, reportPath, projectStatus: row.status, readError } };
}

const FILE_TOOL_NAMES = ["file.read", "file.write", "file.patch"];

function fileActivityWebuiDefinition(): ToolWebuiDefinition {
  return {
    id: "file.activity",
    title: "File tool activity",
    description: "Aggregate file.read, file.write, and file.patch calls without exposing file contents.",
    kind: "panel",
    submitLabel: "Refresh file stats",
    inputSchema: { type: "object", properties: { limit: { type: "number", default: 20, description: "Maximum recent file tool calls to show." } }, additionalProperties: false },
  };
}

async function fileActivityWebuiSupport({ store }: ToolWebuiContext, input: unknown): Promise<ToolCallOutput> {
  return toolActivityReport(store, "File tool activity", FILE_TOOL_NAMES, input, summarizeFileToolInput);
}

function shellActivityWebuiDefinition(): ToolWebuiDefinition {
  return {
    id: "shell.activity",
    title: "Shell activity",
    description: "Aggregate shell.exec calls, recent commands, failures, and running commands.",
    kind: "panel",
    submitLabel: "Refresh shell stats",
    inputSchema: { type: "object", properties: { limit: { type: "number", default: 20, description: "Maximum recent shell commands to show." } }, additionalProperties: false },
  };
}

async function shellActivityWebuiSupport({ store }: ToolWebuiContext, input: unknown): Promise<ToolCallOutput> {
  return toolActivityReport(store, "Shell activity", ["shell.exec"], input, summarizeShellInput);
}

function webActivityWebuiDefinition(): ToolWebuiDefinition {
  return {
    id: "web.activity",
    title: "Web fetch activity",
    description: "Aggregate web.fetch calls, recent URLs, failures, and running fetches.",
    kind: "panel",
    submitLabel: "Refresh web stats",
    inputSchema: { type: "object", properties: { limit: { type: "number", default: 20, description: "Maximum recent web.fetch calls to show." } }, additionalProperties: false },
  };
}

async function webActivityWebuiSupport({ store }: ToolWebuiContext, input: unknown): Promise<ToolCallOutput> {
  return toolActivityReport(store, "Web fetch activity", ["web.fetch"], input, summarizeWebInput);
}

function messagesSendDefinition(): ToolDefinition {
  return {
    name: "messages.send",
    description: "Send a Markdown message to another agent, the user, or a configured project channel. Default priority is P2. Use P2 for routine status, handoffs, and review routing. Use P1 only for concrete blockers, urgent policy/user corrections, or messages that immediately unblock active work. Use P0 only for true interrupt-worthy emergencies such as human stop, destructive conflict, or secret/safety issues. Delivery is immediate; do not send ACK-only messages or request confirmation of receipt.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Direct recipient agent id, or user. Non-PM agents usually report to pm unless the signal names another recipient." },
        channel: { type: "string", description: "Project channel such as #project. Use either recipient or channel." },
        priority: { type: "string", enum: ["P0", "P1", "P2"], default: "P2", description: "Message priority. Use P2 by default for routine status, handoffs, and review routing. Use P1 only for concrete blockers, urgent policy/user corrections, or messages that immediately unblock active work. Use P0 only for true interrupt-worthy emergencies." },
        body: { type: "string", description: "Markdown body containing results, exact artifact paths, exact commands/results, next action requested, or blocker. Do not use this for ACK-only text such as received/noted/standing by." },
      },
      required: ["body"],
      additionalProperties: false,
    },
  };
}

async function messagesSendSupport({ store, agent, activationId }: ControllerContext, input: unknown): Promise<ToolCallOutput> {
  const args = objectInput(input);
  const body = stringArg(args, "body");
  const priority = priorityArg(args.priority ?? "P2");
  const recipient = optionalString(args.recipient);
  const channel = optionalString(args.channel);
  validateMessagePolicy(store.config(), agent, recipient, channel, priority);
  const message = store.sendMessage({ sender: agent.id, recipient, channel, priority, body, sourceAgent: agent.id, sourceActivation: activationId });
  return { title: "message sent", output: `Message sent and delivered: ${message.id}`, metadata: { messageId: message.id } };
}

function fileReadDefinition(): ToolDefinition {
  return {
    name: "file.read",
    description: "Read a file or directory from /workspace, /artifacts, or /mnt. Prefer this over shell commands like cat/sed/head/tail. For large files, use offset/limit and inspect focused ranges.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path under /workspace, /artifacts, or /mnt, or a path relative to /workspace." },
        offset: { type: "number", description: "1-indexed line offset for file reads. Defaults to 1." },
        limit: { type: "number", description: "Maximum lines or directory entries returned. Defaults to 200, capped at 2000." },
        maxBytes: { type: "number", description: "Maximum output bytes returned, capped at 100000. Defaults to 50000." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };
}

function fileWriteDefinition(): ToolDefinition {
  return {
    name: "file.write",
    description: "Write a complete file under /workspace or your own /artifacts/<agent-id> directory. Use for new files or deliberate full rewrites. For targeted edits, prefer file.patch.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path under /workspace or your own /artifacts/<agent-id> directory, or a path relative to /workspace." },
        content: { type: "string", description: "Full file content to write." },
        createDirs: { type: "boolean", default: false, description: "Create missing parent directories." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  };
}

function filePatchDefinition(): ToolDefinition {
  return {
    name: "file.patch",
    description: "Apply one or more exact text edits under /workspace or your own /artifacts/<agent-id> directory. Prefer this for modifying existing files. Each update must match existing text exactly, which prevents accidental broad rewrites.",
    inputSchema: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          description: "Patch operations. Use op=add to create a file, op=update for exact search/replace, or op=delete to remove a file.",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["add", "update", "delete"] },
              path: { type: "string" },
              content: { type: "string", description: "Content for add operations." },
              search: { type: "string", description: "Exact text to replace for update operations." },
              replace: { type: "string", description: "Replacement text for update operations." },
              replaceAll: { type: "boolean", default: false, description: "Replace all occurrences instead of exactly one." },
              createDirs: { type: "boolean", default: false, description: "Create missing parent directories for add operations." },
            },
            required: ["op", "path"],
            additionalProperties: false,
          },
        },
      },
      required: ["operations"],
      additionalProperties: false,
    },
  };
}

function waitForSignalDefinition(): ToolDefinition {
  return {
    name: "coordination.wait_for_signal",
    description: "Declare that useful progress now depends on future signals. Call this after sending required messages, not instead of reporting. Non-PM agents notify pm by default only when a pm agent exists; pm records a wait state without self-waking. If you already sent the coordinator your result in this activation, set notifyPm:false to avoid a duplicate wake-up.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "What future signal or external response you are waiting for." },
        pm: { type: "string", description: "Coordinator agent id to notify. Defaults to pm." },
        notifyPm: { type: "boolean", description: "Whether to send a direct message to the coordinator when that agent exists. Defaults to true for non-PM agents and false for the PM. Use false after you already sent the coordinator your current result." },
      },
      additionalProperties: false,
    },
  };
}

async function waitForSignalSupport({ store, agent, activationId }: ControllerContext, input: unknown): Promise<ToolCallOutput> {
  const args = objectInput(input);
  const config = store.config();
  const coordinator = (config.communication ?? { coordinatorAgent: "pm" }).coordinatorAgent;
  const reason = optionalString(args.reason) ?? "Waiting for future signals.";
  const pm = optionalString(args.pm) ?? coordinator;
  const notifyPm = optionalBoolean(args.notifyPm) ?? agent.id !== pm;
  let messageId: string | undefined;
  let notifiedAgent: string | undefined;
  if (notifyPm && agent.id !== pm && store.listAgents().some((item) => item.id === pm)) {
    const message = store.sendMessage({ sender: agent.id, recipient: pm, priority: "P2", body: `Waiting for future signals.\n\nReason: ${reason}`, sourceAgent: agent.id, sourceActivation: activationId });
    messageId = message.id;
    notifiedAgent = pm;
  }
  store.recordSignal({ kind: "coordination.wait_for_signal", sourceAgent: agent.id, sourceActivation: activationId, payload: { reason, notifiedAgent, messageId }, status: "closed", usefulEffect: true });
  return {
    title: "waiting for signal",
    output: messageId ? `Wait state recorded; notified ${notifiedAgent} with ${messageId}.` : "Wait state recorded. Future signals will wake the agent.",
    metadata: { reason, notifiedAgent, messageId },
  };
}

function completionSubmitDefinition(): ToolDefinition {
  return {
    name: "completion.submit",
    description: "Submit the final Markdown project report for user approval. Use this only when you have incorporated the relevant current information and are no longer waiting for substantive replies you requested.",
    inputSchema: { type: "object", properties: { report: { type: "string" } }, required: ["report"], additionalProperties: false },
  };
}

async function completionSubmitSupport({ store, agent, activationId }: ControllerContext, input: unknown): Promise<ToolCallOutput> {
  const args = objectInput(input);
  const reportPath = await store.submitProject({ agentId: agent.id, report: stringArg(args, "report"), activationId });
  return { title: "project submitted", output: `Project submitted for user approval. Report: ${reportPath}`, metadata: { reportPath } };
}

function shellExecDefinition(): ToolDefinition {
  return {
    name: "shell.exec",
    description: "Execute a bash command inside the Docker runner container. Runs in /workspace by default. This does not notify anyone; report important output with messages.send before ending.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to run inside the runner container." },
        cwd: { type: "string", description: "Working directory inside the container. Defaults to /workspace." },
        timeoutMs: { type: "number", description: "Command timeout in milliseconds, capped at 300000." },
        maxOutputBytes: { type: "number", description: "Maximum combined stdout/stderr bytes returned, capped at 200000." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  };
}

function webFetchDefinition(): ToolDefinition {
  return {
    name: "web.fetch",
    description: "Fetch an HTTP(S) URL from inside the Docker runner container and return response text.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        maxBytes: { type: "number", description: "Maximum characters to return, capped at 100000." },
        timeoutMs: { type: "number", description: "Request timeout in milliseconds, capped at 120000." },
        format: { type: "string", enum: ["text", "raw"], default: "text" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  };
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object");
  return input as Record<string, unknown>;
}

function stringArg(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${key} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "boolean") return value;
  throw new Error(`Expected boolean, got ${String(value)}`);
}

function priorityArg(value: unknown): MessagePriority {
  if (value === "P0" || value === "P1" || value === "P2") return value;
  throw new Error(`Invalid priority: ${String(value)}`);
}

function signalStatusArg(value: unknown): "pending" | "delivered" | "closed" | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "pending" || value === "delivered" || value === "closed") return value;
  throw new Error(`Invalid signal status: ${String(value)}`);
}

function toolCallStatusArg(value: unknown): "running" | "completed" | "failed" | undefined {
  if (value === "running" || value === "completed" || value === "failed") return value;
  return undefined;
}

function parseJsonObject(value: unknown): JsonObject {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function truncateOneLine(value: string, maxChars: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, maxChars).trimEnd()}...`;
}

function validateMessagePolicy(config: ProjectConfig, agent: AgentRecord, recipient: string | undefined, channel: string | undefined, priority: MessagePriority): void {
  const communication = config.communication ?? { coordinatorAgent: "pm", restrictNonCoordinatorToCoordinator: false, nonCoordinatorMaxPriority: "P2" as MessagePriority, pmRoutineVerifierPriority: "P2" as MessagePriority };
  if (!communication.restrictNonCoordinatorToCoordinator || agent.id === communication.coordinatorAgent) return;
  if (channel) throw new Error(`Communication policy allows non-coordinator agents to send direct messages only to ${communication.coordinatorAgent}; channels are not allowed.`);
  if (recipient !== communication.coordinatorAgent) throw new Error(`Communication policy allows non-coordinator agents to message only ${communication.coordinatorAgent}.`);
  if (priorityRank(priority) < priorityRank(communication.nonCoordinatorMaxPriority)) throw new Error(`Communication policy allows non-coordinator priorities ${communication.nonCoordinatorMaxPriority} or lower; ${priority} is not allowed.`);
}

function priorityRank(priority: MessagePriority): number {
  return priority === "P0" ? 0 : priority === "P1" ? 1 : 2;
}

function boundedNumber(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("Expected a positive number");
  return Math.min(Math.floor(value), max);
}

function stringField(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Toolpack manifest ${key} is required`);
  return value;
}

function toolsField(value: unknown): ToolDefinition[] {
  if (!Array.isArray(value)) throw new Error("Toolpack manifest tools must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Tool definition must be an object");
    const tool = item as Record<string, unknown>;
    const inputSchema = tool.inputSchema;
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) throw new Error("Tool definition inputSchema must be an object");
    return { name: stringField(tool.name, "tool.name"), description: stringField(tool.description, "tool.description"), inputSchema: inputSchema as JsonObject };
  });
}

function webuiField(value: unknown): ToolWebuiDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Toolpack manifest webui must be an array");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Toolpack WebUI definition must be an object");
    const entry = item as Record<string, unknown>;
    const id = stringField(entry.id, "webui.id");
    assertToolpackId(id);
    if (seen.has(id)) throw new Error(`Duplicate WebUI entry ${id}`);
    seen.add(id);
    const inputSchema = entry.inputSchema;
    if (inputSchema !== undefined && (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema))) throw new Error("Toolpack WebUI inputSchema must be an object");
    return {
      id,
      title: stringField(entry.title, "webui.title"),
      description: optionalString(entry.description),
      kind: webuiKind(entry.kind),
      inputSchema: inputSchema as JsonObject | undefined,
      submitLabel: optionalString(entry.submitLabel),
    };
  });
}

function webuiKind(value: unknown): "panel" | "action" {
  if (value === undefined || value === "panel") return "panel";
  if (value === "action") return "action";
  throw new Error(`Invalid WebUI entry kind: ${String(value)}`);
}

function assertInside(filePath: string, root: string): void {
  const resolved = path.resolve(filePath);
  const base = path.resolve(root);
  if (resolved === base || resolved.startsWith(base + path.sep)) return;
  throw new Error(`Path is outside toolpack root: ${filePath}`);
}

function assertMjs(filePath: string, label: string): void {
  if (path.extname(filePath) === ".mjs") return;
  throw new Error(`Local toolpack ${label} module must be a .mjs file: ${filePath}`);
}

function assertToolpackId(id: string): void {
  if (/^[A-Za-z0-9_.-]+$/.test(id)) return;
  throw new Error(`Toolpack id must contain only A-Z, a-z, 0-9, dot, underscore, or dash: ${id}`);
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([key, value]) => `${value} ${key}`).join(", ") || "none";
}
