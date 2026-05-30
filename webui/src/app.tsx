import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  listProjects,
  loadProjectDetails,
  sendMessage,
  updateProject,
  type Activation,
  type Agent,
  type EventRecord,
  type Message,
  type Priority,
  type Project,
  type ProjectDetails,
  type ProjectStatus,
  type ToolCall,
} from "./api";

type View = "overview" | "messages" | "activations" | "tools" | "events" | "config" | "report";

const viewLabels: Record<View, string> = {
  overview: "Overview",
  messages: "Messages",
  activations: "Activations",
  tools: "Tool calls",
  events: "Timeline",
  config: "Resolved YAML",
  report: "Final report",
};

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState("");
  const selectedRef = useRef("");
  const [details, setDetails] = useState<ProjectDetails>();
  const [view, setView] = useState<View>("overview");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date>();

  async function refreshProjects(preferred?: string) {
    try {
      const nextProjects = await listProjects();
      const nextSelected = preferred || selectedRef.current || nextProjects[0]?.id || "";
      setProjects(nextProjects);
      setSelected(nextSelected);
      selectedRef.current = nextSelected;
      if (nextSelected) setDetails(await loadProjectDetails(nextSelected));
      else setDetails(undefined);
      setError("");
      setLastUpdated(new Date());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  async function selectProject(project: string) {
    setSelected(project);
    selectedRef.current = project;
    setLoading(true);
    await refreshProjects(project);
  }

  async function act(action: "start" | "stop" | "approve") {
    if (!selected) return;
    setLoading(true);
    try {
      await updateProject(selected, action);
      await refreshProjects(selected);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshProjects();
    const timer = window.setInterval(() => void refreshProjects(), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div class="shell">
      <Sidebar projects={projects} selected={selected} onSelect={selectProject} />
      <main class="workspace">
        <Topbar loading={loading} lastUpdated={lastUpdated} onRefresh={() => void refreshProjects()} />
        {error && <div class="error-banner">{error}</div>}
        {!details ? (
          <EmptyState loading={loading} />
        ) : (
          <>
            <ProjectHero project={details.project} onAction={act} />
            <ViewTabs view={view} setView={setView} />
            <div class="content-area">
              {view === "overview" && <Overview details={details} onSent={() => refreshProjects(selected)} />}
              {view === "messages" && <MessagesPanel messages={details.messages} />}
              {view === "activations" && <ActivationsPanel activations={details.activations} />}
              {view === "tools" && <ToolsPanel calls={details.toolCalls} />}
              {view === "events" && <EventsPanel events={details.events} />}
              {view === "config" && <CodePanel title="Resolved project configuration" text={details.config} />}
              {view === "report" && <CodePanel title="Submitted report" text={details.report} />}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Sidebar({ projects, selected, onSelect }: { projects: Project[]; selected: string; onSelect: (project: string) => void }) {
  return (
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">S</div>
        <div>
          <strong>Suzumio</strong>
          <span>Agent observatory</span>
        </div>
      </div>
      <div class="sidebar-label">Projects <span>{projects.length}</span></div>
      <div class="project-list">
        {projects.map((project) => (
          <button class={`project-link ${project.id === selected ? "active" : ""}`} onClick={() => onSelect(project.id)}>
            <span class={`project-orb status-${project.status}`} />
            <span class="project-link-main"><strong>{project.name}</strong><small>{project.id}</small></span>
            <StatusPill status={project.status} compact />
          </button>
        ))}
      </div>
      <div class="sidebar-footer">
        <span class="pulse-dot" /> Live refresh every 5s
      </div>
    </aside>
  );
}

function Topbar({ loading, lastUpdated, onRefresh }: { loading: boolean; lastUpdated?: Date; onRefresh: () => void }) {
  return (
    <header class="topbar">
      <div>
        <span class="eyebrow">CONTROL ROOM</span>
        <h1>Project telemetry</h1>
      </div>
      <div class="topbar-actions">
        <span class="last-updated">{lastUpdated ? `Updated ${formatTime(lastUpdated.toISOString())}` : "Connecting..."}</span>
        <button class="ghost-button" disabled={loading} onClick={onRefresh}>{loading ? "Refreshing" : "Refresh"}</button>
      </div>
    </header>
  );
}

function ProjectHero({ project, onAction }: { project: Project; onAction: (action: "start" | "stop" | "approve") => void }) {
  return (
    <section class="hero">
      <div class="hero-copy">
        <div class="hero-meta"><StatusPill status={project.status} /><span>Updated {formatRelative(project.updated_at)}</span></div>
        <h2>{project.name}</h2>
        <p>{project.task}</p>
      </div>
      <div class="hero-actions">
        {(project.status === "initialized" || project.status === "stopped" || project.status === "failed") && <button class="primary-button" onClick={() => onAction("start")}>Start project</button>}
        {project.status === "running" && <button class="danger-button" onClick={() => onAction("stop")}>Stop</button>}
        {project.status === "submitted" && <button class="secondary-button" onClick={() => onAction("approve")}>Approve report</button>}
      </div>
    </section>
  );
}

function ViewTabs({ view, setView }: { view: View; setView: (view: View) => void }) {
  return <nav class="tabs">{Object.entries(viewLabels).map(([id, label]) => <button class={view === id ? "active" : ""} onClick={() => setView(id as View)}>{label}</button>)}</nav>;
}

function Overview({ details, onSent }: { details: ProjectDetails; onSent: () => Promise<void> }) {
  const failed = details.activations.filter((activation) => activation.status === "failed").length;
  const running = details.project.agents.filter((agent) => agent.status === "running").length;
  return (
    <>
      <section class="metric-grid">
        <Metric label="Agents" value={details.project.agents.length} sub={`${running} running now`} tone="fern" />
        <Metric label="Messages" value={details.messages.length} sub="visible conversation items" tone="amber" />
        <Metric label="Activations" value={details.activations.length} sub={`${failed} failed`} tone={failed ? "coral" : "sky"} />
        <Metric label="Tool calls" value={details.toolCalls.length} sub="audited runner actions" tone="violet" />
      </section>
      <section class="dashboard-grid">
        <Panel title="Agent roster" subtitle="Durable roles and current states" className="span-7">
          <div class="agent-grid">{details.project.agents.map((agent) => <AgentCard agent={agent} />)}</div>
        </Panel>
        <Panel title="Send a signal" subtitle="Message an agent and wake it when idle" className="span-5"><Composer project={details.project} onSent={onSent} /></Panel>
        <Panel title="Recent messages" subtitle="Conversation history across the team" className="span-7"><MessageList messages={details.messages.slice(-7).reverse()} /></Panel>
        <Panel title="Activation pulse" subtitle="Latest Docker-backed work cycles" className="span-5"><ActivationList activations={details.activations.slice(-7).reverse()} /></Panel>
      </section>
    </>
  );
}

function Composer({ project, onSent }: { project: Project; onSent: () => Promise<void> }) {
  const [recipient, setRecipient] = useState(project.agents[0]?.id ?? "pm");
  const [priority, setPriority] = useState<Priority>("P1");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!project.agents.some((agent) => agent.id === recipient)) setRecipient(project.agents[0]?.id ?? "pm");
  }, [project.id, project.agents.length]);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!body.trim() || !recipient) return;
    setSending(true);
    setError("");
    try {
      await sendMessage(project.id, { recipient, priority, body: body.trim() });
      setBody("");
      await onSent();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }
  return (
    <form class="composer" onSubmit={submit}>
      <div class="form-row">
        <label><span>Recipient</span><select value={recipient} onChange={(event) => setRecipient(event.currentTarget.value)}>{project.agents.map((agent) => <option value={agent.id}>{agent.displayName} / {agent.id}</option>)}</select></label>
        <label><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.currentTarget.value as Priority)}>{["P0", "P1", "P2", "P3"].map((value) => <option value={value}>{value}</option>)}</select></label>
      </div>
      <label><span>Message</span><textarea value={body} onInput={(event) => setBody(event.currentTarget.value)} placeholder="Delegate work, ask for evidence, or request a revision..." /></label>
      {error && <div class="form-error">{error}</div>}
      <button class="primary-button full" disabled={sending || !body.trim()}>{sending ? "Sending..." : "Send message"}</button>
    </form>
  );
}

function MessagesPanel({ messages }: { messages: Message[] }) { return <Panel title="Messages" subtitle={`${messages.length} visible conversation items`}><MessageList messages={[...messages].reverse()} verbose /></Panel>; }
function ActivationsPanel({ activations }: { activations: Activation[] }) { return <Panel title="Activations" subtitle={`${activations.length} Docker-backed work cycles`}><ActivationList activations={[...activations].reverse()} verbose /></Panel>; }
function ToolsPanel({ calls }: { calls: ToolCall[] }) { return <Panel title="Tool calls" subtitle={`${calls.length} audited runner actions`}><div class="stack-list">{calls.map((call) => <ToolCallItem call={call} />)}</div></Panel>; }
function EventsPanel({ events }: { events: EventRecord[] }) { return <Panel title="Project timeline" subtitle={`${events.length} recorded events`}><div class="timeline">{events.map((event) => <EventItem event={event} />)}</div></Panel>; }
function CodePanel({ title, text }: { title: string; text: string }) { return <Panel title={title} subtitle="Read-only runtime record"><pre class="code-panel">{text}</pre></Panel>; }

function Panel({ title, subtitle, className = "", children }: { title: string; subtitle?: string; className?: string; children: ComponentChildren }) {
  return <section class={`panel ${className}`}><header class="panel-heading"><div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section>;
}

function Metric({ label, value, sub, tone }: { label: string; value: number; sub: string; tone: string }) {
  return <div class={`metric metric-${tone}`}><span>{label}</span><strong>{value}</strong><small>{sub}</small></div>;
}

function AgentCard({ agent }: { agent: Agent }) {
  return <article class="agent-card"><div class="agent-avatar">{initials(agent.displayName || agent.id)}</div><div><div class="item-title"><strong>{agent.displayName}</strong><StatusPill status={agent.status} compact /></div><p>{agent.role}</p><small>{agent.id}{agent.activeActivationId ? ` - ${agent.activeActivationId}` : ""}</small></div></article>;
}

function MessageList({ messages, verbose = false }: { messages: Message[]; verbose?: boolean }) {
  if (!messages.length) return <Blank label="No messages yet" />;
  return <div class="stack-list">{messages.map((message) => <article class={`message-item priority-${message.priority.toLowerCase()}`}><div class="item-title"><strong>{message.sender} <span>-&gt;</span> {message.recipient ?? message.channel}</strong><small>{formatRelative(message.createdAt)}</small></div><p class={verbose ? "expanded" : ""}>{message.body}</p><span class="mini-label">{message.priority}</span></article>)}</div>;
}

function ActivationList({ activations, verbose = false }: { activations: Activation[]; verbose?: boolean }) {
  if (!activations.length) return <Blank label="No activations yet" />;
  return <div class="stack-list">{activations.map((activation) => <article class="activation-item"><div class="item-title"><strong>{activation.agentId}</strong><StatusPill status={activation.status} compact /></div><small>{formatRelative(activation.startedAt)} - {activation.emittedMessages} emitted messages</small>{verbose && <p class="expanded">{activation.error || activation.text || "No result text recorded."}</p>}</article>)}</div>;
}

function ToolCallItem({ call }: { call: ToolCall }) { return <article class="tool-item"><div class="item-title"><strong>{call.tool}</strong><StatusPill status={call.status} compact /></div><small>{call.agent_id} - {formatRelative(call.created_at)}</small>{call.error && <p class="error-text">{call.error}</p>}</article>; }

function EventItem({ event }: { event: EventRecord }) { return <article class="timeline-item"><span class="timeline-pin" /><div><div class="item-title"><strong>{event.type}</strong><small>{formatTime(event.created_at)}</small></div><p>{summarizeJson(event.data_json)}</p></div></article>; }

function StatusPill({ status, compact = false }: { status: ProjectStatus | Agent["status"] | Activation["status"] | ToolCall["status"]; compact?: boolean }) { return <span class={`status-pill status-${status} ${compact ? "compact" : ""}`}>{status}</span>; }
function Blank({ label }: { label: string }) { return <div class="blank">{label}</div>; }
function EmptyState({ loading }: { loading: boolean }) { return <section class="empty-state"><div class="empty-orbit" /><h2>{loading ? "Connecting to Suzumio..." : "No projects initialized"}</h2><p>Initialize a YAML project, then refresh this observatory.</p><code>suzumio init path/to/project.yaml</code></section>; }
function initials(value: string): string { return value.split(/[\s_-]+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function formatTime(value: string): string { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function formatRelative(value: string): string { const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return `${seconds}s ago`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return `${Math.floor(seconds / 86400)}d ago`; }
function summarizeJson(value: string): string { try { const parsed = JSON.parse(value) as Record<string, unknown>; return Object.entries(parsed).slice(0, 4).map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`).join(" - ") || "No payload"; } catch { return value; } }
