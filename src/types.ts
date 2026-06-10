export type ProjectStatus = "initialized" | "running" | "submitted" | "completed" | "stopped" | "failed";

export type AgentStatus = "quiet" | "ready" | "running" | "failed" | "stopped";

export type ActivationStatus = "running" | "completed" | "failed" | "cancelled";

export type MessagePriority = "P0" | "P1" | "P2";

export type AgentHistoryRole = "user" | "assistant" | "tool_call" | "tool_result" | "compaction";

export type AgentHistoryPartType = "text" | "tool_call" | "tool_result" | "compaction";

export type JsonObject = Record<string, unknown>;

export interface ProjectConfig {
  name: string;
  task: string;
  extends?: unknown[];
  scheduler: SchedulerConfig;
  communication: CommunicationConfig;
  backend: BackendConfig;
  agents: Record<string, AgentConfig>;
  channels: string[];
  tools: ToolpackConfig;
  observability: ObservabilityConfig;
}

export interface CommunicationConfig {
  coordinatorAgent: string;
  restrictNonCoordinatorToCoordinator: boolean;
  nonCoordinatorMaxPriority: MessagePriority;
  pmRoutineVerifierPriority: MessagePriority;
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
  maxSignalsPerActivation: number;
  maxPromptMessages?: number;
  noEffectNudge: NoEffectNudgeConfig;
  failedNudge: FailedNudgeConfig;
  allQuietNudge: AllQuietNudgeConfig;
  quietAgentMonitor: QuietAgentMonitorConfig;
  failedAgentMonitor: FailedAgentMonitorConfig;
}

export interface NoEffectNudgeConfig {
  enabled: boolean;
  priority: MessagePriority;
  maxConsecutive: number;
  initialDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
}

export interface FailedNudgeConfig {
  enabled: boolean;
  priority: MessagePriority;
  maxConsecutive: number;
  initialDelayMs: number;
  backoffFactor: number;
  maxDelayMs: number;
  message: string;
}

export interface AllQuietNudgeConfig {
  enabled: boolean;
  targetAgent: string;
  priority: MessagePriority;
  cooldownMs: number;
  message: string;
}

export interface QuietAgentMonitorConfig {
  enabled: boolean;
  rules: QuietAgentMonitorRuleConfig[];
}

export interface FailedAgentMonitorConfig {
  enabled: boolean;
  rules: FailedAgentMonitorRuleConfig[];
}

export interface QuietAgentMonitorRuleConfig {
  id?: string;
  enabled: boolean;
  agent: string;
  recipient: string;
  sender: string;
  priority: MessagePriority;
  initialDelayMs: number;
  repeatDelayMs: number;
  message: string;
}

export interface FailedAgentMonitorRuleConfig {
  id?: string;
  enabled: boolean;
  agent: string;
  recipient: string;
  sender: string;
  priority: MessagePriority;
  initialDelayMs: number;
  repeatDelayMs: number;
  message: string;
}

export interface BackendConfig {
  kind: "docker-chat";
  image: string;
  controllerUrl: string;
  docker?: {
    network?: string;
    mounts?: DockerMountConfig[];
    proxy?: DockerProxyConfig;
  };
  runner: RunnerConfig;
}

export interface DockerProxyConfig {
  inheritEnv?: boolean;
  http?: string;
  https?: string;
  all?: string;
  noProxy?: string;
  rewriteLocalhost?: boolean;
}

export interface RunnerConfig {
  mode: "ai";
  model?: string;
  maxIterations?: number;
  maxToolCalls?: number;
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
  baseURLEnv?: string;
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
  reasoningEffort?: string;
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
}

export interface ToolWebuiDefinition {
  id: string;
  title: string;
  description?: string;
  kind: "panel" | "action";
  inputSchema?: JsonObject;
  submitLabel?: string;
}

export interface ToolWebuiEntry extends ToolWebuiDefinition {
  toolpackId: string;
  toolpackKind: "builtin" | "local";
}

export interface ToolStatusEntry {
  tool: string;
  toolpackId?: string;
  toolpackKind?: "builtin" | "local";
  description?: string;
  enabledForAgents: string[];
  callCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  lastStatus?: "running" | "completed" | "failed";
  lastAgentId?: string;
  lastAt?: string;
  lastError?: string;
  submittedReportPath?: string;
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
  activeActivationId?: string;
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

export interface ActivationRecord {
  id: string;
  project: string;
  agentId: string;
  status: ActivationStatus;
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
  contextJson?: string;
}

export interface AgentHistoryPart {
  id: string;
  project: string;
  agentId: string;
  messageId: string;
  activationId?: string;
  partIndex: number;
  type: AgentHistoryPartType;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  inputJson?: string;
  output?: string;
  error?: string;
  metadata?: JsonObject;
  createdAt: string;
}

export interface AgentHistoryMessage {
  id: string;
  project: string;
  agentId: string;
  activationId?: string;
  role: AgentHistoryRole;
  kind: string;
  content: string;
  sequence: number;
  compactionId?: string;
  archived: boolean;
  metadata?: JsonObject;
  parts?: AgentHistoryPart[];
  createdAt: string;
}

export interface AgentHistoryCompaction {
  id: string;
  project: string;
  agentId: string;
  activationId?: string;
  summaryMessageId: string;
  archivePath: string;
  startSequence: number;
  endSequence: number;
  archivedMessageCount: number;
  rawChars: number;
  summary: string;
  reason?: string;
  selectedModel?: string;
  createdAt: string;
}

export interface AgentHistoryPage {
  agentId: string;
  messages: AgentHistoryMessage[];
  nextBefore?: number;
}

export interface ActivationContextSnapshot {
  version: 1;
  kind: "model-context";
  recordedAt: string;
  selectedModel?: string;
  model?: string;
  apiModel?: string;
  firstPrompt?: boolean;
  messageCount: number;
  totalChars: number;
  messages: Array<{ role: string; content: string; chars: number }>;
}

export interface SignalRecord {
  id: string;
  project: string;
  kind: string;
  sourceAgent?: string;
  sourceActivation?: string;
  targetAgent?: string;
  targetChannel?: string;
  priority: MessagePriority;
  payload: JsonObject;
  status: "pending" | "delivered" | "closed";
  usefulEffect: boolean;
  createdAt: string;
  notBefore?: string;
  deliveredAt?: string;
  deliveredActivationId?: string;
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

export interface RunnerActivationInput {
  project: string;
  agent: {
    id: string;
    displayName: string;
    role: string;
    prompt: string;
    model?: string;
  };
  activation: {
    id: string;
    prompt: string;
  };
  workspace: string;
  controllerUrl: string;
  token: string;
  runner: RunnerConfig;
  tools: ToolDefinition[];
  toolpacks: RunnerToolpackSpec[];
  history?: AgentHistoryMessage[];
}

export interface RunnerActivationOutput {
  text: string;
  usage?: JsonObject;
}
