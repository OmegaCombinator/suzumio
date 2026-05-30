import os from "node:os";
import path from "node:path";
import { mkdir } from "node:fs/promises";

export type ProjectPaths = {
  root: string;
  project: string;
  db: string;
  sourceConfig: string;
  resolvedConfig: string;
  agents: string;
  artifacts: string;
  activations: string;
  logs: string;
};

export type AgentPaths = {
  root: string;
  workspace: string;
};

export function suzumioRoot(root?: string): string {
  const input = root ?? process.env.SUZUMIO_ROOT ?? path.join(os.homedir(), ".suzumio");
  return path.resolve(input);
}

export function projectPaths(project: string, root?: string): ProjectPaths {
  const base = path.join(suzumioRoot(root), project);
  return {
    root: base,
    project,
    db: path.join(base, "suzumio.sqlite"),
    sourceConfig: path.join(base, "source.yaml"),
    resolvedConfig: path.join(base, "resolved.yaml"),
    agents: path.join(base, "agents"),
    artifacts: path.join(base, "artifacts"),
    activations: path.join(base, "activations"),
    logs: path.join(base, "logs"),
  };
}

export function agentPaths(project: string, agentId: string, root?: string): AgentPaths {
  const p = projectPaths(project, root);
  const base = path.join(p.agents, agentId);
  return { root: base, workspace: path.join(base, "workspace") };
}

export async function ensureProjectDirs(project: string, root?: string): Promise<ProjectPaths> {
  const p = projectPaths(project, root);
  await Promise.all([mkdir(p.root, { recursive: true }), mkdir(p.agents, { recursive: true }), mkdir(p.artifacts, { recursive: true }), mkdir(p.activations, { recursive: true }), mkdir(p.logs, { recursive: true })]);
  return p;
}
