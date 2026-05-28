import { readFile } from "node:fs/promises";
import type { AgentRecord, JsonObject, MessagePriority, ToolDefinition } from "./types.js";
import { ProjectStore } from "./store.js";

export type ToolCallInput = {
  project: string;
  agentId: string;
  turnId: string;
  token: string;
  tool: string;
  input: unknown;
};

export type ToolCallOutput = {
  title?: string;
  output: string;
  metadata?: JsonObject;
};

export type ToolContext = {
  store: ProjectStore;
  agent: AgentRecord;
  turnId: string;
};

export type ToolPlugin = {
  definition: ToolDefinition;
  execute: (context: ToolContext, input: unknown) => Promise<ToolCallOutput>;
};

export class ToolRegistry {
  private readonly tools = new Map<string, ToolPlugin>();

  constructor(plugins: ToolPlugin[] = []) {
    for (const plugin of plugins) this.register(plugin);
  }

  register(plugin: ToolPlugin): void {
    if (this.tools.has(plugin.definition.name)) throw new Error(`Duplicate tool: ${plugin.definition.name}`);
    this.tools.set(plugin.definition.name, plugin);
  }

  definitions(agent: AgentRecord): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition).filter((definition) => isAllowed(definition.name, agent.tools));
  }

  async execute(context: ToolContext, tool: string, input: unknown): Promise<ToolCallOutput> {
    const plugin = this.tools.get(tool);
    if (!plugin) throw new Error(`Unknown tool: ${tool}`);
    return plugin.execute(context, input);
  }
}

export const defaultToolRegistry = new ToolRegistry([
  messagesSendTool(),
  artifactsPublishTool(),
  artifactsListTool(),
  artifactsReadTool(),
  completionSubmitTool(),
  webFetchTool(),
]);

export function toolDefinitions(agent: AgentRecord, registry = defaultToolRegistry): ToolDefinition[] {
  return registry.definitions(agent);
}

export class ToolHost {
  constructor(private readonly root?: string, private readonly registry = defaultToolRegistry) {}

  async call(input: ToolCallInput): Promise<ToolCallOutput> {
    const store = new ProjectStore(input.project, this.root);
    try {
      const agent = store.requireAgent(input.agentId);
      if (agent.token !== input.token) throw new Error("Invalid agent token");
      if (!isAllowed(input.tool, agent.tools)) throw new Error(`Tool not allowed for ${agent.id}: ${input.tool}`);
      const toolCallId = store.recordToolCall({ turnId: input.turnId, agentId: agent.id, tool: input.tool, input: input.input, status: "running" });
      try {
        const result = await this.registry.execute({ store, agent, turnId: input.turnId }, input.tool, input.input);
        store.finishToolCall(toolCallId, "completed", result.output);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.finishToolCall(toolCallId, "failed", undefined, message);
        throw error;
      }
    } finally {
      store.close();
    }
  }
}

function messagesSendTool(): ToolPlugin {
  return {
    definition: {
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
    },
    execute: async ({ store, agent }, input) => {
      const args = objectInput(input);
      const body = stringArg(args, "body");
      const priority = priorityArg(args.priority ?? "P2");
      const recipient = optionalString(args.recipient);
      const channel = optionalString(args.channel);
      const message = store.sendMessage({ sender: agent.id, recipient, channel, priority, body });
      return { title: "message sent", output: `Message sent: ${message.id}`, metadata: { messageId: message.id } };
    },
  };
}

