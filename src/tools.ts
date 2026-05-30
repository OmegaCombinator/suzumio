import { pathToFileURL } from "node:url";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentRecord, JsonObject, MessagePriority, ToolDefinition, ToolpackConfigEntry } from "./types.js";
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

type BuiltinToolpack = {
  id: string;
  tools: ToolDefinition[];
  support: Record<string, ControllerHandler>;
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

  async finishToolCall(input: ToolCallFinishInput): Promise<{ status: string }> {
    const store = new ProjectStore(input.project, this.root);
    try {
      const agent = this.authorize(store, input.agentId, input.token, input.activationId, { requireRunning: false });
      store.finishToolCallForActivation(input.toolCallId, agent.id, input.activationId, input.status, input.output, input.error);
      return { status: input.status };
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

function builtinToolpack(id: string): ResolvedToolpack {
  const toolpack = BUILTIN_TOOLPACKS[id];
  if (!toolpack) throw new Error(`Unknown built-in toolpack: ${id}`);
  return { id: toolpack.id, kind: "builtin", runnerModule: `builtin:${toolpack.id}`, tools: toolpack.tools };
}

async function localToolpack(root: string, expectedId: string | undefined): Promise<ResolvedToolpack> {
  const manifestPath = path.join(root, "suzumio.toolpack.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const id = stringField(manifest.id, "id");
  assertToolpackId(id);
  if (expectedId && expectedId !== id) throw new Error(`Toolpack id mismatch: expected ${expectedId}, got ${id}`);
  const tools = toolsField(manifest.tools);
  const runner = path.resolve(root, optionalString(manifest.runner) ?? "runner.mjs");
  const controller = path.resolve(root, optionalString(manifest.controller) ?? "controller.mjs");
  assertInside(runner, root);
  assertInside(controller, root);
  assertMjs(runner, "runner");
  assertMjs(controller, "controller");
  await stat(runner);
  await stat(controller);
  return { id, kind: "local", root, runnerModule: runner, controllerModule: controller, tools };
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

function builtinSupport(toolpackId: string, tool: string, context: ControllerContext, input: unknown): Promise<ToolCallOutput> {
  const handler = BUILTIN_TOOLPACKS[toolpackId]?.support[tool];
  if (!handler) return Promise.resolve({ title: "toolpack support", output: `Controller side for ${toolpackId} did not handle ${tool}.`, metadata: { toolpack: toolpackId, tool } });
  return handler(context, input);
}

const BUILTIN_TOOLPACKS: Record<string, BuiltinToolpack> = {
  core: {
    id: "core",
    tools: [messagesSendDefinition(), waitForSignalDefinition(), completionSubmitDefinition()],
    support: {
      "messages.send": messagesSendSupport,
      "coordination.wait_for_signal": waitForSignalSupport,
      "completion.submit": completionSubmitSupport,
    },
  },
  shell: { id: "shell", tools: [shellExecDefinition()], support: {} },
  web: { id: "web", tools: [webFetchDefinition()], support: {} },
};

function messagesSendDefinition(): ToolDefinition {
  return {
    name: "messages.send",
    description: "Send a Markdown message to another agent, the user, or a configured project channel.",
    inputSchema: {
      type: "object",
      properties: {
        recipient: { type: "string", description: "Direct recipient agent id, or user." },
        channel: { type: "string", description: "Project channel such as #project. Use either recipient or channel." },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"], default: "P2" },
        body: { type: "string" },
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
  const message = store.sendMessage({ sender: agent.id, recipient, channel, priority, body, sourceAgent: agent.id, sourceActivation: activationId });
  return { title: "message sent", output: `Message sent: ${message.id}`, metadata: { messageId: message.id } };
}

function waitForSignalDefinition(): ToolDefinition {
  return {
    name: "coordination.wait_for_signal",
    description: "Declare that useful progress now depends on future signals. Non-PM agents notify pm by default; pm records a wait state without self-waking. If you already sent pm your result in this activation, set notifyPm:false to avoid a duplicate wake-up.",
    inputSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "What future signal or external response you are waiting for." },
        pm: { type: "string", description: "Coordinator agent id to notify. Defaults to pm." },
        notifyPm: { type: "boolean", description: "Whether to send a direct message to the coordinator. Defaults to true for non-PM agents and false for the PM. Use false after you already sent the coordinator your current result." },
      },
      additionalProperties: false,
    },
  };
}

async function waitForSignalSupport({ store, agent, activationId }: ControllerContext, input: unknown): Promise<ToolCallOutput> {
  const args = objectInput(input);
  const reason = optionalString(args.reason) ?? "Waiting for future signals.";
  const pm = optionalString(args.pm) ?? "pm";
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
    description: "Submit the final Markdown project report for user approval. Use this only when you have incorporated the relevant current information and are no longer waiting for substantive replies you requested. If the roster shows an agent still running on work you requested, wait unless that work is explicitly irrelevant or superseded.",
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
    description: "Execute a bash command inside the Docker runner container. Runs in /workspace by default.",
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
  if (value === "P0" || value === "P1" || value === "P2" || value === "P3") return value;
  throw new Error(`Invalid priority: ${String(value)}`);
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
