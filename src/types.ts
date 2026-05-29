export type ProjectStatus = "initialized" | "running" | "submitted" | "completed" | "stopped" | "failed";

export type AgentStatus = "quiet" | "ready" | "running" | "failed" | "stopped";

export type TurnStatus = "running" | "completed" | "failed" | "cancelled";

export type MessagePriority = "P0" | "P1" | "P2" | "P3";

export type JsonObject = Record<string, unknown>;

export interface ProjectConfig {
  name: string;
  task: string;
  extends?: unknown[];
  scheduler: SchedulerConfig;
  backend: BackendConfig;
  agents: Record<string, AgentConfig>;
  channels: string[];
  tools: ToolpackConfig;
  observability: ObservabilityConfig;
}

export interface ToolpackConfig {
  toolpacks: ToolpackConfigEntry[];
}

export type ToolpackConfigEntry = string | LocalToolpackConfig;

export interface LocalToolpackConfig {
  id?: string;
  path: string;
}

export interface SchedulerConfig {
  kind: "nonpreemptive-mailbox" | "nonpreemptive-signals";
  intervalMs: number;
  maxPromptMessages: number;
}

export interface BackendConfig {
  kind: "docker-chat";
  image: string;
  controllerUrl: string;
  docker?: {
    network?: string;
    memory?: string;
    cpus?: number;
    mounts?: DockerMountConfig[];
  };
  runner: RunnerConfig;
}

export interface RunnerConfig {
  mode: "ai";
  model?: string;
  maxIterations: number;
  maxToolCalls: number;
  finalPrompt?: string;
  models?: ModelRegistryConfig;
}

export interface ModelRegistryConfig {
  providers: Record<string, ProviderConfig>;
  presets: Record<string, ModelPresetConfig>;
}

export interface ProviderConfig {
  type: "openai" | "anthropic" | "google" | "openai-compatible";
  apiKey?: string;
  apiKeyEnv?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  timeoutMs?: number | false;
  chunkTimeoutMs?: number;
  options?: JsonObject;
}

export interface ModelPresetConfig {
  provider?: string;
  model?: string;
  modelList?: string[];
  apiModel?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  contextLimit?: number;
  toolChoice?: "auto" | "required" | "none";
  fallbacks?: string[];
  providerOptions?: JsonObject;
  headers?: Record<string, string>;
}

export interface AgentConfig {
  role?: string;
  displayName?: string;
  names?: string[];
  count?: number;
  prompt?: string;
  model?: string;
  tools?: string[];
  mounts?: DockerMountConfig[];
  env?: Record<string, string>;
  workspace?: string;
}

export interface DockerMountConfig {
  source: string;
  target: string;
  readonly: boolean;
  description?: string;
}

export interface ObservabilityConfig {
  http: {
    enabled: boolean;
    host: string;
    port: number;
  };
  webui: {
    enabled: boolean;
  };
}

export interface AgentRecord {
  id: string;
  project: string;
  role: string;
  displayName: string;
  status: AgentStatus;
  prompt: string;
  model?: string;
  tools: string[];
  workspacePath: string;
  token: string;
  activeTurnId?: string;
  containerName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MessageRecord {
  id: string;
  project: string;
  sender: string;
  recipient?: string;
  channel?: string;
  priority: MessagePriority;
  body: string;
  createdAt: string;
}

export interface TurnRecord {
  id: string;
  project: string;
  agentId: string;
  status: TurnStatus;
  prompt: string;
  inputPath: string;
  outputPath: string;
  containerName?: string;
  startedAt: string;
  completedAt?: string;
  text?: string;
  error?: string;
  emittedMessages: number;
  usageJson?: string;
}

export interface SignalRecord {
  id: string;
  project: string;
  kind: string;
  sourceAgent?: string;
  sourceTurn?: string;
  targetAgent?: string;
  targetChannel?: string;
  priority: MessagePriority;
  payload: JsonObject;
  status: "pending" | "delivered" | "closed";
  usefulEffect: boolean;
  createdAt: string;
  deliveredAt?: string;
  deliveredTurnId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface RunnerToolpackSpec {
  id: string;
  tools: ToolDefinition[];
  runnerModule: string;
  supportPath: string;
}

export interface RunnerTurnInput {
  project: string;
  agent: {
    id: string;
    displayName: string;
    role: string;
    prompt: string;
    model?: string;
  };
  turn: {
    id: string;
    prompt: string;
  };
  workspace: string;
  controllerUrl: string;
  token: string;
  runner: RunnerConfig;
  tools: ToolDefinition[];
  toolpacks: RunnerToolpackSpec[];
}

export interface RunnerTurnOutput {
  text: string;
  usage?: JsonObject;
}
