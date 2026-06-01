#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { jsonSchema, stepCountIs, streamText, tool as aiTool, type ModelMessage } from "ai";
import { resolveRunnerModels, type ResolvedRunnerModel } from "./runner-model.js";
import { assertNodeFetchProxySupported, proxyForUrl } from "./proxy.js";
import type { JsonObject, RunnerActivationInput, RunnerActivationOutput, RunnerToolpackSpec, ToolDefinition } from "./types.js";

type ToolResult = { title?: string; output: string; metadata?: JsonObject };
type RunnerToolHandler = (input: unknown) => Promise<ToolResult>;
type RegisteredTool = { definition: ToolDefinition; toolpack: RunnerToolpackSpec; handler: RunnerToolHandler };
type ToolCallLimiter = () => void;
type EndActivationCallback = (output: string) => void;
type ActivationEnded = () => boolean;
type FetchWithDispatcher = (url: Parameters<typeof fetch>[0], init?: RequestInit & { dispatcher: Dispatcher }) => ReturnType<typeof fetch>;
type TokenUsage = { input?: number; output?: number; total?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number };
type SessionContextTurn = { userPrompt?: string; assistant: string; toolActivity?: string[]; usage?: TokenUsage; createdAt: string };
type SessionContextState = { version: 1; originalPrompt: string; summary?: string; turns: SessionContextTurn[]; updatedAt?: string };

const fetchWithDispatcher = undiciFetch as unknown as FetchWithDispatcher;
const webProxyDispatchers = new Map<string, ProxyAgent>();
const EFFECTIVELY_UNBOUNDED_STEPS = 1_000_000;
const SESSION_CONTEXT_VERSION = 1;
const SESSION_CONTEXT_DIR = ".suzumio";
const SESSION_CONTEXT_FILE = "session-context.json";
const DEFAULT_CONTEXT_LIMIT = 120_000;
const COMPACTION_BUFFER = 20_000;
const DEFAULT_TAIL_TURNS = 2;
const MAX_TURN_CHARS = 20_000;
const MAX_TOOL_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 20_000;
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
  let toolCalls = 0;
  const abortController = new AbortController();
  let activationEnded = false;
  let endActivationOutput: string | undefined;
  const sessionContext = await loadSessionContext(input);
  const firstPrompt = isFirstPrompt(sessionContext, input.activation.prompt);
  const toolTranscript: string[] = [];
  const tools = await toAiTools(input, () => {
    toolCalls += 1;
    if (input.runner.maxToolCalls !== undefined && toolCalls > input.runner.maxToolCalls) throw new Error(`Exceeded maxToolCalls: ${input.runner.maxToolCalls}`);
  }, (output) => {
    activationEnded = true;
    endActivationOutput = output;
    abortController.abort();
  }, () => activationEnded, (toolName, result) => {
    toolTranscript.push(renderToolTranscript(toolName, result));
  });
  const messages = sessionMessages(input, sessionContext, firstPrompt);
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
    await saveSessionTurn(input, resolved, sessionContext, firstPrompt, completed.text, toolTranscript, usage);
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

async function loadSessionContext(input: RunnerActivationInput): Promise<SessionContextState> {
  try {
    const parsed = JSON.parse(await readFile(sessionContextPath(input), "utf8")) as Partial<SessionContextState>;
    if (parsed.version === SESSION_CONTEXT_VERSION && typeof parsed.originalPrompt === "string" && Array.isArray(parsed.turns)) {
      return {
        version: SESSION_CONTEXT_VERSION,
        originalPrompt: parsed.originalPrompt,
        summary: optionalString(parsed.summary),
        turns: parsed.turns.filter(isSessionContextTurn),
        updatedAt: optionalString(parsed.updatedAt),
      };
    }
  } catch (error) {
    if (!(error instanceof Error) || !errorMessage(error).includes("ENOENT")) throw error;
  }
  return { version: SESSION_CONTEXT_VERSION, originalPrompt: input.activation.prompt, turns: [] };
}

async function saveSessionTurn(input: RunnerActivationInput, resolved: ResolvedRunnerModel, state: SessionContextState, firstPrompt: boolean, assistantText: string, toolTranscript: string[], usage: TokenUsage | undefined): Promise<void> {
  const next: SessionContextState = {
    ...state,
    turns: [
      ...state.turns,
      {
        userPrompt: firstPrompt ? undefined : trimChars(input.activation.prompt, MAX_TURN_CHARS),
        assistant: trimChars(assistantText, MAX_TURN_CHARS),
        toolActivity: toolTranscript.length ? toolTranscript.map((item) => trimChars(item, MAX_TOOL_CHARS)) : undefined,
        usage,
        createdAt: new Date().toISOString(),
      },
    ],
    updatedAt: new Date().toISOString(),
  };
  await writeSessionContext(input, usage && isOverflow(usage, resolved) ? await compactSessionContext(input, resolved, next) : next);
}

async function compactSessionContext(input: RunnerActivationInput, resolved: ResolvedRunnerModel, state: SessionContextState): Promise<SessionContextState> {
  const head = state.turns.slice(0, -DEFAULT_TAIL_TURNS);
  const tail = state.turns.slice(-DEFAULT_TAIL_TURNS);
  if (head.length === 0) return { ...state, turns: tail };
  return {
    ...state,
    summary: trimChars(await summarizeSessionContext(input, resolved, state.summary, state.originalPrompt, head), MAX_SUMMARY_CHARS),
    turns: tail,
    updatedAt: new Date().toISOString(),
  };
}

