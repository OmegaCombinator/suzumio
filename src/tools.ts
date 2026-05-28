import { copyFile, cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentConfig, AgentRecord, DockerMountConfig, JsonObject, MessagePriority, ProjectConfig, ToolDefinition } from "./types.js";
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

export const TOOLPACKS: Record<string, () => ToolPlugin[]> = {
  core: () => [messagesSendTool(), completionSubmitTool()],
  artifacts: () => [artifactsPublishTool(), artifactsListTool(), artifactsReadTool()],
  inputs: () => [inputsListTool(), inputsCopyTool()],
  web: () => [webFetchTool()],
};

export const defaultToolRegistry = toolRegistryForToolpacks(["core", "artifacts", "inputs", "web"]);

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
      const artifactPath = String(artifact.path);
      const info = await stat(artifactPath);
      if (info.isDirectory()) throw new Error("artifacts.read only reads text file artifacts. Use mounted inputs for directory handoff.");
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

function inputsListTool(): ToolPlugin {
  return {
    definition: {
      name: "inputs.list",
      description: "List configured mounted input paths, or list files under one mounted input path.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional mounted container path such as /mnt/reference." },
          maxEntries: { type: "number", description: "Maximum entries to return, capped at 2000." },
        },
        additionalProperties: false,
      },
    },
    execute: async ({ store, agent }, input) => {
      const args = objectInput(input);
      const config = store.config();
      const requested = optionalString(args.path);
      if (!requested) {
        const mounts = mountedInputs(config, agent);
        const output = mounts.length ? mounts.map((mount) => `${mount.target} (${mount.readonly ? "read-only" : "read-write"})${mount.description ? `: ${mount.description}` : ""}`).join("\n") : "No mounted inputs configured.";
        return { title: "mounted inputs", output, metadata: { count: mounts.length } };
      }
      const maxEntries = boundedNumber(args.maxEntries, 200, 2_000);
      const resolved = await resolveMountedInputPath(config, agent, requested);
      const info = await stat(resolved.hostPath);
      if (info.isFile()) return { title: "mounted input", output: `${resolved.containerPath} (${info.size} bytes)`, metadata: { path: resolved.containerPath, type: "file", size: info.size } };
      if (!info.isDirectory()) throw new Error(`Mounted input is neither file nor directory: ${resolved.containerPath}`);
      const entries = await directoryEntries(resolved.hostPath, resolved.hostPath);
      const selected = entries.slice(0, maxEntries);
      const prefix = resolved.containerPath.endsWith("/") ? resolved.containerPath.slice(0, -1) : resolved.containerPath;
      const output = selected.length ? selected.map((entry) => `${prefix}/${entry}`).join("\n") : "(empty directory)";
      return { title: "mounted input listing", output: entries.length > selected.length ? `${output}\n\n[truncated]` : output, metadata: { path: resolved.containerPath, type: "directory", entries: entries.length, truncated: entries.length > selected.length } };
    },
  };
}

