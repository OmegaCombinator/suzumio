export type ProjectStatus = "initialized" | "running" | "submitted" | "completed" | "stopped" | "failed";
export type AgentStatus = "quiet" | "ready" | "running" | "failed" | "stopped";
export type ActivationStatus = "running" | "completed" | "failed" | "cancelled";
export type Priority = "P0" | "P1" | "P2" | "P3";

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
  agentId: string;
  status: ActivationStatus;
  startedAt: string;
  completedAt?: string;
  text?: string;
  error?: string;
  emittedMessages: number;
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

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  task: string;
  created_at: string;
  updated_at: string;
  agents: Agent[];
  recentMessages: Message[];
  recentActivations: Activation[];
}

export interface ProjectDetails {
  project: Project;
  messages: Message[];
  activations: Activation[];
  events: EventRecord[];
  toolCalls: ToolCall[];
  report: string;
  config: string;
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

export async function loadProjectDetails(project: string): Promise<ProjectDetails> {
  const [summary, messages, activations, events, toolCalls, report, config] = await Promise.all([
    request<Project>(projectPath(project)),
    request<Message[]>(projectPath(project, "/messages?limit=160")),
    request<Activation[]>(projectPath(project, "/activations?limit=120")),
    request<EventRecord[]>(projectPath(project, "/events?limit=180")),
    request<ToolCall[]>(projectPath(project, "/tool-calls?limit=120")),
    requestText(projectPath(project, "/report")),
    requestText(projectPath(project, "/config/resolved")),
  ]);
  return { project: summary, messages, activations, events, toolCalls, report, config };
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
