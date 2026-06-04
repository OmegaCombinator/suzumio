import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { ProjectConfig } from "./types.js";

const JsonObjectSchema = z.record(z.string(), z.unknown());
const DEFAULT_CONTEXT_LIMIT = 260_000;
const MessagePrioritySchema = z.enum(["P0", "P1", "P2"]);

const DEFAULT_ALL_QUIET_NUDGE_MESSAGE = [
  "All agents are quiet and there are no pending work signals for this running project.",
  "Treat this as a coordination stall: ask workers for current progress, tell them to continue, or resend any missing work/review messages. Use targeted messages rather than waiting silently.",
].join("\n\n");

const DEFAULT_NO_EFFECT_NUDGE = { enabled: true, priority: "P2" as const, maxConsecutive: 0, initialDelayMs: 30_000, backoffFactor: 2, maxDelayMs: 300_000 };
const DEFAULT_ALL_QUIET_NUDGE = { enabled: false, targetAgent: "pm", priority: "P2" as const, cooldownMs: 300_000, message: DEFAULT_ALL_QUIET_NUDGE_MESSAGE };

const SchedulerSchema = z.preprocess(
  (value) => {
    if (!isPlainObject(value)) return value;
    const out = { ...value };
    if (out.maxSignalsPerActivation === undefined && out.maxPromptMessages !== undefined) out.maxSignalsPerActivation = out.maxPromptMessages;
    delete out.maxPromptMessages;
    return out;
  },
  z
    .object({
      kind: z.enum(["nonpreemptive-mailbox", "nonpreemptive-signals"]).default("nonpreemptive-signals"),
      maxSignalsPerActivation: z.number().int().positive().default(20),
      noEffectNudge: z
        .object({
          enabled: z.boolean().default(true),
          priority: MessagePrioritySchema.default("P2"),
          maxConsecutive: z.number().int().min(0).default(0),
          initialDelayMs: z.number().int().min(0).default(30_000),
          backoffFactor: z.number().min(1).default(2),
          maxDelayMs: z.number().int().min(0).default(300_000),
        })
        .default(DEFAULT_NO_EFFECT_NUDGE),
      allQuietNudge: z
        .object({
          enabled: z.boolean().default(false),
          targetAgent: z.string().min(1).default("pm"),
          priority: MessagePrioritySchema.default("P2"),
          cooldownMs: z.number().int().positive().default(300_000),
          message: z.string().min(1).default(DEFAULT_ALL_QUIET_NUDGE_MESSAGE),
        })
        .default(DEFAULT_ALL_QUIET_NUDGE),
    })
    .default({ kind: "nonpreemptive-signals", maxSignalsPerActivation: 20, noEffectNudge: DEFAULT_NO_EFFECT_NUDGE, allQuietNudge: DEFAULT_ALL_QUIET_NUDGE }),
);

const CommunicationSchema = z
  .object({
    coordinatorAgent: z.string().min(1).default("pm"),
    restrictNonCoordinatorToCoordinator: z.boolean().default(false),
    nonCoordinatorMaxPriority: MessagePrioritySchema.default("P2"),
    pmRoutineVerifierPriority: MessagePrioritySchema.default("P2"),
  })
  .default({ coordinatorAgent: "pm", restrictNonCoordinatorToCoordinator: false, nonCoordinatorMaxPriority: "P2", pmRoutineVerifierPriority: "P2" });

const ProviderSchema = z.object({
  type: z.enum(["openai", "anthropic", "google", "openai-compatible"]),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  baseURL: z.string().optional(),
  baseURLEnv: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.union([z.number().int().positive(), z.literal(false)]).optional(),
  chunkTimeoutMs: z.number().int().positive().optional(),
  options: JsonObjectSchema.default({}),
});