async function summarizeSessionContext(input: RunnerActivationInput, resolved: ResolvedRunnerModel, previousSummary: string | undefined, originalPrompt: string, turns: SessionContextTurn[]): Promise<string> {
  const anchor = previousSummary
    ? [
        "Update the anchored summary below using the conversation history above.",
        "Preserve still-true details, remove stale details, and merge in the new facts.",
        "<previous-summary>",
        previousSummary,
        "</previous-summary>",
      ].join("\n")
    : "Create a new anchored summary from the conversation history above.";
  const prompt = [
    "You are compacting a long-running autonomous agent session for future continuation.",
    "Preserve the exact target, constraints, proof state, important lemmas, computations, file paths, commands, errors, artifact paths, verification facts, blockers, and next steps. Remove chatter and duplicated attempts.",
    anchor,
    SUMMARY_TEMPLATE,
    "# Original Prompt",
    originalPrompt,
    "# Conversation History",
    ...turns.map(renderTurnForSummary),
  ].join("\n\n");
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
  return text.trim() || previousSummary || "No durable session facts were recovered.";
}

function sessionMessages(input: RunnerActivationInput, state: SessionContextState, firstPrompt: boolean): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: "user", content: state.originalPrompt }];
  if (state.summary) messages.push({ role: "user", content: `# Compacted Session Summary\n\n${state.summary}` });
  for (const turn of state.turns) {
    if (turn.userPrompt) messages.push({ role: "user", content: turn.userPrompt });
    messages.push({ role: "assistant", content: renderTurnAssistant(turn) });
  }
  if (!firstPrompt) messages.push({ role: "user", content: input.activation.prompt });
  return messages;
}

async function writeSessionContext(input: RunnerActivationInput, state: SessionContextState): Promise<void> {
  await mkdir(path.dirname(sessionContextPath(input)), { recursive: true });
  await writeFile(sessionContextPath(input), JSON.stringify(state, null, 2) + "\n", "utf8");
}

function sessionContextPath(input: RunnerActivationInput): string {
  return path.join(input.workspace, SESSION_CONTEXT_DIR, SESSION_CONTEXT_FILE);
}

function isSessionContextTurn(value: unknown): value is SessionContextTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const turn = value as Record<string, unknown>;
  return (turn.userPrompt === undefined || typeof turn.userPrompt === "string") && typeof turn.assistant === "string" && typeof turn.createdAt === "string" && (turn.toolActivity === undefined || Array.isArray(turn.toolActivity));
}

function isFirstPrompt(state: SessionContextState, prompt: string): boolean {
  return state.turns.length === 0 && !state.summary && state.originalPrompt === prompt;
}

function isOverflow(usage: TokenUsage, resolved: ResolvedRunnerModel): boolean {
  return totalTokens(usage) >= usableContextTokens(resolved);
}

function usableContextTokens(resolved: ResolvedRunnerModel): number {
  const context = resolved.preset.contextLimit ?? DEFAULT_CONTEXT_LIMIT;
  const reserved = Math.min(COMPACTION_BUFFER, resolved.preset.maxOutputTokens ?? SUMMARY_OUTPUT_TOKENS);
  return Math.max(0, context - reserved);
}

function totalTokens(usage: TokenUsage): number {
  return usage.total ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.reasoning ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
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

function trimChars(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n[truncated ${trimmed.length - maxChars} chars]`;
}

function renderTurnAssistant(turn: SessionContextTurn): string {
  return [turn.assistant, turn.toolActivity?.length ? ["# Tool Activity", ...turn.toolActivity].join("\n\n") : undefined].filter(Boolean).join("\n\n");
}

function renderTurnForSummary(turn: SessionContextTurn): string {
  return [
    `## Turn ${turn.createdAt}`,
    turn.userPrompt ? `### User\n${turn.userPrompt}` : undefined,
    `### Assistant\n${turn.assistant}`,
    turn.toolActivity?.length ? ["### Tool Activity", ...turn.toolActivity].join("\n\n") : undefined,
    turn.usage ? `### Token Usage\n${JSON.stringify(turn.usage)}` : undefined,
  ].filter(Boolean).join("\n\n");
}

function renderToolTranscript(toolName: string, result: ToolResult): string {
  return trimChars([`## ${toolName}${result.title ? `: ${result.title}` : ""}`, result.output].join("\n"), MAX_TOOL_CHARS);
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

async function toAiTools(input: RunnerActivationInput, limitToolCall: ToolCallLimiter, endActivation: EndActivationCallback, activationEnded: ActivationEnded, recordToolResult?: (toolName: string, result: ToolResult) => void): Promise<Record<string, unknown>> {
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
        recordToolResult?.(registered.definition.name, toolResult);
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
  await finishToolCall(input, toolCall.toolCallId, "completed", result.output);
  if (endsActivation(registered.definition.name)) endActivation(result.output);
  return result;
}

function endsActivation(toolName: string): boolean {
  return toolName === "coordination.wait_for_signal" || toolName === "completion.submit";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message.toLowerCase().includes("abort"));
}

async function finishToolCall(input: RunnerActivationInput, toolCallId: string, status: "completed" | "failed", output?: string, error?: string): Promise<void> {
  await postJson(new URL("/runner/tool-calls/finish", input.controllerUrl), {
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
  console.error(errorMessage(error));
  process.exit(1);
});
