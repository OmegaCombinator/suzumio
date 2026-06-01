import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { ProjectStore } from "./store.js";
import { ToolSupportHost } from "./tools.js";
import { NonPreemptiveSignalScheduler } from "./scheduler.js";
import type { ActivationContextSnapshot, ActivationRecord, AgentRecord, MessagePriority, MessageRecord, RunnerActivationOutput } from "./types.js";

export type ServeOptions = {
  host: string;
  port: number;
  root?: string;
  scheduler?: boolean;
};

export async function serveSuzumio(options: ServeOptions): Promise<http.Server> {
  const scheduler = new NonPreemptiveSignalScheduler(options.root);
  const toolSupport = new ToolSupportHost(options.root);
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, { root: options.root, schedulerEngine: scheduler, toolSupport }).catch((error) => {
      text(response, error instanceof Error ? error.message : String(error), 500);
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  if (options.scheduler !== false) {
    setInterval(() => void scheduler.tickAll().catch((error) => console.warn("scheduler tick failed", error)), 2_000).unref();
    void scheduler.tickAll().catch(() => undefined);
  }
  console.log(`suzumio listening on http://${options.host}:${options.port}`);
  return server;
}

const WEBUI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "webui");

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  ctx: { root?: string; schedulerEngine: NonPreemptiveSignalScheduler; toolSupport: ToolSupportHost },
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (request.method === "GET" && url.pathname === "/health") return json(response, { healthy: true });
  if (request.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/assets/"))) return serveWebui(response, url.pathname);
  if (request.method === "POST" && url.pathname === "/runner/tool-calls/start") return json(response, await ctx.toolSupport.startToolCall(await readBody(request)));
  if (request.method === "POST" && url.pathname === "/runner/tool-calls/finish") return json(response, await ctx.toolSupport.finishToolCall(await readBody(request)));
  if (request.method === "POST" && url.pathname === "/runner/signals") return json(response, await ctx.toolSupport.recordRunnerSignal(await readBody(request)));
  if (request.method === "POST" && parts[0] === "toolpacks" && parts[2] === "support") return json(response, await ctx.toolSupport.support(parts[1]!, await readBody(request)));
  if (request.method === "POST" && url.pathname === "/activation-context") return json(response, await submitActivationContext(await readBody(request), ctx.root));
  if (request.method === "POST" && url.pathname === "/activation-output") return json(response, await submitActivationOutput(await readBody(request), ctx.root));

  if (request.method === "GET" && url.pathname === "/api/projects") return json(response, await listProjects(ctx.root));
  if (parts[0] !== "api" || parts[1] !== "projects" || !parts[2]) return json(response, { error: "not found" }, 404);

  const project = parts[2];
  const store = new ProjectStore(project, ctx.root);
  try {
    if (request.method === "GET" && parts.length === 3) return json(response, projectSummary(store));
    if (request.method === "GET" && parts[3] === "agents") return json(response, store.listAgents().map(publicAgent));
    if (request.method === "GET" && parts[3] === "messages") return json(response, store.listMessages(limit(url, 100)).map(publicMessage));
    if (request.method === "GET" && parts[3] === "events") return json(response, store.listEvents(limit(url, 200)).map(publicEvent));
    if (request.method === "GET" && parts[3] === "activations" && parts[4] && parts[5] === "context") return json(response, activationContext(store, parts[4]));
    if (request.method === "GET" && parts[3] === "activations") return json(response, store.listActivations(limit(url, 100)).map(publicActivation));
    if (request.method === "GET" && parts[3] === "tool-calls") return json(response, store.listToolCalls(limit(url, 100)).map(publicToolCall));
    if (request.method === "GET" && parts[3] === "config" && parts[4] === "resolved") return text(response, await readFile(store.paths.resolvedConfig, "utf8"));
    if (request.method === "GET" && parts[3] === "report") return text(response, await reportText(store));
    if (request.method === "GET" && parts[3] === "stream") return streamEvents(response, store, url);

    if (request.method === "POST" && parts[3] === "start") {
      store.setProjectStatus("running");
      await ctx.schedulerEngine.tickProject(project);
      return json(response, projectSummary(store));
    }
    if (request.method === "POST" && parts[3] === "stop") {
      store.setProjectStatus("stopped");
      return json(response, projectSummary(store));
    }
    if (request.method === "POST" && parts[3] === "approve") {
      store.setProjectStatus("completed");
      return json(response, projectSummary(store));
    }
    if (request.method === "POST" && parts[3] === "request-changes") {
      const body = await readBody<Record<string, unknown>>(request);
      store.setProjectStatus("running");
      store.sendMessage({ sender: "user", recipient: optionalString(body.recipient) ?? "pm", priority: "P1", body: requiredString(body.body, "body") });
      await ctx.schedulerEngine.tickProject(project);
      return json(response, projectSummary(store));
    }
    if (request.method === "POST" && parts[3] === "messages") {
      const body = await readBody<Record<string, unknown>>(request);
      const message = store.sendMessage({ sender: optionalString(body.sender) ?? "user", recipient: optionalString(body.recipient), channel: optionalString(body.channel), priority: priority(optionalString(body.priority) ?? "P1"), body: requiredString(body.body, "body") });
      await ctx.schedulerEngine.tickProject(project);
      return json(response, message);
    }
  } finally {
    store.close();
  }
  return json(response, { error: "not found" }, 404);
}

