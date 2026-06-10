export type ProjectStatus = "initialized" | "running" | "submitted" | "completed" | "stopped" | "failed";
export type AgentStatus = "quiet" | "ready" | "running" | "failed" | "stopped";
export type ActivationStatus = "running" | "completed" | "failed" | "cancelled";
export type Priority = "P0" | "P1" | "P2";
export type HistoryRole = "user" | "assistant" | "tool_call" | "tool_result" | "compaction";

export interface Agent {
  id: string;
  displayName: string;
  role: string;
  status: AgentStatus;
  activeActivationId?: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  sender: string;
  recipient?: string;
  channel?: string;
  priority: Priority;
  body: string;
  createdAt: string;
}

export interface Activation {
  id: string;
  project?: string;
  agentId: string;
  status: ActivationStatus;
  containerName?: string;
  startedAt: string;
  completedAt?: string;
  text?: string;
  error?: string;
  emittedMessages: number;
  usageJson?: string;
  hasContext?: boolean;
}

export interface EventRecord {
  id: string;
  type: string;
  data_json: string;
  created_at: string;
}

export interface ToolCall {
  id: string;
  activation_id: string;
  agent_id: string;
  tool: string;
  status: "running" | "completed" | "failed";
  created_at: string;
  completed_at?: string;
  input_json: string;
  output?: string;
  error?: string;
}

export interface ToolUiEntry {
  id: string;
  toolpackId: string;
  toolpackKind: "builtin" | "local";
  title: string;
  description?: string;
  kind: "panel" | "action";
  inputSchema?: Record<string, unknown>;
  submitLabel?: string;
}

export interface ToolUiResult {
  title?: string;
  output: string;
  metadata?: Record<string, unknown>;
}

export interface ToolStatus {
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

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  task: string;
  created_at: string;
  updated_at: string;
  stats?: {
    messageCount: number;
    activationCount: number;
    failedActivationCount: number;
    runningActivationCount: number;
    toolCallCount: number;
    historyMessageCount?: number;
    historyCompactionCount?: number;
    eventCount: number;
  };
  agents: Agent[];
  recentMessages: Message[];
  recentActivations: Activation[];
}

export interface ActivationContextMessage {
  role: string;
  content: string;
  chars: number;
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
  messages: ActivationContextMessage[];
}

export interface ActivationContextResponse {
  activation: Activation;
  activationPrompt: string;
  context: ActivationContextSnapshot;
}

export interface AgentHistoryPart {
  id: string;
  messageId: string;
  activationId?: string;
  partIndex: number;
  type: "text" | "tool_call" | "tool_result" | "compaction";
  text?: string;
  toolCallId?: string;
  toolName?: string;
  inputJson?: string;
  output?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface AgentHistoryMessage {
  id: string;
  agentId: string;
  activationId?: string;
  role: HistoryRole;
  kind: string;
  content: string;
  sequence: number;
  compactionId?: string;
  archived: boolean;
  metadata?: Record<string, unknown>;
  parts?: AgentHistoryPart[];
  createdAt: string;
}

export interface AgentHistoryPage {
  agentId: string;
  messages: AgentHistoryMessage[];
  nextBefore?: number;
}

export interface AgentHistoryArchiveResponse {
  compaction: Record<string, unknown>;
  archive: unknown;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

async function requestText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(await response.text());
  return response.text();
}

function projectPath(project: string, suffix = ""): string {
  return `/api/projects/${encodeURIComponent(project)}${suffix}`;
}

export function listProjects(): Promise<Project[]> {
  return request("/api/projects");
}

export function loadProjectSummary(project: string): Promise<Project> {
  return request<Project>(projectPath(project));
}

export function loadProjectTask(project: string): Promise<string> {
  return requestText(projectPath(project, "/task"));
}

export function loadMessages(project: string, limit = 100): Promise<Message[]> {
  return request<Message[]>(projectPath(project, `/messages?limit=${limit}`));
}

export function loadMessage(project: string, messageId: string): Promise<Message> {
  return request<Message>(projectPath(project, `/messages/${encodeURIComponent(messageId)}`));
}

export function loadActivations(project: string, limit = 100): Promise<Activation[]> {
  return request<Activation[]>(projectPath(project, `/activations?limit=${limit}`));
}

export function loadEvents(project: string, limit = 120): Promise<EventRecord[]> {
  return request<EventRecord[]>(projectPath(project, `/events?limit=${limit}`));
}

export function loadToolCalls(project: string, limit = 100): Promise<ToolCall[]> {
  return request<ToolCall[]>(projectPath(project, `/tool-calls?limit=${limit}`));
}

export function loadToolStatus(project: string): Promise<ToolStatus[]> {
  return request<ToolStatus[]>(projectPath(project, "/tool-status"));
}

export function loadToolUi(project: string): Promise<ToolUiEntry[]> {
  return request<ToolUiEntry[]>(projectPath(project, "/tool-ui"));
}

export function invokeToolUi(project: string, entry: ToolUiEntry, input: Record<string, unknown> = {}): Promise<ToolUiResult> {
  return request<ToolUiResult>(projectPath(project, `/tool-ui/${encodeURIComponent(entry.toolpackId)}/${encodeURIComponent(entry.id)}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

export function loadReport(project: string): Promise<string> {
  return requestText(projectPath(project, "/report"));
}

export function loadConfig(project: string): Promise<string> {
  return requestText(projectPath(project, "/config/resolved"));
}

export function loadActivationContext(project: string, activationId: string): Promise<ActivationContextResponse> {
  return request<ActivationContextResponse>(projectPath(project, `/activations/${encodeURIComponent(activationId)}/context`));
}

export function loadAgentHistory(project: string, agentId: string, options: { limit?: number; before?: number; includeArchived?: boolean } = {}): Promise<AgentHistoryPage> {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 80));
  if (options.before !== undefined) params.set("before", String(options.before));
  if (options.includeArchived === false) params.set("includeArchived", "0");
  return request<AgentHistoryPage>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/history?${params.toString()}`));
}

export function loadAgentHistoryArchive(project: string, agentId: string, compactionId: string): Promise<AgentHistoryArchiveResponse> {
  return request<AgentHistoryArchiveResponse>(projectPath(project, `/agents/${encodeURIComponent(agentId)}/history-archive/${encodeURIComponent(compactionId)}`));
}

export function sendMessage(project: string, body: { recipient: string; priority: Priority; body: string }): Promise<Message> {
  return request(projectPath(project, "/messages"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function updateProject(project: string, action: "start" | "stop" | "approve"): Promise<Project> {
  return request(projectPath(project, `/${action}`), { method: "POST" });
}