function inputsCopyTool(): ToolPlugin {
  return {
    definition: {
      name: "inputs.copy",
      description: "Copy a configured mounted input file or directory into this agent workspace.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: "Mounted container path such as /mnt/reference/file.txt." },
          destination: { type: "string", description: "Workspace-relative destination path." },
          overwrite: { type: "boolean", default: false },
        },
        required: ["source", "destination"],
        additionalProperties: false,
      },
    },
    execute: async ({ store, agent }, input) => {
      const args = objectInput(input);
      const config = store.config();
      const source = await resolveMountedInputPath(config, agent, stringArg(args, "source"));
      const destination = workspaceDestination(agent.workspacePath, stringArg(args, "destination"));
      const overwrite = booleanArg(args.overwrite ?? false, "overwrite");
      if (!overwrite && (await pathExists(destination))) throw new Error(`Destination already exists: ${path.relative(agent.workspacePath, destination)}`);
      const info = await stat(source.hostPath);
      if (info.isDirectory()) await cp(source.hostPath, destination, { recursive: true, force: overwrite, errorOnExist: !overwrite });
      else if (info.isFile()) {
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source.hostPath, destination);
      } else {
        throw new Error(`Mounted input is neither file nor directory: ${source.containerPath}`);
      }
      return { title: "input copied", output: `Copied ${source.containerPath} to /workspace/${path.relative(agent.workspacePath, destination)}`, metadata: { source: source.containerPath, destination: path.relative(agent.workspacePath, destination), type: info.isDirectory() ? "directory" : "file" } };
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
          format: { type: "string", enum: ["text", "raw"], default: "text" },
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
      const raw = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      const format = formatArg(args.format);
      const text = format === "raw" ? raw : contentType.includes("html") ? htmlToText(raw) : raw;
      const truncated = text.length > maxBytes;
      return {
        title: "web fetch",
        output: truncated ? `${text.slice(0, maxBytes)}\n\n[truncated]` : text,
        metadata: { url: url.toString(), status: response.status, contentType: contentType || undefined, format, truncated },
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

function formatArg(value: unknown): "text" | "raw" {
  if (value === undefined || value === "text" || value === "raw") return value ?? "text";
  throw new Error(`Invalid format: ${String(value)}`);
}

function booleanArg(value: unknown, key: string): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`${key} must be a boolean`);
}

function boundedNumber(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("Expected a positive number");
  return Math.min(Math.floor(value), max);
}

function mountedInputs(config: ProjectConfig, agent: AgentRecord): DockerMountConfig[] {
  const spec = agentSpec(config, agent);
  return [...(config.backend.docker?.mounts ?? []), ...(spec?.mounts ?? [])];
}

function agentSpec(config: ProjectConfig, agent: AgentRecord): AgentConfig | undefined {
  return config.agents[agent.id] ?? config.agents[agent.id.replace(/-\d+$/, "")];
}

async function resolveMountedInputPath(config: ProjectConfig, agent: AgentRecord, inputPath: string): Promise<{ containerPath: string; hostPath: string }> {
  const containerPath = path.posix.normalize(inputPath);
  if (!containerPath.startsWith("/")) throw new Error(`Mounted input path must be absolute: ${inputPath}`);
  const mounts = mountedInputs(config, agent).sort((a, b) => b.target.length - a.target.length);
  for (const mount of mounts) {
    const target = path.posix.normalize(mount.target);
    if (containerPath !== target && !containerPath.startsWith(`${target}/`)) continue;
    const relative = containerPath === target ? "" : containerPath.slice(target.length + 1);
    const sourceInfo = await stat(mount.source);
    if (sourceInfo.isFile() && relative) throw new Error(`Mounted input is a file, not a directory: ${target}`);
    const hostPath = sourceInfo.isFile() ? mount.source : path.resolve(mount.source, relative);
    assertInsideHostPath(hostPath, mount.source);
    return { containerPath, hostPath };
  }
  throw new Error(`Path is not under a configured mounted input: ${inputPath}`);
}

function workspaceDestination(workspacePath: string, destination: string): string {
  if (path.isAbsolute(destination)) throw new Error("destination must be relative to /workspace");
  const resolved = path.resolve(workspacePath, destination);
  assertInsideHostPath(resolved, workspacePath);
  return resolved;
}

function assertInsideHostPath(filePath: string, root: string): void {
  const resolved = path.resolve(filePath);
  const base = path.resolve(root);
  if (resolved === base || resolved.startsWith(base + path.sep)) return;
  throw new Error(`Path is outside allowed root: ${filePath}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryEntries(root: string, directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = `${directory}/${entry.name}`;
    const relative = absolute.slice(root.length + 1);
    if (entry.isDirectory()) {
      out.push(`${relative}/`);
      out.push(...(await directoryEntries(root, absolute)));
    } else if (entry.isFile()) {
      out.push(relative);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