const ModelPresetSchema = z.preprocess(
  (value) => {
    if (!isPlainObject(value)) return value;
    const out = { ...value };
    if (out.modelList === undefined && out["model-list"] !== undefined) out.modelList = out["model-list"];
    delete out["model-list"];
    return out;
  },
  z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      modelList: z.array(z.string()).optional(),
      apiModel: z.string().optional(),
      reasoningEffort: z.string().optional(),
      temperature: z.number().optional(),
      topP: z.number().optional(),
      topK: z.number().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      contextLimit: z.number().int().positive().default(DEFAULT_CONTEXT_LIMIT),
      toolChoice: z.enum(["auto", "required", "none"]).optional(),
      providerOptions: JsonObjectSchema.default({}),
      headers: z.record(z.string(), z.string()).default({}),
    })
    .superRefine((preset, ctx) => {
      const isList = preset.modelList !== undefined;
      const isConcrete = preset.provider !== undefined || preset.model !== undefined || preset.apiModel !== undefined;
      if (isList && isConcrete) ctx.addIssue({ code: "custom", message: "modelList presets cannot also set provider/model/apiModel" });
      if (!isList && (!preset.provider || !preset.model)) ctx.addIssue({ code: "custom", message: "model presets need provider and model, or model-list" });
      if (isList && preset.modelList!.length === 0) ctx.addIssue({ code: "custom", message: "model-list cannot be empty" });
    }),
);

const ModelsSchema = z.object({
  providers: z.record(z.string(), ProviderSchema).default({}),
  presets: z.record(z.string(), ModelPresetSchema).default({}),
});

const ToolsSchema = z
  .object({
    toolpacks: z
      .array(
        z.union([
          z.string().min(1),
          z.object({
            id: z.string().min(1).optional(),
            path: z.string().min(1),
          }),
        ]),
      )
      .default(["core", "web"]),
  })
  .default({ toolpacks: ["core", "web"] });

const RunnerSchema = z
  .object({
    mode: z.literal("ai").default("ai"),
    model: z.string().optional(),
    maxIterations: z.number().int().positive().optional(),
    maxToolCalls: z.number().int().positive().optional(),
    finalPrompt: z.string().optional(),
    models: ModelsSchema.optional(),
  })
  .default({ mode: "ai" });

const MountSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  readonly: z.boolean().default(true),
  description: z.string().optional(),
});

const OptionalEnvString = z.preprocess((value) => (value === "" || value === null ? undefined : value), z.string().optional());

const DockerProxySchema = z
  .object({
    inheritEnv: z.boolean().default(true),
    http: OptionalEnvString,
    https: OptionalEnvString,
    all: OptionalEnvString,
    noProxy: OptionalEnvString,
    rewriteLocalhost: z.boolean().default(true),
  })
  .default({ inheritEnv: true, rewriteLocalhost: true });

const BackendSchema = z
  .object({
    kind: z.literal("docker-chat").default("docker-chat"),
    image: z.string().default("suzumio-runner:dev"),
    controllerUrl: z.string().default("http://host.docker.internal:39400"),
    docker: z
      .object({
        network: z.string().optional(),
        memory: z.string().optional(),
        cpus: z.number().positive().optional(),
        mounts: z.array(MountSchema).default([]),
        proxy: DockerProxySchema,
      })
      .default({ mounts: [], proxy: { inheritEnv: true, rewriteLocalhost: true } }),
    runner: RunnerSchema,
  })
  .default({ kind: "docker-chat", image: "suzumio-runner:dev", controllerUrl: "http://host.docker.internal:39400", docker: { mounts: [], proxy: { inheritEnv: true, rewriteLocalhost: true } }, runner: { mode: "ai" } });

const AgentSchema = z.object({
  role: z.string().optional(),
  displayName: z.string().optional(),
  names: z.array(z.string()).optional(),
  count: z.number().int().positive().optional(),
  prompt: z.string().default(""),
  model: z.string().optional(),
  tools: z.array(z.string()).default([]),
  mounts: z.array(MountSchema).default([]),
  env: z.record(z.string(), z.string()).default({}),
  workspace: z.string().optional(),
});