async function submitActivationOutput(body: Record<string, unknown>, root?: string): Promise<Record<string, unknown>> {
  const project = requiredString(body.project, "project");
  const agentId = requiredString(body.agentId, "agentId");
  const activationId = requiredString(body.activationId, "activationId");
  const token = requiredString(body.token, "token");
  const output = outputBody(body.output);
  const store = new ProjectStore(project, root);
  try {
    const agent = store.requireAgent(agentId);
    if (agent.token !== token) throw new Error("Invalid agent token");
    const activation = store.activation(activationId);
    if (activation.agentId !== agent.id) throw new Error(`Activation ${activationId} does not belong to ${agent.id}`);
    if (activation.status !== "running") return { status: activation.status, activationId };
    store.completeActivation(activationId, output);
    return { status: "completed", activationId };
  } finally {
    store.close();
  }
}

async function submitActivationContext(body: Record<string, unknown>, root?: string): Promise<Record<string, unknown>> {
  const project = requiredString(body.project, "project");
  const agentId = requiredString(body.agentId, "agentId");
  const activationId = requiredString(body.activationId, "activationId");
  const token = requiredString(body.token, "token");
  const context = contextBody(body.context);
  const store = new ProjectStore(project, root);
  try {
    const agent = store.requireAgent(agentId);
    if (agent.token !== token) throw new Error("Invalid agent token");
    const activation = store.activation(activationId);
    if (activation.agentId !== agent.id) throw new Error(`Activation ${activationId} does not belong to ${agent.id}`);
    store.setActivationContext(activationId, context);
    return { status: "recorded", activationId };
  } finally {
    store.close();
  }
}

function outputBody(value: unknown): RunnerActivationOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("output is required");
  const output = value as Record<string, unknown>;
  return { text: requiredString(output.text, "output.text"), usage: typeof output.usage === "object" && output.usage && !Array.isArray(output.usage) ? (output.usage as Record<string, unknown>) : undefined };
}

function contextBody(value: unknown): ActivationContextSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("context is required");
  const context = value as Partial<ActivationContextSnapshot>;
  if (context.version !== 1 || context.kind !== "model-context" || !Array.isArray(context.messages)) throw new Error("Invalid activation context");
  return context as ActivationContextSnapshot;
}

async function listProjects(root?: string): Promise<Record<string, unknown>[]> {
  const names = await ProjectStore.list(root);
  return names.map((name) => {
    const store = new ProjectStore(name, root);
    try {
      return projectListSummary(store);
    } finally {
      store.close();
    }
  });
}

function projectListSummary(store: ProjectStore): Record<string, unknown> {
  const project = store.projectRow();
  return {
    ...publicProject(project, 1_000),
    stats: store.projectStats(),
    agents: store.listAgents().map(publicAgent),
    recentActivations: [],
    recentMessages: [],
  };
}

function projectSummary(store: ProjectStore): Record<string, unknown> {
  const project = store.projectRow();
  return {
    ...publicProject(project),
    stats: store.projectStats(),
    agents: store.listAgents().map(publicAgent),
    recentActivations: store.listActivations(10).map(publicActivation),
    recentMessages: store.listMessages(10).map(publicMessage),
  };
}

function publicProject(row: Record<string, unknown>, taskLimit?: number): Record<string, unknown> {
  const { config_json: _config, ...safe } = row;
  if (taskLimit && typeof safe.task === "string") safe.task = truncateText(safe.task, taskLimit);
  return safe;
}

function publicAgent(agent: AgentRecord): Record<string, unknown> {
  const { token: _token, prompt, ...safe } = agent;
  return { ...safe, promptChars: prompt.length };
}

