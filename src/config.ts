import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { ProjectConfig } from "./types.js";

const JsonObjectSchema = z.record(z.string(), z.unknown());

const SchedulerSchema = z
  .object({
    kind: z.literal("nonpreemptive-mailbox").default("nonpreemptive-mailbox"),
    intervalMs: z.number().int().positive().default(2_000),
    maxPromptMessages: z.number().int().positive().default(20),
  })
  .default({ kind: "nonpreemptive-mailbox", intervalMs: 2_000, maxPromptMessages: 20 });

const ProviderSchema = z.object({
  type: z.enum(["openai", "anthropic", "google", "openai-compatible"]),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  baseURL: z.string().optional(),
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
      temperature: z.number().optional(),
      topP: z.number().optional(),
      topK: z.number().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      contextLimit: z.number().int().positive().optional(),
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
    toolpacks: z.array(z.enum(["core", "artifacts", "web"])).default(["core", "artifacts", "web"]),
  })
  .default({ toolpacks: ["core", "artifacts", "web"] });

const RunnerSchema = z
  .object({
    mode: z.literal("ai").default("ai"),
    model: z.string().optional(),
    maxIterations: z.number().int().positive().default(8),
    maxToolCalls: z.number().int().positive().default(20),
    finalPrompt: z.string().optional(),
    models: ModelsSchema.optional(),
  })
  .default({ mode: "ai", maxIterations: 8, maxToolCalls: 20 });

const MountSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  readonly: z.boolean().default(true),
  description: z.string().optional(),
});

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
      })
      .default({ mounts: [] }),
    runner: RunnerSchema,
  })
  .default({ kind: "docker-chat", image: "suzumio-runner:dev", controllerUrl: "http://host.docker.internal:39400", docker: { mounts: [] }, runner: { mode: "ai", maxIterations: 8, maxToolCalls: 20 } });

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
  validateRunnerModels(config);
  if (Object.keys(config.agents).length === 0) throw new Error("Project config needs at least one agent");
  return { config, sourcePath, resolved: externalizeConfig(config) };
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
    if (target === "/turn" || target.startsWith("/turn/") || target === "/workspace" || target.startsWith("/workspace/")) {
      throw new Error(`Docker mount target is reserved: ${mount.target}`);
    }
    mount.target = target;
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