function artifactsPublishTool(): ToolPlugin {
  return {
    definition: {
      name: "artifacts.publish",
      description: "Publish a file from this agent workspace as a project artifact.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          name: { type: "string" },
          description: { type: "string" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    execute: async ({ store, agent, turnId }, input) => {
      const args = objectInput(input);
      const artifact = await store.publishArtifact({ creator: agent.id, turnId, workspacePath: agent.workspacePath, sourcePath: stringArg(args, "path"), name: optionalString(args.name), description: optionalString(args.description) });
      return { title: "artifact published", output: `Artifact published: ${artifact.id}`, metadata: artifact as JsonObject };
    },
  };
}

function artifactsListTool(): ToolPlugin {
  return {
    definition: {
      name: "artifacts.list",
      description: "List project artifacts published so far.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    execute: async ({ store }) => {
      const artifacts = store.listArtifacts(100);
      return { title: "artifacts", output: artifacts.length ? JSON.stringify(artifacts, null, 2) : "No artifacts published yet.", metadata: { count: artifacts.length } };
    },
  };
}

function artifactsReadTool(): ToolPlugin {
  return {
    definition: {
      name: "artifacts.read",
      description: "Read a text artifact by id or name.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Artifact id." },
          name: { type: "string", description: "Artifact name." },
          maxBytes: { type: "number", description: "Maximum characters to return, capped at 100000." },
        },
        additionalProperties: false,
      },
    },
    execute: async ({ store }, input) => {
      const args = objectInput(input);
      const id = optionalString(args.id);
      const name = optionalString(args.name);
      if (!id && !name) throw new Error("id or name is required");
      const artifact = store.listArtifacts(1000).find((item) => (id && item.id === id) || (name && item.name === name));
      if (!artifact) throw new Error(`Artifact not found: ${id ?? name}`);
      const maxBytes = boundedNumber(args.maxBytes, 20_000, 100_000);
      const text = await readFile(String(artifact.path), "utf8");
      const truncated = text.length > maxBytes;
      return {
        title: "artifact read",
        output: truncated ? `${text.slice(0, maxBytes)}\n\n[truncated]` : text,
        metadata: { artifactId: String(artifact.id), name: String(artifact.name), truncated },
      };
    },
  };
}

function completionSubmitTool(): ToolPlugin {
  return {
    definition: {
      name: "completion.submit",
      description: "Submit the final Markdown project report for user approval.",
      inputSchema: {
        type: "object",
        properties: { report: { type: "string" } },
        required: ["report"],
        additionalProperties: false,
      },
    },
    execute: async ({ store, agent }, input) => {
      const args = objectInput(input);
      const reportPath = await store.submitProject({ agentId: agent.id, report: stringArg(args, "report") });
      return { title: "project submitted", output: `Project submitted for user approval. Report: ${reportPath}`, metadata: { reportPath } };
    },
  };
}

function webFetchTool(): ToolPlugin {
  return {
    definition: {
      name: "web.fetch",
      description: "Fetch an HTTP(S) URL and return response text.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          maxBytes: { type: "number", description: "Maximum characters to return, capped at 100000." },
          timeoutMs: { type: "number", description: "Request timeout in milliseconds, capped at 120000." },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    execute: async (_context, input) => {
      const args = objectInput(input);
      const url = new URL(stringArg(args, "url"));
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported URL protocol: ${url.protocol}`);
      if (url.username || url.password) throw new Error("URL credentials are not allowed");
      const timeoutMs = boundedNumber(args.timeoutMs, 30_000, 120_000);
      const maxBytes = boundedNumber(args.maxBytes, 20_000, 100_000);
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      const truncated = text.length > maxBytes;
      return {
        title: "web fetch",
        output: truncated ? `${text.slice(0, maxBytes)}\n\n[truncated]` : text,
        metadata: { url: url.toString(), status: response.status, contentType: response.headers.get("content-type") ?? undefined, truncated },
      };
    },
  };
}

function isAllowed(tool: string, allowlist: string[]): boolean {
  let allowed = false;
  for (const pattern of allowlist) {
    if (pattern === tool || pattern === "*" || (pattern.endsWith(".*") && tool.startsWith(pattern.slice(0, -1)))) allowed = true;
  }
  return allowed;
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

function priorityArg(value: unknown): MessagePriority {
  if (value === "P0" || value === "P1" || value === "P2" || value === "P3") return value;
  throw new Error(`Invalid priority: ${String(value)}`);
}

function boundedNumber(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("Expected a positive number");
  return Math.min(Math.floor(value), max);
}
