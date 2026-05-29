#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { jsonSchema, streamText, tool as aiTool, type ModelMessage } from "ai";
import { resolveRunnerModels, type ResolvedRunnerModel } from "./runner-model.js";
import type { JsonObject, RunnerToolpackSpec, RunnerTurnInput, RunnerTurnOutput, ToolDefinition } from "./types.js";

type ToolResult = { title?: string; output: string; metadata?: JsonObject };
type RunnerToolHandler = (input: unknown) => Promise<ToolResult>;
type RegisteredTool = { definition: ToolDefinition; toolpack: RunnerToolpackSpec; handler: RunnerToolHandler };

type RunnerToolContext = {
  project: string;
  agentId: string;
  turnId: string;
  workspace: string;
  toolpackId: string;
  callSupport: (tool: string, input: unknown) => Promise<ToolResult>;
  recordSignal: (input: { kind: string; targetAgent?: string; targetChannel?: string; priority?: string; payload?: JsonObject; usefulEffect?: boolean }) => Promise<void>;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = required(args.input, "--input");
  const input = JSON.parse(await readFile(inputPath, "utf8")) as RunnerTurnInput;
  const output = await runAi(input);
  await submitTurnOutput(input, output);
}

async function runAi(input: RunnerTurnInput): Promise<RunnerTurnOutput> {
  if (!input.runner.models) throw new Error("runner.models is required in ai mode");
  const models = resolveRunnerModels(input.runner.models, input.agent.model ?? input.runner.model);
  const errors: string[] = [];
  for (const resolved of models) {
    try {
      return await runAiWithModel(input, resolved);
    } catch (error) {
      errors.push(`${resolved.presetId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`All model attempts failed:\n${errors.join("\n")}`);
}

async function runAiWithModel(input: RunnerTurnInput, resolved: ResolvedRunnerModel): Promise<RunnerTurnOutput> {
  const tools = await toAiTools(input);
  const messages: ModelMessage[] = [{ role: "user", content: input.turn.prompt }];
  let text = "";
  const result = streamText({
    model: resolved.languageModel as never,
    messages,
    tools: Object.keys(tools).length ? (tools as never) : undefined,
    activeTools: Object.keys(tools),
    toolChoice: resolved.preset.toolChoice ?? (Object.keys(tools).length ? "auto" : "none"),
    temperature: resolved.preset.temperature,
    topP: resolved.preset.topP,
    topK: resolved.preset.topK,
    maxOutputTokens: resolved.preset.maxOutputTokens,
    providerOptions: resolved.preset.providerOptions as never,
    headers: resolved.preset.headers,
    maxRetries: 0,
  } as never) as any;
  for await (const event of result.fullStream as AsyncIterable<any>) {
    if (event.type === "text-delta") text += event.text;
    if (event.type === "error") throw event.error;
  }
  return { text: text.trim() || "(model returned no text)", usage: { selectedModel: resolved.selectedPresetId, model: resolved.presetId, apiModel: resolved.apiModel } };
}

async function submitTurnOutput(input: RunnerTurnInput, output: RunnerTurnOutput): Promise<void> {
  const response = await fetch(new URL("/turn-output", input.controllerUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: input.project, agentId: input.agent.id, turnId: input.turn.id, token: input.token, output }),
  });
  if (!response.ok) throw new Error((await response.text()) || `Turn output submit failed: ${response.status}`);
}

async function toAiTools(input: RunnerTurnInput): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const tools = await loadRunnerTools(input);
  const seenSafeNames = new Map<string, string>();
  for (const registered of tools) {
    const safe = safeToolName(registered.definition.name);
    const previous = seenSafeNames.get(safe);
    if (previous) throw new Error(`Tool names ${previous} and ${registered.definition.name} both map to ${safe}`);
    seenSafeNames.set(safe, registered.definition.name);
    result[safe] = aiTool({
      description: registered.definition.description,
      inputSchema: jsonSchema(registered.definition.inputSchema as never),
      execute: async (args: unknown) => callTool(input, registered, args),
    } as never);
  }
  return result;
}

async function loadRunnerTools(input: RunnerTurnInput): Promise<RegisteredTool[]> {
  const registered: RegisteredTool[] = [];
  const seen = new Set<string>();
  for (const toolpack of input.toolpacks) {
    const context = runnerToolContext(input, toolpack);
    const handlers = toolpack.runnerModule.startsWith("builtin:") ? builtinRunnerHandlers(toolpack.id, context) : await externalRunnerHandlers(toolpack, context);
    for (const definition of toolpack.tools) {
      const handler = handlers[definition.name];
      if (typeof handler !== "function") throw new Error(`Runner module for ${toolpack.id} did not register ${definition.name}`);
      if (seen.has(definition.name)) throw new Error(`Duplicate runner tool: ${definition.name}`);
      seen.add(definition.name);
      registered.push({ definition, toolpack, handler });
    }
  }
  return registered;
}

function runnerToolContext(input: RunnerTurnInput, toolpack: RunnerToolpackSpec): RunnerToolContext {
  return {
    project: input.project,
    agentId: input.agent.id,
    turnId: input.turn.id,
    workspace: input.workspace,
    toolpackId: toolpack.id,
    callSupport: (tool, toolInput) => callSupport(input, toolpack, tool, toolInput),
    recordSignal: async (signal) => {
      await postJson(new URL("/runner/signals", input.controllerUrl), {
        project: input.project,
        agentId: input.agent.id,
        turnId: input.turn.id,
        token: input.token,
        ...signal,
      });
    },
  };
}

async function callTool(input: RunnerTurnInput, registered: RegisteredTool, args: unknown): Promise<ToolResult> {
  const toolCall = await postJson<{ toolCallId: string }>(new URL("/runner/tool-calls/start", input.controllerUrl), {
    project: input.project,
    agentId: input.agent.id,
    turnId: input.turn.id,
    token: input.token,
    tool: registered.definition.name,
    input: args ?? {},
  });
  try {
    const result = await registered.handler(args ?? {});
    await finishToolCall(input, toolCall.toolCallId, "completed", result.output);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finishToolCall(input, toolCall.toolCallId, "failed", undefined, message).catch(() => undefined);
    throw error;
  }
}

async function finishToolCall(input: RunnerTurnInput, toolCallId: string, status: "completed" | "failed", output?: string, error?: string): Promise<void> {
  await postJson(new URL("/runner/tool-calls/finish", input.controllerUrl), {
    project: input.project,
    agentId: input.agent.id,
    turnId: input.turn.id,
    token: input.token,
    toolCallId,
    status,
    output,
    error,
  });
}

async function callSupport(input: RunnerTurnInput, toolpack: RunnerToolpackSpec, tool: string, toolInput: unknown): Promise<ToolResult> {
  return postJson(new URL(toolpack.supportPath, input.controllerUrl), {
    project: input.project,
    agentId: input.agent.id,
    turnId: input.turn.id,
    token: input.token,
    tool,
    input: toolInput ?? {},
  });
}

function builtinRunnerHandlers(toolpackId: string, context: RunnerToolContext): Record<string, RunnerToolHandler> {
  switch (toolpackId) {
    case "core":
      return {
        "messages.send": (input) => context.callSupport("messages.send", input),
        "coordination.no_valuable_work": (input) => context.callSupport("coordination.no_valuable_work", input),
        "completion.submit": (input) => context.callSupport("completion.submit", input),
      };
    case "artifacts":
      return {
        "artifacts.publish": (input) => context.callSupport("artifacts.publish", input),
        "artifacts.list": (input) => context.callSupport("artifacts.list", input),
        "artifacts.read": (input) => context.callSupport("artifacts.read", input),
      };
    case "shell":
      return { "shell.exec": (input) => runShellExec(context.workspace, input) };
    case "web":
      return { "web.fetch": runWebFetch };
    default:
      throw new Error(`Unknown built-in runner toolpack: ${toolpackId}`);
  }
}

async function externalRunnerHandlers(toolpack: RunnerToolpackSpec, context: RunnerToolContext): Promise<Record<string, RunnerToolHandler>> {
  const module = await import(pathToFileURL(toolpack.runnerModule).href);
  const factory = module.createRunnerToolpack ?? module.default;
  if (typeof factory !== "function") throw new Error(`Runner module for ${toolpack.id} must export createRunnerToolpack`);
  const instance = await factory(context);
  return instance?.tools ?? instance;
}

async function runShellExec(workspace: string, rawArgs: unknown): Promise<ToolResult> {
  const args = objectInput(rawArgs);
  const command = stringArg(args, "command");
  const cwd = shellCwd(workspace, optionalString(args.cwd));
  const timeoutMs = boundedNumber(args.timeoutMs, 60_000, 300_000);
  const maxOutputBytes = boundedNumber(args.maxOutputBytes, 40_000, 200_000);
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
      const used = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
      const remaining = maxOutputBytes - used;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const selected = chunk.subarray(0, remaining);
      if (selected.length < chunk.length) truncated = true;
      if (kind === "stdout") stdout += selected.toString("utf8");
      else stderr += selected.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      const output = [`$ ${command}`, stdout.trim() ? `\n[stdout]\n${stdout.trimEnd()}` : "", stderr.trim() ? `\n[stderr]\n${stderr.trimEnd()}` : "", truncated ? "\n[truncated]" : ""].join("");
      resolve({ title: "shell exec", output, metadata: { exitCode, signal, cwd, timedOut, truncated } });
    });
  });
}

async function runWebFetch(rawArgs: unknown): Promise<ToolResult> {
  const args = objectInput(rawArgs);
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
  return { title: "web fetch", output: truncated ? `${text.slice(0, maxBytes)}\n\n[truncated]` : text, metadata: { url: url.toString(), status: response.status, contentType: contentType || undefined, format, truncated } };
}

async function postJson<T = ToolResult>(url: URL, body: unknown): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Request failed: ${response.status}`);
  return (text.trim() ? JSON.parse(text) : {}) as T;
}

function safeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_");
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

function boundedNumber(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("Expected a positive number");
  return Math.min(Math.floor(value), max);
}

function shellCwd(workspace: string, cwd: string | undefined): string {
  if (!cwd) return workspace;
  return path.isAbsolute(cwd) ? path.normalize(cwd) : path.resolve(workspace, cwd);
}

function formatArg(value: unknown): "text" | "raw" {
  if (value === undefined || value === "text" || value === "raw") return value ?? "text";
  throw new Error(`Invalid format: ${String(value)}`);
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

function parseArgs(args: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item?.startsWith("--")) continue;
    out[item.slice(2)] = args[index + 1];
    index += 1;
  }
  return out;
}

function required(value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
