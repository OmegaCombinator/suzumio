#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { jsonSchema, streamText, tool as aiTool, type ModelMessage } from "ai";
import { resolveRunnerModels, type ResolvedRunnerModel } from "./runner-model.js";
import type { JsonObject, RunnerTurnInput, RunnerTurnOutput, ToolDefinition } from "./types.js";

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
  const tools = toAiTools(input);
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

function toAiTools(input: RunnerTurnInput): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const definition of input.tools) {
    const safe = safeToolName(definition.name);
    result[safe] = aiTool({
      description: definition.description,
      inputSchema: jsonSchema(definition.inputSchema as never),
      execute: async (args: unknown) => callTool(input, definition, args),
    } as never);
  }
  return result;
}

async function callTool(input: RunnerTurnInput, definition: ToolDefinition, args: unknown): Promise<Record<string, unknown>> {
  if (definition.execution === "runner") return runRunnerTool(input, definition, args) as Promise<Record<string, unknown>>;
  const response = await fetch(new URL("/tool", input.controllerUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project: input.project,
      agentId: input.agent.id,
      turnId: input.turn.id,
      token: input.token,
      tool: definition.name,
      input: args ?? {},
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Tool call failed: ${response.status}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function runRunnerTool(input: RunnerTurnInput, definition: ToolDefinition, args: unknown): Promise<{ title: string; output: string; metadata: JsonObject }> {
  switch (definition.name) {
    case "shell.exec":
      return runShellExec(input, args);
    case "web.fetch":
      return runWebFetch(args);
    default:
      throw new Error(`Unknown runner-local tool: ${definition.name}`);
  }
}

async function runShellExec(input: RunnerTurnInput, rawArgs: unknown): Promise<{ title: string; output: string; metadata: JsonObject }> {
  const args = objectInput(rawArgs);
  const command = stringArg(args, "command");
  const cwd = shellCwd(input.workspace, optionalString(args.cwd));
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

async function runWebFetch(rawArgs: unknown): Promise<{ title: string; output: string; metadata: JsonObject }> {
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
  return {
    title: "web fetch",
    output: truncated ? `${text.slice(0, maxBytes)}\n\n[truncated]` : text,
    metadata: { url: url.toString(), status: response.status, contentType: contentType || undefined, format, truncated },
  };
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
