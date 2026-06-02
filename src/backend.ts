import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import Docker from "dockerode";
import { safeName } from "./id.js";
import type { ActivationRecord, AgentConfig, AgentRecord, DockerMountConfig, ProjectConfig, RunnerActivationInput, RunnerToolpackSpec } from "./types.js";
import { ProjectStore } from "./store.js";
import { isAllowed, resolveToolpacks, type ResolvedToolpack } from "./tools.js";
import { proxyEnvForContainer } from "./proxy.js";

export class DockerChatBackend {
  private readonly docker = new Docker();

  constructor(private readonly root?: string) {}

  async startActivation(store: ProjectStore, agent: AgentRecord, activation: ActivationRecord, prompt: string): Promise<void> {
    const config = store.config();
    const toolpacks = await resolveToolpacks(config.tools.toolpacks);
    const agents = store.listAgents();
    const runnerToolpacks = runnerToolpackSpecs(toolpacks, agent);
    const activationDir = path.dirname(activation.inputPath);
    await mkdir(activationDir, { recursive: true });
    const input: RunnerActivationInput = {
      project: store.project,
      agent: { id: agent.id, displayName: agent.displayName, role: agent.role, prompt: agent.prompt, model: agent.model },
      activation: { id: activation.id, prompt },
      workspace: "/workspace",
      controllerUrl: config.backend.controllerUrl,
      token: agent.token,
      runner: config.backend.runner,
      tools: runnerToolpacks.flatMap((toolpack) => toolpack.tools),
      toolpacks: runnerToolpacks,
      history: store.activeAgentHistory(agent.id),
    };
    await writeFile(activation.inputPath, JSON.stringify(input, null, 2) + "\n", "utf8");
    const containerName = safeName(`suzumio_${store.project}_${agent.id}_${activation.id}`);
    await ensureArtifactDirs(store.paths.artifacts, agents);
    const container = await this.createContainer(config, agent, agents, activation, containerName, toolpacks, store.paths.artifacts);
    store.setActivationContainer(activation.id, containerName);
    await container.start();
    void this.monitor(store.project, activation.id, container.id).catch((error) => {
      const next = new ProjectStore(store.project, this.root);
      try {
        next.failActivation(activation.id, error instanceof Error ? error.message : String(error));
      } finally {
        next.close();
      }
    });
  }

  async stopActivation(activation: ActivationRecord): Promise<void> {
    if (!activation.containerName) return;
    const container = this.docker.getContainer(activation.containerName);
    try {
      await container.stop({ t: 2 });
    } catch (error) {
      if (dockerStatusCode(error) === 304 || dockerStatusCode(error) === 404) return;
      try {
        await container.kill();
      } catch (killError) {
        if (dockerStatusCode(killError) !== 304 && dockerStatusCode(killError) !== 404) throw killError;
      }
    }
  }

  private async createContainer(config: ProjectConfig, agent: AgentRecord, agents: AgentRecord[], activation: ActivationRecord, containerName: string, toolpacks: ResolvedToolpack[], artifactsRoot: string): Promise<Docker.Container> {
    const spec = agentSpec(config, agent);
    const proxy = config.backend.docker?.proxy;
    const env = [
      `SUZUMIO_PROJECT=${activation.project}`,
      `SUZUMIO_AGENT=${agent.id}`,
      `SUZUMIO_ACTIVATION=${activation.id}`,
      `SUZUMIO_TOKEN=${agent.token}`,
      ...modelEnv(config),
      ...proxyEnvForContainer({ ...(proxy ?? {}), rewriteLocalhost: config.backend.docker?.network !== "host" && proxy?.rewriteLocalhost !== false }),
      ...Object.entries(spec?.env ?? {}).map(([key, value]) => `${key}=${value}`),
    ];
    const binds = [
      `${activation.inputPath}:/activation/input.json:ro`,
      `${agent.workspacePath}:/workspace:rw`,
      ...artifactBinds(artifactsRoot, agent, agents),
      ...(await mountBinds([...(config.backend.docker?.mounts ?? []), ...(spec?.mounts ?? [])])),
      ...toolpackBinds(toolpacks),
    ];
    return this.docker.createContainer({
      name: containerName,
      Image: config.backend.image,
      Cmd: ["--input", "/activation/input.json"],
      WorkingDir: "/workspace",
      Env: env,
      HostConfig: {
        AutoRemove: false,
        ExtraHosts: ["host.docker.internal:host-gateway"],
        NetworkMode: config.backend.docker?.network,
        Binds: binds,
      },
    });
  }

