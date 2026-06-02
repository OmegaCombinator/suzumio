#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { jsonSchema, stepCountIs, streamText, tool as aiTool, type ModelMessage } from "ai";
import { MAX_SUMMARY_CHARS, fallbackAgentHistorySummary, renderHistoryMessageForModel, retryTailMessageCount, trimChars, trimHistoryForSummary } from "./history-compaction.js";
import { resolveRunnerModels, type ResolvedRunnerModel } from "./runner-model.js";
import { assertNodeFetchProxySupported, proxyForUrl } from "./proxy.js";
import type { ActivationContextSnapshot, AgentHistoryMessage, JsonObject, RunnerActivationInput, RunnerActivationOutput, RunnerToolpackSpec, ToolDefinition } from "./types.js";

type ToolResult = { title?: string; output: string; metadata?: JsonObject };
type RunnerToolHandler = (input: unknown) => Promise<ToolResult>;
type RegisteredTool = { definition: ToolDefinition; toolpack: RunnerToolpackSpec; handler: RunnerToolHandler };
type ToolCallLimiter = () => void;
type EndActivationCallback = (output: string) => void;
type ActivationEnded = () => boolean;
type FetchWithDispatcher = (url: Parameters<typeof fetch>[0], init?: RequestInit & { dispatcher: Dispatcher }) => ReturnType<typeof fetch>;
type TokenUsage = { input?: number; output?: number; total?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
type ToolCallFinishOutput = { status: "completed" | "failed"; deliveredSignals?: number; signalText?: string };

const fetchWithDispatcher = undiciFetch as unknown as FetchWithDispatcher;
const webProxyDispatchers = new Map<string, ProxyAgent>();
const EFFECTIVELY_UNBOUNDED_STEPS = 1_000_000;
const CONTEXT_OVERFLOW_RETRIES = 1;
const SUMMARY_OUTPUT_TOKENS = 4_000;
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`;

type RunnerToolContext = {
  project: string;
  agentId: string;
  activationId: string;
  workspace: string;
  toolpackId: string;
  callSupport: (tool: string, input: unknown) => Promise<ToolResult>;
  recordSignal: (input: { kind: string; targetAgent?: string; targetChannel?: string; priority?: string; payload?: JsonObject; usefulEffect?: boolean }) => Promise<void>;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = required(args.input, "--input");
  const input = JSON.parse(await readFile(inputPath, "utf8")) as RunnerActivationInput;
  const output = await runAi(input);
  await submitActivationOutput(input, output);
}

async function runAi(input: RunnerActivationInput): Promise<RunnerActivationOutput> {
  if (!input.runner.models) throw new Error("runner.models is required in ai mode");
  const models = resolveRunnerModels(input.runner.models, input.agent.model ?? input.runner.model);
  const errors: string[] = [];
  for (const resolved of models) {
    try {
      return await runAiWithModel(input, resolved);
    } catch (error) {
      errors.push(`${resolved.presetId}: ${errorMessage(error)}`);
    }
  }
  throw new Error(`All model attempts failed:\n${errors.join("\n")}`);
}

async function runAiWithModel(input: RunnerActivationInput, resolved: ResolvedRunnerModel): Promise<RunnerActivationOutput> {
  let history = input.history ?? [];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await runAiRequestWithHistory(input, resolved, history);
    } catch (error) {
      if (attempt >= CONTEXT_OVERFLOW_RETRIES || !isContextOverflowError(error)) throw error;
      console.warn(`context overflow from ${resolved.presetId}; compacting agent history and retrying activation ${input.activation.id}`);
      history = await compactHistoryForContextOverflow(input, resolved, history, error);
    }
  }
}

async function runAiRequestWithHistory(input: RunnerActivationInput, resolved: ResolvedRunnerModel, history: AgentHistoryMessage[]): Promise<RunnerActivationOutput> {
  let toolCalls = 0;
  const abortController = new AbortController();
  let activationEnded = false;
  let endActivationOutput: string | undefined;
  const firstPrompt = isFirstActivationPrompt(history);
  const tools = await toAiTools(input, () => {
    toolCalls += 1;
    if (input.runner.maxToolCalls !== undefined && toolCalls > input.runner.maxToolCalls) throw new Error(`Exceeded maxToolCalls: ${input.runner.maxToolCalls}`);
  }, (output) => {
    activationEnded = true;
    endActivationOutput = output;
    abortController.abort();
  }, () => activationEnded);
  const messages = historyMessages(history);
  await submitActivationContext(input, resolved, messages, firstPrompt).catch((error) => console.warn("activation context submit failed", errorMessage(error)));
  let text = "";
  let usage: TokenUsage | undefined;
  const request = {
    model: resolved.languageModel as never,
    messages,
    tools: Object.keys(tools).length ? (tools as never) : undefined,
    activeTools: Object.keys(tools),
    toolChoice: resolved.preset.toolChoice ?? (Object.keys(tools).length ? "auto" : "none"),
    temperature: resolved.preset.temperature,
    topP: resolved.preset.topP,
    topK: resolved.preset.topK,
    maxOutputTokens: resolved.preset.maxOutputTokens,
    providerOptions: providerOptionsFor(resolved) as never,
    headers: resolved.preset.headers,
    abortSignal: abortController.signal,
    maxRetries: 0,
  } as Record<string, unknown>;
  request.stopWhen = stepCountIs(input.runner.maxIterations ?? EFFECTIVELY_UNBOUNDED_STEPS);
  const result = streamText(request as never) as any;
  const output = (toolOutput?: string): RunnerActivationOutput => ({ text: text.trim() || toolOutput || "(model returned no text)", usage: { selectedModel: resolved.selectedPresetId, model: resolved.presetId, apiModel: resolved.apiModel, ...(usage ? { tokens: usage as unknown as JsonObject } : {}) } });
  const finish = async (toolOutput?: string): Promise<RunnerActivationOutput> => {
    const completed = output(toolOutput);
    await submitHistoryAssistant(input, completed, resolved, usage).catch((error) => console.warn("assistant history submit failed", errorMessage(error)));
    return completed;
  };
  try {
    for await (const event of result.fullStream as AsyncIterable<any>) {
      if (event.type === "text-delta") text += event.text;
      if (event.type === "finish-step") usage = parseUsage(event.usage) ?? usage;
      if (event.type === "finish") usage = parseUsage(event.totalUsage) ?? usage;
      if (event.type === "error") {
        if (activationEnded && isAbortError(event.error)) return await finish(endActivationOutput);
        throw event.error;
      }
      if (endActivationOutput !== undefined) return await finish(endActivationOutput);
    }
  } catch (error) {
    if (activationEnded && isAbortError(error)) return await finish(endActivationOutput);
    throw error;
  }
  return await finish();
}

async function compactHistoryForContextOverflow(input: RunnerActivationInput, resolved: ResolvedRunnerModel, history: AgentHistoryMessage[], error: unknown): Promise<AgentHistoryMessage[]> {
  const keepTail = Math.max(1, retryTailMessageCount(history));
  const archived = history.slice(0, Math.max(0, history.length - keepTail));
  const fallbackSummary = (summaryError: string) => fallbackAgentHistorySummary({
    agentId: input.agent.id,
    history,
    archived,
    keepTail,
    overflowError: errorMessage(error),
    summaryError,
    selectedModel: resolved.selectedPresetId,
  });
  const summary = archived.length ? await summarizeAgentHistory(resolved, archived, undefined).catch((summaryError) => {
    console.warn(`history summary failed; using deterministic fallback for activation ${input.activation.id}: ${errorMessage(summaryError)}`);
    return fallbackSummary(errorMessage(summaryError));
  }) : fallbackSummary("No pre-activation history segment was available to summarize; compacting active controller history.");
  const response = await postJson<{ history?: AgentHistoryMessage[] }>(new URL("/runner/history/compact", input.controllerUrl), {
    project: input.project,
    agentId: input.agent.id,
    activationId: input.activation.id,
    token: input.token,
    summary,
    keepTail,
    reason: "provider_context_overflow",
    selectedModel: resolved.selectedPresetId,
  });
  return response.history?.length ? response.history : history;
}

async function summarizeAgentHistory(resolved: ResolvedRunnerModel, history: AgentHistoryMessage[], usage: TokenUsage | undefined): Promise<string> {
  const prompt = [
    "You are compacting a long-running autonomous agent session for future continuation.",
    "Preserve the exact target, constraints, proof state, important lemmas, computations, file paths, commands, errors, artifact paths, verification facts, blockers, and next steps. Remove chatter and duplicated attempts.",
    usage ? `Recent token usage: ${JSON.stringify(usage)}` : undefined,
    SUMMARY_TEMPLATE,
    "# Agent History To Compact",
    trimHistoryForSummary(history),
  ].filter(Boolean).join("\n\n");
  let text = "";
  const result = streamText({
    model: resolved.languageModel as never,
    messages: [{ role: "user", content: prompt }],
    temperature: resolved.preset.temperature,
    topP: resolved.preset.topP,
    topK: resolved.preset.topK,
    maxOutputTokens: Math.min(resolved.preset.maxOutputTokens ?? SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS),
    providerOptions: providerOptionsFor(resolved) as never,
    headers: resolved.preset.headers,
    maxRetries: 0,
  } as never) as any;
  for await (const event of result.fullStream as AsyncIterable<any>) {
    if (event.type === "text-delta") text += event.text;
    if (event.type === "error") throw event.error;
  }
  return trimChars(text.trim() || "No durable session facts were recovered.", MAX_SUMMARY_CHARS);
}

function historyMessages(history: AgentHistoryMessage[]): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (const item of history) {
    const content = renderHistoryMessageForModel(item);
    if (!content.trim()) continue;
    messages.push({ role: modelRole(item), content });
  }
  return messages.length ? messages : [{ role: "user", content: "Continue the assigned Suzumio activation." }];
}

function modelRole(item: AgentHistoryMessage): "user" | "assistant" {
  if (item.role === "assistant" || item.role === "tool_call") return "assistant";
  return "user";
}

function isFirstActivationPrompt(history: AgentHistoryMessage[]): boolean {
  return history.filter((item) => item.kind === "activation_prompt").length <= 1;
}

function parseUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    reasoningTokens?: number;
    cachedInputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
  };
  const usage = {
    input: item.inputTokens,
    output: item.outputTokens,
    total: item.totalTokens,
    reasoning: item.outputTokenDetails?.reasoningTokens ?? item.reasoningTokens,
    cacheRead: item.inputTokenDetails?.cacheReadTokens ?? item.cachedInputTokens,
    cacheWrite: item.inputTokenDetails?.cacheWriteTokens,
  } satisfies TokenUsage;
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

function providerOptionsFor(resolved: ResolvedRunnerModel): JsonObject {
  const options: JsonObject = { ...(resolved.preset.providerOptions ?? {}) };
  if (!resolved.preset.reasoningEffort) return options;
  for (const key of reasoningEffortProviderKeys(resolved)) {
    const current = isJsonObject(options[key]) ? options[key] : {};
    options[key] = { ...current, reasoningEffort: resolved.preset.reasoningEffort };
  }
  return options;
}

function reasoningEffortProviderKeys(resolved: ResolvedRunnerModel): string[] {
  if (resolved.provider.type === "openai") return ["openai"];
  if (resolved.provider.type === "openai-compatible") return ["openaiCompatible", resolved.providerId];
  return [resolved.providerId];
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function submitActivationOutput(input: RunnerActivationInput, output: RunnerActivationOutput): Promise<void> {
  let response: Response;
  try {
    response = await fetch(new URL("/activation-output", input.controllerUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: input.project, agentId: input.agent.id, activationId: input.activation.id, token: input.token, output }),
    });
  } catch (error) {
    throw controllerConnectionError(error);
  }
  if (!response.ok) throw new Error((await response.text()) || `Activation output submit failed: ${response.status}`);
}

async function submitHistoryAssistant(input: RunnerActivationInput, output: RunnerActivationOutput, resolved: ResolvedRunnerModel, usage: TokenUsage | undefined): Promise<void> {
  await postJson(new URL("/runner/history/messages", input.controllerUrl), {
    project: input.project,
    agentId: input.agent.id,
    activationId: input.activation.id,
    token: input.token,
    role: "assistant",
    kind: "assistant_output",
    content: output.text,
    metadata: { selectedModel: resolved.selectedPresetId, model: resolved.presetId, apiModel: resolved.apiModel, usage },
  });
}

async function submitActivationContext(input: RunnerActivationInput, resolved: ResolvedRunnerModel, messages: ModelMessage[], firstPrompt: boolean): Promise<void> {
  const snapshot: ActivationContextSnapshot = {
    version: 1,
    kind: "model-context",
    recordedAt: new Date().toISOString(),
    selectedModel: resolved.selectedPresetId,
    model: resolved.presetId,
    apiModel: resolved.apiModel,
    firstPrompt,
    messageCount: messages.length,
    totalChars: messages.reduce((sum, message) => sum + modelMessageText(message).length, 0),
    messages: messages.map((message) => {
      const content = modelMessageText(message);
      return { role: String(message.role), content, chars: content.length };
    }),
  };
  let response: Response;
  try {
    response = await fetch(new URL("/activation-context", input.controllerUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: input.project, agentId: input.agent.id, activationId: input.activation.id, token: input.token, context: snapshot }),
    });
  } catch (error) {
    throw controllerConnectionError(error);
  }
  if (!response.ok) throw new Error((await response.text()) || `Activation context submit failed: ${response.status}`);
}

function modelMessageText(message: ModelMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  return JSON.stringify(content ?? "");
}

async function toAiTools(input: RunnerActivationInput, limitToolCall: ToolCallLimiter, endActivation: EndActivationCallback, activationEnded: ActivationEnded, recordToolResult?: (toolName: string, args: unknown, result: ToolResult) => void): Promise<Record<string, unknown>> {
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
      execute: async (args: unknown) => {
        if (activationEnded()) return { title: "activation ended", output: "Activation already ended; tool call ignored." };
        limitToolCall();
        if (activationEnded()) return { title: "activation ended", output: "Activation already ended; tool call ignored." };
        const toolResult = await callTool(input, registered, args, endActivation);
        recordToolResult?.(registered.definition.name, args, toolResult);
        return toolResult;
      },
    } as never);
  }
  return result;
}

async function loadRunnerTools(input: RunnerActivationInput): Promise<RegisteredTool[]> {
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

function runnerToolContext(input: RunnerActivationInput, toolpack: RunnerToolpackSpec): RunnerToolContext {
  return {
    project: input.project,
    agentId: input.agent.id,
    activationId: input.activation.id,
    workspace: input.workspace,
    toolpackId: toolpack.id,
    callSupport: (tool, toolInput) => callSupport(input, toolpack, tool, toolInput),
    recordSignal: async (signal) => {
      await postJson(new URL("/runner/signals", input.controllerUrl), {
        project: input.project,
        agentId: input.agent.id,
        activationId: input.activation.id,
        token: input.token,
        ...signal,
      });
    },
  };
}

async function callTool(input: RunnerActivationInput, registered: RegisteredTool, args: unknown, endActivation: EndActivationCallback): Promise<ToolResult> {
  const toolCall = await postJson<{ toolCallId: string }>(new URL("/runner/tool-calls/start", input.controllerUrl), {
    project: input.project,
    agentId: input.agent.id,
    activationId: input.activation.id,
    token: input.token,
    tool: registered.definition.name,
    input: args ?? {},
  });
  let result: ToolResult;
  try {
    result = await registered.handler(args ?? {});
  } catch (error) {
    const message = errorMessage(error);
    await finishToolCall(input, toolCall.toolCallId, "failed", undefined, message).catch(() => undefined);
    throw error;
  }
  const finished = await finishToolCall(input, toolCall.toolCallId, "completed", result.output);
  if (finished.signalText) result = { ...result, output: [result.output, finished.signalText].filter(Boolean).join("\n\n") };
  if (endsActivation(registered.definition.name)) endActivation(result.output);
  return result;
}

function endsActivation(toolName: string): boolean {
  return toolName === "coordination.wait_for_signal" || toolName === "completion.submit";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
}

function isContextOverflowError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return [
    "context_length_exceeded",
    "context length",
    "context window",
    "maximum context",
    "max context",
    "too many tokens",
    "input exceeds",
    "exceeds the context",
    "exceeded the context",
    "prompt is too long",
    "request too large",
  ].some((needle) => message.includes(needle));
}

async function finishToolCall(input: RunnerActivationInput, toolCallId: string, status: "completed" | "failed", output?: string, error?: string): Promise<ToolCallFinishOutput> {
  return postJson<ToolCallFinishOutput>(new URL("/runner/tool-calls/finish", input.controllerUrl), {
    project: input.project,
    agentId: input.agent.id,
    activationId: input.activation.id,
    token: input.token,
    toolCallId,
    status,
    output,
    error,
  });
}

async function callSupport(input: RunnerActivationInput, toolpack: RunnerToolpackSpec, tool: string, toolInput: unknown): Promise<ToolResult> {
  return postJson(new URL(toolpack.supportPath, input.controllerUrl), {
    project: input.project,
    agentId: input.agent.id,
    activationId: input.activation.id,
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
        "coordination.wait_for_signal": (input) => context.callSupport("coordination.wait_for_signal", input),
        "completion.submit": (input) => context.callSupport("completion.submit", input),
        "file.read": (input) => runFileRead(context.workspace, input),
        "file.write": (input) => runFileWrite(context.workspace, context.agentId, input),
        "file.patch": (input) => runFilePatch(context.workspace, context.agentId, input),
      };
    case "shell":
      return { "shell.exec": (input) => runShellExec(context.workspace, input) };
    case "web":
      return { "web.fetch": runWebFetch };
    default:
      throw new Error(`Unknown built-in runner toolpack: ${toolpackId}`);
  }
}

async function runFileRead(workspace: string, rawArgs: unknown): Promise<ToolResult> {
  const args = objectInput(rawArgs);
  const filePath = readablePath(workspace, stringArg(args, "path"));
  const info = await stat(filePath);
  const offset = boundedNumber(args.offset, 1, Number.MAX_SAFE_INTEGER);
  const limit = boundedNumber(args.limit, 200, 2_000);
  const maxBytes = boundedNumber(args.maxBytes, 50_000, 100_000);
  if (info.isDirectory()) {
    const entries = (await readdir(filePath, { withFileTypes: true })).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).sort();
    const selected = entries.slice(offset - 1, offset - 1 + limit);
    const body = capToolText(selected.join("\n"), maxBytes);
    return { title: "file read", output: body || "(empty directory range)", metadata: { path: filePath, kind: "directory", entries: entries.length, offset, limit, truncated: body.length < selected.join("\n").length } };
  }
  const text = await readFile(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const selected = lines.slice(offset - 1, offset - 1 + limit).map((line, index) => `${offset + index}: ${line.length > 2_000 ? `${line.slice(0, 2_000)}... (line truncated)` : line}`);
  const raw = selected.join("\n");
  const body = capToolText(raw, maxBytes);
  return { title: "file read", output: body || "(empty file range)", metadata: { path: filePath, kind: "file", lines: lines.length, offset, limit, truncated: body.length < raw.length } };
}

async function runFileWrite(workspace: string, agentId: string, rawArgs: unknown): Promise<ToolResult> {
  const args = objectInput(rawArgs);
  const filePath = writablePath(workspace, agentId, stringArg(args, "path"));
  const content = textArg(args, "content");
  if (optionalBoolean(args.createDirs)) await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  return { title: "file written", output: `Wrote ${content.length} chars to ${filePath}`, metadata: { path: filePath, chars: content.length } };
}

async function runFilePatch(workspace: string, agentId: string, rawArgs: unknown): Promise<ToolResult> {
  const args = objectInput(rawArgs);
  const operations = arrayArg(args.operations, "operations").map((item) => objectInput(item));
  const results: string[] = [];
  for (const op of operations) {
    const kind = stringArg(op, "op");
    const filePath = writablePath(workspace, agentId, stringArg(op, "path"));
    if (kind === "add") {
      const content = textArg(op, "content");
      if (optionalBoolean(op.createDirs)) await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      results.push(`add ${filePath} (${content.length} chars)`);
      continue;
    }
    if (kind === "delete") {
      await rm(filePath);
      results.push(`delete ${filePath}`);
      continue;
    }
    if (kind !== "update") throw new Error(`Unsupported patch op: ${kind}`);
    const search = stringArg(op, "search");
    const replace = typeof op.replace === "string" ? op.replace : "";
    const replaceAll = optionalBoolean(op.replaceAll) ?? false;
    const text = await readFile(filePath, "utf8");
    const matches = text.split(search).length - 1;
    if (matches === 0) throw new Error(`Patch search text not found in ${filePath}`);
    if (!replaceAll && matches !== 1) throw new Error(`Patch search text matched ${matches} times in ${filePath}; set replaceAll:true or make search text unique`);
    const next = replaceAll ? text.split(search).join(replace) : text.replace(search, replace);
    await writeFile(filePath, next, "utf8");
    results.push(`update ${filePath} (${matches} replacement${matches === 1 ? "" : "s"})`);
  }
  return { title: "file patch", output: results.join("\n"), metadata: { operations: results.length } };
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
    const child = spawn("bash", ["-lc", command], { cwd, env: process.env, detached: true });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killShellProcessGroup(child.pid, "SIGTERM", child);
      killTimer = setTimeout(() => killShellProcessGroup(child.pid, "SIGKILL", child), 2_000);
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
      if (killTimer) clearTimeout(killTimer);
      const output = [`$ ${command}`, stdout.trim() ? `\n[stdout]\n${stdout.trimEnd()}` : "", stderr.trim() ? `\n[stderr]\n${stderr.trimEnd()}` : "", truncated ? "\n[truncated]" : ""].join("");
      resolve({ title: "shell exec", output, metadata: { exitCode, signal, cwd, timedOut, truncated } });
    });
  });
}

function killShellProcessGroup(pid: number | undefined, signal: NodeJS.Signals, child: ReturnType<typeof spawn>): void {
  if (!pid) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
    if (code !== "ESRCH") child.kill(signal);
  }
}

async function runWebFetch(rawArgs: unknown): Promise<ToolResult> {
  const args = objectInput(rawArgs);
  const url = new URL(stringArg(args, "url"));
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  if (url.username || url.password) throw new Error("URL credentials are not allowed");
  const timeoutMs = boundedNumber(args.timeoutMs, 30_000, 120_000);
  const maxBytes = boundedNumber(args.maxBytes, 20_000, 100_000);
  let response: Response;
  try {
    const proxyUrl = proxyForUrl(url);
    response = proxyUrl ? await fetchWithDispatcher(url, { signal: AbortSignal.timeout(timeoutMs), dispatcher: webProxyDispatcher(proxyUrl) }) : await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`web.fetch failed for ${url.toString()}: ${errorMessage(error)}`);
  }
  const raw = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  const format = formatArg(args.format);
  const text = format === "raw" ? raw : contentType.includes("html") ? htmlToText(raw) : raw;
  const truncated = text.length > maxBytes;
  return { title: "web fetch", output: truncated ? `${text.slice(0, maxBytes)}\n\n[truncated]` : text, metadata: { url: url.toString(), status: response.status, contentType: contentType || undefined, format, truncated } };
}

function webProxyDispatcher(proxyUrl: string): ProxyAgent {
  assertNodeFetchProxySupported(proxyUrl);
  let dispatcher = webProxyDispatchers.get(proxyUrl);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(proxyUrl);
    webProxyDispatchers.set(proxyUrl, dispatcher);
  }
  return dispatcher;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
  const code = error.cause && typeof error.cause === "object" && "code" in error.cause ? ` [${String(error.cause.code)}]` : "";
  return `${error.message}${cause}${code}`;
}

async function postJson<T = ToolResult>(url: URL, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    throw controllerConnectionError(error);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Request failed: ${response.status}`);
  return (text.trim() ? JSON.parse(text) : {}) as T;
}

