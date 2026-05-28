#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { jsonSchema, streamText, tool as aiTool, type ModelMessage } from "ai";
import { resolveRunnerModel } from "./runner-model.js";
import type { RunnerTurnInput, RunnerTurnOutput, ToolDefinition } from "./types.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = required(args.input, "--input");
  const outputPath = required(args.output, "--output");
  const input = JSON.parse(await readFile(inputPath, "utf8")) as RunnerTurnInput;
  const output = await runAi(input);
  await writeFile(outputPath, JSON.stringify(output, null, 2) + "\n", "utf8");
}

async function runAi(input: RunnerTurnInput): Promise<RunnerTurnOutput> {
  if (!input.runner.models) throw new Error("runner.models is required in ai mode");
  const resolved = resolveRunnerModel(input.runner.models, input.agent.model ?? input.runner.model);
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
  return { text: text.trim() || "(model returned no text)", usage: { model: resolved.presetId, displayName: resolved.preset.displayName } };
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

function safeToolName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "_");
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