const ProjectConfigSchema = z.object({
  name: z.string().min(1),
  task: z.string().min(1),
  extends: z.array(z.unknown()).optional(),
  scheduler: SchedulerSchema,
  communication: CommunicationSchema,
  backend: BackendSchema,
  agents: z.record(z.string(), AgentSchema).default({}),
  channels: z.array(z.string()).default(["#project", "#blocked"]),
  tools: ToolsSchema,
  observability: z
    .object({
      http: z
        .object({
          enabled: z.boolean().default(true),
          host: z.string().default("127.0.0.1"),
          port: z.number().int().positive().default(39400),
        })
        .default({ enabled: true, host: "127.0.0.1", port: 39400 }),
      webui: z
        .object({
          enabled: z.boolean().default(true),
        })
        .default({ enabled: true }),
    })
    .default({ http: { enabled: true, host: "127.0.0.1", port: 39400 }, webui: { enabled: true } }),
});

export type LoadedProjectConfig = {
  config: ProjectConfig;
  sourcePath: string;
  resolved: unknown;
};

export async function loadProjectConfig(filePath: string): Promise<LoadedProjectConfig> {
  const sourcePath = path.resolve(filePath);
  const imported = await loadAny(sourcePath, []);
  const resolved = resolveExtends(imported);
  const config = ProjectConfigSchema.parse(resolved) as ProjectConfig;
  normalizeMountSources(config, path.dirname(sourcePath));
  await normalizeToolpacks(config, path.dirname(sourcePath));
  validateRunnerModels(config);
  if (Object.keys(config.agents).length === 0) throw new Error("Project config needs at least one agent");
  return { config, sourcePath, resolved: externalizeProjectConfig(config) };
}

export async function renderProjectConfig(filePath: string): Promise<string> {
  const loaded = await loadProjectConfig(filePath);
  return YAML.stringify(loaded.resolved, { lineWidth: 120 });
}

async function loadAny(filePath: string, stack: string[]): Promise<unknown> {
  const resolved = path.resolve(filePath);
  if (stack.includes(resolved)) throw new Error(`Circular @import detected: ${[...stack, resolved].join(" -> ")}`);
  if (stack.length > 32) throw new Error("Maximum @import depth exceeded");
  const text = await readFile(resolved, "utf8");
  const ext = path.extname(resolved).toLowerCase();
  if (ext === ".yaml" || ext === ".yml") {
    const parsed = YAML.parse(quoteBareImports(substituteEnv(text))) ?? {};
    return resolveImports(parsed, path.dirname(resolved), [...stack, resolved]);
  }
  if (ext === ".json") {
    return resolveImports(JSON.parse(substituteEnv(text)), path.dirname(resolved), [...stack, resolved]);
  }
  return text;
}

async function resolveImports(value: unknown, directory: string, stack: string[]): Promise<unknown> {
  const imported = importPath(value);
  if (imported) return loadAny(path.resolve(directory, imported), stack);
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveImports(item, directory, stack)));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = await resolveImports(item, directory, stack);
    return out;
  }
  return value;
}

function resolveExtends(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const bases = Array.isArray(value.extends) ? value.extends : [];
  const own = { ...value };
  delete own.extends;
  let merged: unknown = {};
  for (const base of bases) merged = mergeDeep(merged, resolveExtends(base));
  return mergeDeep(merged, mapValues(own, resolveExtends));
}

export function mergeDeep(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override === undefined ? base : override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? mergeDeep(out[key], value) : value;
  }
  return out;
}

function mapValues(value: Record<string, unknown>, f: (value: unknown) => unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, f(item)]));
}

function importPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^@import\(([^)]+)\)$/);
  if (!match) return undefined;
  const imported = match[1]!.trim();
  if (/^https?:\/\//i.test(imported)) throw new Error("HTTP(S) @import is disabled for reproducibility");
  return imported;
}