  private async monitor(project: string, activationId: string, containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    const result = await container.wait();
    const store = new ProjectStore(project, this.root);
    try {
      const activation = store.activation(activationId);
      if (activation.status !== "running") return;
      if (result.StatusCode !== 0) {
        const logs = await container.logs({ stdout: true, stderr: true, tail: 200 }).catch(() => Buffer.from(""));
        store.failActivation(activationId, `Runner exited with ${result.StatusCode}\n${logs.toString("utf8")}`.trim());
        return;
      }
      const completed = store.activation(activation.id);
      if (completed.status !== "completed") store.failActivation(activationId, "Runner exited without submitting activation output");
    } finally {
      store.close();
    }
  }
}

function dockerStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === "number" ? value : undefined;
}

async function ensureArtifactDirs(artifactsRoot: string, agents: AgentRecord[]): Promise<void> {
  await Promise.all(agents.map((agent) => mkdir(path.join(artifactsRoot, agent.id), { recursive: true })));
}

function artifactBinds(artifactsRoot: string, agent: AgentRecord, agents: AgentRecord[]): string[] {
  return agents.map((item) => `${path.join(artifactsRoot, item.id)}:/artifacts/${item.id}:${item.id === agent.id ? "rw" : "ro"}`);
}

function agentSpec(config: ProjectConfig, agent: AgentRecord): AgentConfig | undefined {
  return config.agents[agent.id] ?? config.agents[agent.id.replace(/-\d+$/, "")];
}

function runnerToolpackSpecs(toolpacks: ResolvedToolpack[], agent: AgentRecord): RunnerToolpackSpec[] {
  const specs: RunnerToolpackSpec[] = [];
  for (const toolpack of toolpacks) {
    const tools = toolpack.tools.filter((tool) => isAllowed(tool.name, agent.tools));
    if (tools.length === 0) continue;
    const runnerModule = toolpack.kind === "builtin" ? toolpack.runnerModule : localRunnerModule(toolpack);
    specs.push({ id: toolpack.id, tools, runnerModule, supportPath: `/toolpacks/${encodeURIComponent(toolpack.id)}/support` });
  }
  return specs;
}

function localRunnerModule(toolpack: ResolvedToolpack): string {
  if (!toolpack.root) throw new Error(`Local toolpack ${toolpack.id} is missing root`);
  const relative = path.relative(toolpack.root, toolpack.runnerModule).split(path.sep).join("/");
  return path.posix.join(toolpackTarget(toolpack), relative);
}

function toolpackBinds(toolpacks: ResolvedToolpack[]): string[] {
  return toolpacks.filter((toolpack) => toolpack.kind === "local" && toolpack.root).map((toolpack) => `${toolpack.root}:${toolpackTarget(toolpack)}:ro`);
}

function toolpackTarget(toolpack: ResolvedToolpack): string {
  return `/toolpacks/${safeName(toolpack.id)}`;
}

async function mountBinds(mounts: DockerMountConfig[]): Promise<string[]> {
  const binds: string[] = [];
  for (const mount of mounts) {
    await stat(mount.source);
    const target = path.posix.normalize(mount.target);
    if (!target.startsWith("/")) throw new Error(`Docker mount target must be absolute: ${mount.target}`);
    if (target === "/activation" || target.startsWith("/activation/") || target === "/workspace" || target.startsWith("/workspace/") || target === "/artifacts" || target.startsWith("/artifacts/")) throw new Error(`Docker mount target is reserved: ${mount.target}`);
    binds.push(`${mount.source}:${target}:${mount.readonly ? "ro" : "rw"}`);
  }
  return binds;
}

function modelEnv(config: ProjectConfig): string[] {
  const env: string[] = [];
  for (const provider of Object.values(config.backend.runner.models?.providers ?? {})) {
    for (const key of [provider.apiKeyEnv, provider.baseURLEnv]) {
      if (!key) continue;
      const value = process.env[key];
      if (value) env.push(`${key}=${value}`);
    }
  }
  return env;
}