function controllerConnectionError(error: unknown): Error {
  return new Error(`Suzumio controller request failed: ${errorMessage(error)}. If the runner is in Docker, start the server with --host 0.0.0.0 and use a container-reachable controllerUrl such as host.docker.internal.`);
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

function textArg(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
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

function arrayArg(value: unknown, key: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value;
}

function readablePath(workspace: string, value: string): string {
  const filePath = resolveFilePath(workspace, value);
  if (isUnder(filePath, "/workspace") || isUnder(filePath, "/artifacts") || isUnder(filePath, "/mnt")) return filePath;
  throw new Error(`Read path must be under /workspace, /artifacts, or /mnt: ${value}`);
}

function writablePath(workspace: string, agentId: string, value: string): string {
  const filePath = resolveFilePath(workspace, value);
  if (isUnder(filePath, "/workspace") || isUnder(filePath, `/artifacts/${agentId}`)) return filePath;
  throw new Error(`Write path must be under /workspace or /artifacts/${agentId}: ${value}`);
}

function resolveFilePath(workspace: string, value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(workspace, value);
}

function isUnder(filePath: string, root: string): boolean {
  const resolved = path.resolve(filePath);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(base + path.sep);
}

function capToolText(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  return `${text.slice(0, maxBytes).trimEnd()}\n\n[truncated ${bytes - maxBytes} bytes]`;
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
  console.error(errorMessage(error));
  process.exit(1);
});
