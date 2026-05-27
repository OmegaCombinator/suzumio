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

export function toolDefinitions(agent: AgentRecord): ToolDefinition[] {
  return CORE_TOOLS.filter((tool) => isAllowed(tool.name, agent.tools));
}

export class ToolHost {
  constructor(private readonly root?: string) {}

  async call(input: ToolCallInput): Promise<ToolCallOutput> {
    const store = new ProjectStore(input.project, this.root);
    try {
      const agent = store.requireAgent(input.agentId);
      if (agent.token !== input.token) throw new Error("Invalid agent token");
      if (!isAllowed(input.tool, agent.tools)) throw new Error(`Tool not allowed for ${agent.id}: ${input.tool}`);
      const toolCallId = store.recordToolCall({ turnId: input.turnId, agentId: agent.id, tool: input.tool, input: input.input, status: "running" });
      try {
        const result = await executeCoreTool(store, agent, input.turnId, input.tool, input.input);
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

async function executeCoreTool(store: ProjectStore, agent: AgentRecord, turnId: string, tool: string, input: unknown): Promise<ToolCallOutput> {
  switch (tool) {
    case "messages.send": {
      const args = objectInput(input);
      const body = stringArg(args, "body");
      const priority = priorityArg(args.priority ?? "P2");
      const recipient = optionalString(args.recipient);
      const channel = optionalString(args.channel);
      const message = store.sendMessage({ sender: agent.id, recipient, channel, priority, body });
      return { title: "message sent", output: `Message sent: ${message.id}`, metadata: { messageId: message.id } };
    }
    case "artifacts.publish": {
      const args = objectInput(input);
      const artifact = await store.publishArtifact({ creator: agent.id, turnId, workspacePath: agent.workspacePath, sourcePath: stringArg(args, "path"), name: optionalString(args.name), description: optionalString(args.description) });
      return { title: "artifact published", output: `Artifact published: ${artifact.id}`, metadata: artifact as JsonObject };
    }
    case "artifacts.list": {
      const artifacts = store.listArtifacts(100);
      return { title: "artifacts", output: artifacts.length ? JSON.stringify(artifacts, null, 2) : "No artifacts published yet.", metadata: { count: artifacts.length } };
    }
    case "completion.submit": {
      const args = objectInput(input);
      const reportPath = await store.submitProject({ agentId: agent.id, report: stringArg(args, "report") });
      return { title: "project submitted", output: `Project submitted for user approval. Report: ${reportPath}`, metadata: { reportPath } };
    }
    default:
      throw new Error(`Unknown tool: ${tool}`);
  }
}

const CORE_TOOLS: ToolDefinition[] = [
  {
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
  {
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
  {
    name: "artifacts.list",
    description: "List project artifacts published so far.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "completion.submit",
    description: "Submit the final Markdown project report for user approval.",
    inputSchema: {
      type: "object",
      properties: { report: { type: "string" } },
      required: ["report"],
      additionalProperties: false,
    },
  },
];

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