function publicMessage(message: MessageRecord): Record<string, unknown> {
  return { ...message, body: truncateText(message.body, 12_000) };
}

function publicActivation(activation: ActivationRecord): Record<string, unknown> {
  return {
    id: activation.id,
    project: activation.project,
    agentId: activation.agentId,
    status: activation.status,
    containerName: activation.containerName,
    startedAt: activation.startedAt,
    completedAt: activation.completedAt,
    text: truncateText(activation.text, 8_000),
    error: truncateText(activation.error, 8_000),
    emittedMessages: activation.emittedMessages,
    usageJson: truncateText(activation.usageJson, 4_000),
    hasContext: Boolean(activation.contextJson),
  };
}

function publicToolCall(call: Record<string, unknown>): Record<string, unknown> {
  return {
    ...call,
    input_json: truncateText(typeof call.input_json === "string" ? call.input_json : undefined, 8_000),
    output: truncateText(typeof call.output === "string" ? call.output : undefined, 8_000),
    error: truncateText(typeof call.error === "string" ? call.error : undefined, 8_000),
  };
}

function publicEvent(event: Record<string, unknown>): Record<string, unknown> {
  return {
    ...event,
    data_json: truncateEventJson(typeof event.data_json === "string" ? event.data_json : "{}"),
  };
}

function activationContext(store: ProjectStore, activationId: string): Record<string, unknown> {
  const activation = store.activation(activationId);
  const context = activation.contextJson ? JSON.parse(activation.contextJson) as ActivationContextSnapshot : fallbackActivationContext(activation);
  return {
    activation: publicActivation(activation),
    activationPrompt: activation.prompt,
    context,
  };
}

function fallbackActivationContext(activation: ActivationRecord): ActivationContextSnapshot {
  return {
    version: 1,
    kind: "model-context",
    recordedAt: activation.startedAt,
    messageCount: 1,
    totalChars: activation.prompt.length,
    messages: [{ role: "user", content: activation.prompt, chars: activation.prompt.length }],
  };
}

async function reportText(store: ProjectStore): Promise<string> {
  const row = store.projectRow();
  const report = row.submitted_report;
  if (typeof report !== "string" || !report) return "No report submitted.\n";
  return readFile(report, "utf8");
}

function streamEvents(response: http.ServerResponse, store: ProjectStore, url: URL): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let seen = new Set<string>();
  const send = () => {
    const events = store.listEvents(limit(url, 100)).reverse() as Array<Record<string, unknown>>;
    for (const event of events) {
      const id = String(event.id);
      if (seen.has(id)) continue;
      seen.add(id);
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  send();
  const timer = setInterval(send, 2_000);
  response.on("close", () => clearInterval(timer));
}

async function readBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? (JSON.parse(text) as T) : ({} as T);
}

function limit(url: URL, fallback: number): number {
  const value = Number(url.searchParams.get("limit") ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.min(500, Math.floor(value)) : fallback;
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n\n[truncated ${value.length - maxChars} chars]`;
}

function truncateEventJson(value: string): string {
  try {
    return JSON.stringify(truncateJson(JSON.parse(value), 4_000));
  } catch {
    return JSON.stringify({ raw: truncateText(value, 4_000) });
  }
}

function truncateJson(value: unknown, maxStringChars: number): unknown {
  if (typeof value === "string") return truncateText(value, maxStringChars);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => truncateJson(item, maxStringChars));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) out[key] = truncateJson(item, key === "output" || key === "body" || key === "error" ? maxStringChars : 1_000);
  return out;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function priority(value: string): MessagePriority {
  if (value === "P0" || value === "P1" || value === "P2" || value === "P3") return value;
  throw new Error(`Invalid priority: ${value}`);
}

function json(response: http.ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value, null, 2) + "\n");
}

function text(response: http.ServerResponse, value: string, status = 200): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(value.endsWith("\n") ? value : value + "\n");
}

async function serveWebui(response: http.ServerResponse, pathname: string): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.resolve(WEBUI_DIR, relative);
  if (!filePath.startsWith(WEBUI_DIR + path.sep) && filePath !== path.join(WEBUI_DIR, "index.html")) return json(response, { error: "not found" }, 404);
  try {
    const body = await readFile(filePath);
    response.writeHead(200, { "content-type": contentType(filePath) });
    response.end(body);
  } catch {
    json(response, { error: "webui asset not found. Run npm run build:webui." }, 404);
  }
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}
