import { readFile, stat } from "node:fs/promises";
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
    if (plugin.definition.execution !== "controller") throw new Error(`${tool} runs inside the Docker runner, not through the controller support route`);
    return plugin.execute(context, input);
  }
}

export const TOOLPACKS: Record<string, () => ToolPlugin[]> = {
  core: () => [messagesSendTool(), completionSubmitTool()],
  artifacts: () => [artifactsPublishTool(), artifactsListTool(), artifactsReadTool()],
  shell: () => [shellExecTool()],
  web: () => [webFetchTool()],
};

export const defaultToolRegistry = toolRegistryForToolpacks(["core", "artifacts", "web"]);

export function toolRegistryForToolpacks(toolpacks: string[]): ToolRegistry {
  const plugins: ToolPlugin[] = [];
  for (const name of toolpacks) {
    const toolpack = TOOLPACKS[name];
    if (!toolpack) throw new Error(`Unknown toolpack: ${name}`);
    plugins.push(...toolpack());
  }
  return new ToolRegistry(plugins);
}

export function toolDefinitions(agent: AgentRecord, toolpacks?: string[]): ToolDefinition[] {
  return (toolpacks ? toolRegistryForToolpacks(toolpacks) : defaultToolRegistry).definitions(agent);
}

export class ToolHost {
  constructor(private readonly root?: string) {}

  async call(input: ToolCallInput): Promise<ToolCallOutput> {
    const store = new ProjectStore(input.project, this.root);
    try {
      const agent = store.requireAgent(input.agentId);
      if (agent.token !== input.token) throw new Error("Invalid agent token");
      if (!isAllowed(input.tool, agent.tools)) throw new Error(`Tool not allowed for ${agent.id}: ${input.tool}`);
      const registry = toolRegistryForToolpacks(store.config().tools.toolpacks);
      const toolCallId = store.recordToolCall({ turnId: input.turnId, agentId: agent.id, tool: input.tool, input: input.input, status: "running" });
      try {
        const result = await registry.execute({ store, agent, turnId: input.turnId }, input.tool, input.input);
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
      execution: "controller",
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
      execution: "controller",
      description: "Publish a file or directory from this agent workspace as a project artifact.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file or directory path." },
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
      execution: "controller",
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
      execution: "controller",
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
      const artifactPath = String(artifact.path);
      const info = await stat(artifactPath);
      if (info.isDirectory()) throw new Error("artifacts.read only reads text file artifacts. Use mounted paths and shell.exec for directory handoff.");
      const text = await readFile(artifactPath, "utf8");
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
      execution: "controller",
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

function shellExecTool(): ToolPlugin {
  return {
    definition: {
      name: "shell.exec",
      execution: "runner",
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
    },
    execute: async () => {
      throw new Error("shell.exec is a runner-local tool and cannot be executed by the controller support route");
    },
  };
}

function webFetchTool(): ToolPlugin {
  return {
    definition: {
      name: "web.fetch",
      execution: "runner",
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
    },
    execute: async () => {
      throw new Error("web.fetch is a runner-local tool and cannot be executed by the controller support route");
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