function quoteBareImports(text: string): string {
  const whole = text.trim();
  if (/^@import\([^)]+\)$/.test(whole)) return JSON.stringify(whole);
  return text
    .replace(/^(\s*[^#\n][^:\n]*:\s*)@import\(([^)\n]+)\)(\s*(?:#.*)?)$/gm, (_m, prefix, imported, suffix) => `${prefix}"@import(${imported})"${suffix}`)
    .replace(/^(\s*-\s*)@import\(([^)\n]+)\)(\s*(?:#.*)?)$/gm, (_m, prefix, imported, suffix) => `${prefix}"@import(${imported})"${suffix}`);
}

function substituteEnv(text: string): string {
  return text.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, key: string) => process.env[key] ?? "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeMountSources(config: ProjectConfig, baseDir: string): void {
  const mounts = [...(config.backend.docker?.mounts ?? []), ...Object.values(config.agents).flatMap((agent) => agent.mounts ?? [])];
  for (const mount of mounts) {
    if (!path.isAbsolute(mount.source)) mount.source = path.resolve(baseDir, mount.source);
    if (!mount.target.startsWith("/")) throw new Error(`Docker mount target must be absolute: ${mount.target}`);
    const target = path.posix.normalize(mount.target);
    if (target === "/activation" || target.startsWith("/activation/") || target === "/workspace" || target.startsWith("/workspace/") || target === "/artifacts" || target.startsWith("/artifacts/")) {
      throw new Error(`Docker mount target is reserved: ${mount.target}`);
    }
    mount.target = target;
  }
}

async function normalizeToolpacks(config: ProjectConfig, baseDir: string): Promise<void> {
  const builtins = new Set(["core", "shell", "web"]);
  for (const entry of config.tools.toolpacks) {
    if (typeof entry === "string") {
      if (!builtins.has(entry)) throw new Error(`Unknown built-in toolpack: ${entry}. Use { path: ... } for local toolpacks.`);
      continue;
    }
    if (/^https?:\/\//i.test(entry.path)) throw new Error("HTTP(S) toolpack paths are disabled for reproducibility");
    if (!path.isAbsolute(entry.path)) entry.path = path.resolve(baseDir, entry.path);
    const info = await stat(entry.path);
    if (!info.isDirectory()) throw new Error(`Local toolpack path must be a directory: ${entry.path}`);
    await stat(path.join(entry.path, "suzumio.toolpack.json"));
  }
}

function externalizeConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(externalizeConfig);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key === "modelList" ? "model-list" : key] = externalizeConfig(item);
  }
  return out;
}

function externalizeProjectConfig(config: ProjectConfig): unknown {
  const out = externalizeConfig(config) as Record<string, unknown>;
  const scheduler = out.scheduler;
  if (isPlainObject(scheduler)) {
    if (scheduler.kind === "nonpreemptive-signals") delete scheduler.kind;
    if (scheduler.maxSignalsPerActivation === 20) delete scheduler.maxSignalsPerActivation;
    if (Object.keys(scheduler).length === 0) delete out.scheduler;
  }
  return out;
}

function validateRunnerModels(config: ProjectConfig): void {
  const runner = config.backend.runner;
  if (!runner.models) throw new Error("backend.runner.models is required");
  if (Object.keys(runner.models.providers).length === 0) throw new Error("backend.runner.models.providers needs at least one provider");
  if (Object.keys(runner.models.presets).length === 0) throw new Error("backend.runner.models.presets needs at least one preset");
  for (const [id, agent] of Object.entries(config.agents)) {
    const selected = agent.model ?? runner.model;
    if (!selected) throw new Error(`Agent ${id} needs an explicit model, or set backend.runner.model`);
    if (!runner.models.presets[selected]) throw new Error(`Agent ${id} selected unknown model preset: ${selected}`);
  }
}
