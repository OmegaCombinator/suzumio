#!/usr/bin/env node
import { loadProjectConfig, renderProjectConfig } from "./config.js";
import { sourceAndResolvedText, ProjectStore } from "./store.js";
import { serveSuzumio } from "./server.js";
import { NonPreemptiveSignalScheduler } from "./scheduler.js";
import type { MessagePriority, ProjectStatus } from "./types.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "config":
      return configCommand(args);
    case "init":
      return initCommand(args);
    case "serve":
      return serveCommand(args);
    case "start":
      return statusCommand(args, "running", true);
    case "stop":
      return statusCommand(args, "stopped", false);
    case "approve":
      return statusCommand(args, "completed", false);
    case "send":
      return sendCommand(args);
    case "status":
      return showStatus(args);
    case "messages":
      return showMessages(args);
    case "activations":
      return showActivations(args);
    case "events":
      return showEvents(args);
    case "tick":
      return tickCommand(args);
    default:
      usage();
  }
}

async function configCommand(args: string[]): Promise<void> {
  if (args[0] !== "render" || !args[1]) usage();
  process.stdout.write(await renderProjectConfig(args[1]!));
}

async function initCommand(args: string[]): Promise<void> {
  const filePath = args[0];
  if (!filePath) usage();
  const loaded = await loadProjectConfig(filePath);
  const text = await sourceAndResolvedText(loaded.sourcePath, loaded.resolved);
  const store = await ProjectStore.initialize({ config: loaded.config, sourceText: text.sourceText, resolvedText: text.resolvedText, root: flag(args, "root") });
  try {
    console.log(`Initialized ${loaded.config.name}`);
    console.log(`Root: ${store.paths.root}`);
  } finally {
    store.close();
  }
}

async function serveCommand(args: string[]): Promise<void> {
  const host = flag(args, "host") ?? "127.0.0.1";
  const port = Number(flag(args, "port") ?? 39400);
  await serveSuzumio({ host, port, root: flag(args, "root"), scheduler: !hasFlag(args, "no-scheduler"), platforms: !hasFlag(args, "no-platforms") });
}

async function statusCommand(args: string[], status: ProjectStatus, tick: boolean): Promise<void> {
  const project = positionalArgs(args)[0];
  if (!project) usage();
  const root = flag(args, "root");
  const store = new ProjectStore(project, root);
  try {
    store.setProjectStatus(status);
    console.log(`${project}: ${status}`);
  } finally {
    store.close();
  }
  if (tick) await new NonPreemptiveSignalScheduler(root).tickProject(project);
}

async function sendCommand(args: string[]): Promise<void> {
  const positionals = positionalArgs(args);
  const project = positionals[0];
  const recipient = positionals[1];
  const priority = positionals[2];
  const body = positionals.slice(3).join(" ");
  if (!project || !recipient || !priority || !body) usage();
  const root = flag(args, "root");
  const store = new ProjectStore(project, root);
  try {
    const message = store.sendMessage({ sender: "user", recipient, priority: parsePriority(priority), body });
    console.log(`Sent ${message.id}`);
  } finally {
    store.close();
  }
  await new NonPreemptiveSignalScheduler(root).tickProject(project);
}

async function showStatus(args: string[]): Promise<void> {
  const root = flag(args, "root");
  const project = positionalArgs(args)[0];
  if (!project) {
    for (const name of await ProjectStore.list(root)) await printProject(name, root);
    return;
  }
  await printProject(project, root);
}

async function printProject(project: string, root?: string): Promise<void> {
  const store = new ProjectStore(project, root);
  try {
    const row = store.projectRow();
    console.log(`${row.id}  ${row.status}`);
    for (const agent of store.listAgents()) console.log(`  ${agent.id.padEnd(16)} ${agent.status}${agent.activeActivationId ? ` ${agent.activeActivationId}` : ""}`);
  } finally {
    store.close();
  }
}

async function showMessages(args: string[]): Promise<void> {
  const store = openProject(args);
  try {
    for (const message of store.listMessages(numberFlag(args, "limit", 50))) {
      console.log(`\n${message.id} ${message.createdAt} ${message.sender} -> ${message.recipient ?? message.channel} [${message.priority}]\n${message.body}`);
    }
  } finally {
    store.close();
  }
}

async function showActivations(args: string[]): Promise<void> {
  const store = openProject(args);
  try {
    for (const activation of store.listActivations(numberFlag(args, "limit", 50))) {
      console.log(`\n${activation.id} ${activation.agentId} ${activation.status} ${activation.startedAt}`);
      if (activation.text) console.log(activation.text);
      if (activation.error) console.log(activation.error);
    }
  } finally {
    store.close();
  }
}

async function showEvents(args: string[]): Promise<void> {
  const store = openProject(args);
  try {
    for (const event of store.listEvents(numberFlag(args, "limit", 50)).reverse()) console.log(`${event.created_at} ${event.type} ${event.data_json}`);
  } finally {
    store.close();
  }
}

async function tickCommand(args: string[]): Promise<void> {
  const project = positionalArgs(args)[0];
  const scheduler = new NonPreemptiveSignalScheduler(flag(args, "root"));
  if (project) await scheduler.tickProject(project);
  else await scheduler.tickAll();
}

function openProject(args: string[]): ProjectStore {
  const project = positionalArgs(args)[0];
  if (!project) usage();
  return new ProjectStore(project, flag(args, "root"));
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function positionalArgs(args: string[]): string[] {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item) continue;
    if (item.startsWith("--")) {
      index += 1;
      continue;
    }
    positionals.push(item);
  }
  return positionals;
}

function numberFlag(args: string[], name: string, fallback: number): number {
  const value = Number(flag(args, name) ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parsePriority(value: string): MessagePriority {
  if (value === "P0" || value === "P1" || value === "P2" || value === "P3") return value;
  throw new Error(`Invalid priority: ${value}`);
}

function usage(): never {
  console.log(`Suzumio

Commands:
  suzumio config render <file>
  suzumio init <file> [--root dir]
  suzumio serve [--host 127.0.0.1] [--port 39400] [--root dir] [--no-platforms]
  suzumio start <project> [--root dir]
  suzumio stop <project> [--root dir]
  suzumio approve <project> [--root dir]
  suzumio send <project> <recipient> <P0|P1|P2|P3> <message...> [--root dir]
  suzumio status [project] [--root dir]
  suzumio messages <project> [--limit n] [--root dir]
  suzumio activations <project> [--limit n] [--root dir]
  suzumio events <project> [--limit n] [--root dir]
  suzumio tick [project] [--root dir]
`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
