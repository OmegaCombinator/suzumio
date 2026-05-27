import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import Docker from "dockerode";
import { safeName } from "./id.js";
import type { AgentRecord, ProjectConfig, RunnerTurnInput, RunnerTurnOutput, TurnRecord } from "./types.js";
import { ProjectStore } from "./store.js";
import { toolDefinitions } from "./tools.js";

export class DockerChatBackend {
  private readonly docker = new Docker();

  constructor(private readonly root?: string) {}

  async startTurn(store: ProjectStore, agent: AgentRecord, turn: TurnRecord, prompt: string): Promise<void> {
    const config = store.config();
    const turnDir = path.dirname(turn.inputPath);
    await mkdir(turnDir, { recursive: true });
    const input: RunnerTurnInput = {
      project: store.project,
      agent: { id: agent.id, role: agent.role, prompt: agent.prompt, model: agent.model },
      turn: { id: turn.id, prompt },
      workspace: "/workspace",
      controllerUrl: config.backend.controllerUrl,
      token: agent.token,
      runner: config.backend.runner,
      tools: toolDefinitions(agent),
    };
    await writeFile(turn.inputPath, JSON.stringify(input, null, 2) + "\n", "utf8");
    const containerName = safeName(`suzumio_${store.project}_${agent.id}_${turn.id}`);
    const container = await this.createContainer(config, agent, turn, containerName);
    store.setTurnContainer(turn.id, containerName);
    await container.start();
    void this.monitor(store.project, turn.id, container.id).catch((error) => {
      const next = new ProjectStore(store.project, this.root);
      try {
        next.failTurn(turn.id, error instanceof Error ? error.message : String(error));
      } finally {
        next.close();
      }
    });
  }

  private async createContainer(config: ProjectConfig, agent: AgentRecord, turn: TurnRecord, containerName: string): Promise<Docker.Container> {
    const env = [
      `SUZUMIO_PROJECT=${turn.project}`,
      `SUZUMIO_AGENT=${agent.id}`,
      `SUZUMIO_TURN=${turn.id}`,
      `SUZUMIO_TOKEN=${agent.token}`,
      ...modelEnv(config),
      ...Object.entries(config.agents[agent.id]?.env ?? {}).map(([key, value]) => `${key}=${value}`),
    ];
    return this.docker.createContainer({
      name: containerName,
      Image: config.backend.image,
      Cmd: ["--input", "/turn/input.json", "--output", "/turn/output.json"],
      WorkingDir: "/workspace",
      Env: env,
      HostConfig: {
        AutoRemove: false,
        ExtraHosts: ["host.docker.internal:host-gateway"],
        NetworkMode: config.backend.docker?.network,
        Binds: [`${path.dirname(turn.inputPath)}:/turn:rw`, `${agent.workspacePath}:/workspace:rw`],
      },
    });
  }

  private async monitor(project: string, turnId: string, containerId: string): Promise<void> {
    const container = this.docker.getContainer(containerId);
    const result = await container.wait();
    const store = new ProjectStore(project, this.root);
    try {
      const turn = store.turn(turnId);
      if (result.StatusCode !== 0) {
        const logs = await container.logs({ stdout: true, stderr: true, tail: 200 }).catch(() => Buffer.from(""));
        store.failTurn(turnId, `Runner exited with ${result.StatusCode}\n${logs.toString("utf8")}`.trim());
        return;
      }
      const output = JSON.parse(await readFile(turn.outputPath, "utf8")) as RunnerTurnOutput;
      store.completeTurn(turnId, output);
    } finally {
      store.close();
    }
  }
}

function modelEnv(config: ProjectConfig): string[] {
  const env: string[] = [];
  for (const provider of Object.values(config.backend.runner.models?.providers ?? {})) {
    if (!provider.apiKeyEnv) continue;
    const value = process.env[provider.apiKeyEnv];
    if (value) env.push(`${provider.apiKeyEnv}=${value}`);
  }
  return env;
}
