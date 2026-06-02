import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  listProjects,
  loadActivationContext,
  loadActivations,
  loadAgentHistory,
  loadAgentHistoryArchive,
  loadConfig,
  loadEvents,
  loadMessages,
  loadProjectSummary,
  loadReport,
  loadToolCalls,
  sendMessage,
  updateProject,
  type Activation,
  type ActivationContextResponse,
  type Agent,
  type AgentHistoryArchiveResponse,
  type AgentHistoryMessage,
  type EventRecord,
  type Message,
  type Priority,
  type Project,
  type ProjectStatus,
  type ToolCall,
} from "./api";

type View = "overview" | "history" | "messages" | "activations" | "tools" | "events" | "config" | "report";

const viewLabels: Record<View, string> = {
  overview: "Overview",
  history: "Agent history",
  messages: "Messages",
  activations: "Activations + context",
  tools: "Tool calls",
  events: "Timeline",
  config: "Resolved YAML",
  report: "Final report",
};

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState("");
  const [project, setProject] = useState<Project>();
  const selectedRef = useRef("");
  const viewRef = useRef<View>("overview");
  const [view, setViewState] = useState<View>("overview");
  const [messages, setMessages] = useState<Message[]>([]);
  const [activations, setActivations] = useState<Activation[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);
  const [report, setReport] = useState("No report loaded.");
  const [config, setConfig] = useState("No config loaded.");
  const [loading, setLoading] = useState(true);
  const [panelLoading, setPanelLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date>();

  function setView(next: View) {
    viewRef.current = next;
    setViewState(next);
  }

  async function refreshProjects(preferred?: string, refreshPanel = false) {
    try {
      const nextProjects = await listProjects();
      const nextSelected = preferred || selectedRef.current || nextProjects[0]?.id || "";
      const nextProject = nextProjects.find((item) => item.id === nextSelected) ?? nextProjects[0];
      const nextId = nextProject?.id ?? "";
      const nextSummary = nextId ? await loadProjectSummary(nextId) : undefined;
      setProjects(nextProjects);
      setSelected(nextId);
      setProject(nextSummary ?? nextProject);
      selectedRef.current = nextId;
      setError("");
      setLastUpdated(new Date());
      if (refreshPanel && nextId) await loadPanel(nextId, viewRef.current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  async function loadPanel(projectId: string, nextView: View) {
    if (nextView === "overview" || nextView === "history") return;
    setPanelLoading(true);
    try {
      if (nextView === "messages") setMessages(await loadMessages(projectId, 100));
      if (nextView === "activations") setActivations(await loadActivations(projectId, 100));
      if (nextView === "tools") setToolCalls(await loadToolCalls(projectId, 100));
      if (nextView === "events") setEvents(await loadEvents(projectId, 120));
      if (nextView === "config") setConfig(await loadConfig(projectId));
      if (nextView === "report") setReport(await loadReport(projectId));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPanelLoading(false);
    }
  }

  async function selectProject(projectId: string) {
    setSelected(projectId);
    selectedRef.current = projectId;
    setProject(projects.find((item) => item.id === projectId));
    setLoading(true);
    await refreshProjects(projectId, true);
  }

  async function act(action: "start" | "stop" | "approve") {
    if (!selected) return;
    setLoading(true);
    try {
      await updateProject(selected, action);
      await refreshProjects(selected, true);
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

  useEffect(() => {
    if (selected) void loadPanel(selected, view);
  }, [selected, view]);

  return (
    <div class="shell">
      <Sidebar projects={projects} selected={selected} onSelect={selectProject} />
      <main class="workspace">
        <Topbar loading={loading || panelLoading} lastUpdated={lastUpdated} onRefresh={() => void refreshProjects(selected, true)} />
        {error && <div class="error-banner">{error}</div>}
        {!project ? (
          <EmptyState loading={loading} />
        ) : (
          <>
            <ProjectHero project={project} onAction={act} />
            <ViewTabs view={view} setView={setView} />
            <div class="content-area">
              {view === "overview" && <Overview project={project} onSent={() => refreshProjects(selected, true)} />}
              {view === "history" && <HistoryPanel project={project} />}
              {view === "messages" && <MessagesPanel messages={messages} loading={panelLoading} />}
              {view === "activations" && <ActivationsPanel projectId={project.id} activations={activations} loading={panelLoading} />}
              {view === "tools" && <ToolsPanel calls={toolCalls} loading={panelLoading} />}
              {view === "events" && <EventsPanel events={events} loading={panelLoading} />}
              {view === "config" && <CodePanel title="Resolved project configuration" text={config} />}
              {view === "report" && <CodePanel title="Submitted report" text={report} />}
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
        {projects.map((item) => (
          <button class={`project-link ${item.id === selected ? "active" : ""}`} onClick={() => onSelect(item.id)}>
            <span class={`project-orb status-${item.status}`} />
            <span class="project-link-main"><strong>{item.name}</strong><small>{item.id}</small></span>
            <StatusPill status={item.status} compact />
          </button>
        ))}
      </div>
      <div class="sidebar-footer"><span class="pulse-dot" /> Summary refresh every 5s</div>
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

function Overview({ project, onSent }: { project: Project; onSent: () => Promise<void> }) {
  const stats = project.stats;
  const running = project.agents.filter((agent) => agent.status === "running").length;
  return (
    <>
      <section class="metric-grid">
        <Metric label="Agents" value={project.agents.length} sub={`${running} running now`} tone="fern" />
        <Metric label="Messages" value={stats?.messageCount ?? project.recentMessages.length} sub="total recorded" tone="amber" />
        <Metric label="Activations" value={stats?.activationCount ?? project.recentActivations.length} sub={`${stats?.failedActivationCount ?? 0} failed`} tone={stats?.failedActivationCount ? "coral" : "sky"} />
        <Metric label="Tool calls" value={stats?.toolCallCount ?? 0} sub={`${stats?.eventCount ?? 0} events`} tone="violet" />
      </section>
      <section class="dashboard-grid">
        <Panel title="Agent roster" subtitle="Durable roles and current states" className="span-7">
          <div class="agent-grid">{project.agents.map((agent) => <AgentCard agent={agent} />)}</div>
        </Panel>
        <Panel title="Send a signal" subtitle="Message an agent and wake it when idle" className="span-5"><Composer project={project} onSent={onSent} /></Panel>
        <Panel title="Recent messages" subtitle="Lightweight project summary" className="span-7"><MessageList messages={[...project.recentMessages].reverse()} /></Panel>
        <Panel title="Activation pulse" subtitle="Latest work cycles" className="span-5"><ActivationList activations={[...project.recentActivations].reverse()} /></Panel>
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
        <label><span>Priority</span><select value={priority} onChange={(event) => setPriority(event.currentTarget.value as Priority)}>{["P0", "P1", "P2"].map((value) => <option value={value}>{value}</option>)}</select></label>
      </div>
      <label><span>Message</span><textarea value={body} onInput={(event) => setBody(event.currentTarget.value)} placeholder="Delegate work, ask for evidence, or request a revision..." /></label>
      {error && <div class="form-error">{error}</div>}
      <button class="primary-button full" disabled={sending || !body.trim()}>{sending ? "Sending..." : "Send message"}</button>
    </form>
  );
}

function MessagesPanel({ messages, loading }: { messages: Message[]; loading: boolean }) {
  return <Panel title="Messages" subtitle={loading ? "Loading..." : `${messages.length} recent conversation items`}><MessageList messages={[...messages].reverse()} verbose /></Panel>;
}

function HistoryPanel({ project }: { project: Project }) {
  const [agentId, setAgentId] = useState(project.agents[0]?.id ?? "");
  const [messages, setMessages] = useState<AgentHistoryMessage[]>([]);
  const [nextBefore, setNextBefore] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [archive, setArchive] = useState<AgentHistoryArchiveResponse>();

  useEffect(() => {
    if (!project.agents.some((agent) => agent.id === agentId)) setAgentId(project.agents[0]?.id ?? "");
  }, [project.id, project.agents.length]);

  useEffect(() => {
    if (agentId) void loadPage(true);
  }, [project.id, agentId]);

  async function loadPage(reset = false) {
    if (!agentId) return;
    setLoading(true);
    setError("");
    try {
      const page = await loadAgentHistory(project.id, agentId, { limit: 80, before: reset ? undefined : nextBefore, includeArchived: true });
      setMessages((current) => reset ? page.messages : [...current, ...page.messages]);
      setNextBefore(page.nextBefore);
      if (reset) setArchive(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  async function openArchive(message: AgentHistoryMessage) {
    const compactionId = historyCompactionId(message);
    if (!compactionId) return;
    setLoading(true);
    setError("");
    try {
      setArchive(await loadAgentHistoryArchive(project.id, agentId, compactionId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div class="split-stack">
      <Panel title="Agent history" subtitle="Append-only model-visible history, paged by agent">
        <div class="history-toolbar">
          <label><span>Agent</span><select value={agentId} onChange={(event) => setAgentId(event.currentTarget.value)}>{project.agents.map((agent) => <option value={agent.id}>{agent.displayName} / {agent.id}</option>)}</select></label>
          <button class="ghost-button" disabled={loading || !agentId} onClick={() => void loadPage(true)}>{loading ? "Loading" : "Reload"}</button>
        </div>
        {error && <div class="form-error">{error}</div>}
        <div class="history-list">
          {messages.length ? messages.map((message) => <HistoryItem message={message} onArchive={openArchive} />) : <Blank label={loading ? "Loading history..." : "No history for this agent yet"} />}
        </div>
        {nextBefore !== undefined && <button class="ghost-button full" disabled={loading} onClick={() => void loadPage(false)}>{loading ? "Loading" : "Load older history"}</button>}
      </Panel>
      {archive && (
        <Panel title="Compaction archive" subtitle="Raw local snapshot saved before compaction">
          <div class="context-toolbar"><div class="context-stats"><span>{String(archive.compaction.id ?? "archive")}</span><span>{String(archive.compaction.archivedMessageCount ?? "?")} messages</span><span>{String(archive.compaction.rawChars ?? "?")} chars</span></div><button class="ghost-button" onClick={() => setArchive(undefined)}>Close</button></div>
          <pre class="code-panel">{JSON.stringify(archive.archive, null, 2)}</pre>
        </Panel>
      )}
    </div>
  );
}

function HistoryItem({ message, onArchive }: { message: AgentHistoryMessage; onArchive: (message: AgentHistoryMessage) => void }) {
  const compactionId = historyCompactionId(message);
  const title = `${message.sequence}. ${message.role} / ${message.kind}`;
  return (
    <article class={`history-item history-${message.role} ${message.archived ? "archived" : ""}`}>
      <div class="item-title"><strong>{title}</strong><small>{formatRelative(message.createdAt)}</small></div>
      <div class="history-meta"><span>{message.id}</span>{message.activationId && <span>{message.activationId}</span>}{message.archived && <span>archived</span>}</div>
      <details open={message.role === "compaction" || message.role === "user"}>
        <summary>{message.content.length.toLocaleString()} chars</summary>
        <pre>{message.content}</pre>
      </details>
      {compactionId && message.role === "compaction" && <button class="ghost-button mini-button" onClick={() => onArchive(message)}>View raw archive</button>}
    </article>
  );
}

function ActivationsPanel({ projectId, activations, loading }: { projectId: string; activations: Activation[]; loading: boolean }) {
  const [context, setContext] = useState<ActivationContextResponse>();
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState("");

  async function openContext(activationId: string) {
    setContextLoading(true);
    setContextError("");
    try {
      setContext(await loadActivationContext(projectId, activationId));
    } catch (cause) {
      setContextError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setContextLoading(false);
    }
  }

  return (
    <div class="split-stack">
      <Panel title="Activations" subtitle={loading ? "Loading..." : `${activations.length} recent work cycles`}>
        <ActivationList activations={[...activations].reverse()} verbose onContext={openContext} />
      </Panel>
      {contextError && <div class="error-banner">{contextError}</div>}
      {contextLoading && <Panel title="Model context" subtitle="Loading context snapshot"><Blank label="Loading context..." /></Panel>}
      {context && !contextLoading && <ActivationContextPanel context={context} onClose={() => setContext(undefined)} />}
    </div>
  );
}

function ToolsPanel({ calls, loading }: { calls: ToolCall[]; loading: boolean }) {
  return <Panel title="Tool calls" subtitle={loading ? "Loading..." : `${calls.length} recent runner actions`}><div class="stack-list">{calls.map((call) => <ToolCallItem call={call} />)}</div></Panel>;
}

function EventsPanel({ events, loading }: { events: EventRecord[]; loading: boolean }) {
  return <Panel title="Project timeline" subtitle={loading ? "Loading..." : `${events.length} recent events`}><div class="timeline">{events.map((event) => <EventItem event={event} />)}</div></Panel>;
}

function CodePanel({ title, text }: { title: string; text: string }) {
  return <Panel title={title} subtitle="Read-only runtime record"><pre class="code-panel">{text}</pre></Panel>;
}

function ActivationContextPanel({ context, onClose }: { context: ActivationContextResponse; onClose: () => void }) {
  const snapshot = context.context;
  return (
    <Panel title="Model context window" subtitle={`${context.activation.agentId} / ${context.activation.id}`}>
      <div class="context-toolbar">
        <div class="context-stats">
          <span>{snapshot.messageCount} messages</span>
          <span>{snapshot.totalChars.toLocaleString()} chars</span>
          <span>{snapshot.selectedModel ?? snapshot.model ?? "model unknown"}</span>
          <span>{snapshot.recordedAt ? `recorded ${formatRelative(snapshot.recordedAt)}` : "recorded time unknown"}</span>
        </div>
        <button class="ghost-button" onClick={onClose}>Close</button>
      </div>
      <div class="context-list">
        {snapshot.messages.map((message, index) => (
          <details class="context-message" open={index === snapshot.messages.length - 1 || snapshot.messages.length <= 3}>
            <summary><strong>{index + 1}. {message.role}</strong><small>{message.chars.toLocaleString()} chars</small></summary>
            <pre>{message.content}</pre>
          </details>
        ))}
      </div>
    </Panel>
  );
}

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

function ActivationList({ activations, verbose = false, onContext }: { activations: Activation[]; verbose?: boolean; onContext?: (activationId: string) => void }) {
  if (!activations.length) return <Blank label="No activations yet" />;
  return (
    <div class="stack-list">
      {activations.map((activation) => (
        <article class="activation-item">
          <div class="item-title"><strong>{activation.agentId}</strong><StatusPill status={activation.status} compact /></div>
          <small>{formatRelative(activation.startedAt)} - {activation.emittedMessages} emitted messages{activation.hasContext ? " - context recorded" : ""}</small>
          {verbose && <p class="expanded">{activation.error || activation.text || "No result text recorded."}</p>}
          {onContext && <button class="ghost-button mini-button" onClick={() => onContext(activation.id)}>View context</button>}
        </article>
      ))}
    </div>
  );
}

function ToolCallItem({ call }: { call: ToolCall }) {
  return <article class="tool-item"><div class="item-title"><strong>{call.tool}</strong><StatusPill status={call.status} compact /></div><small>{call.agent_id} - {formatRelative(call.created_at)}</small>{call.error && <p class="error-text">{call.error}</p>}</article>;
}

function EventItem({ event }: { event: EventRecord }) {
  return <article class="timeline-item"><span class="timeline-pin" /><div><div class="item-title"><strong>{event.type}</strong><small>{formatTime(event.created_at)}</small></div><p>{summarizeJson(event.data_json)}</p></div></article>;
}

function StatusPill({ status, compact = false }: { status: ProjectStatus | Agent["status"] | Activation["status"] | ToolCall["status"]; compact?: boolean }) { return <span class={`status-pill status-${status} ${compact ? "compact" : ""}`}>{status}</span>; }
function Blank({ label }: { label: string }) { return <div class="blank">{label}</div>; }
function EmptyState({ loading }: { loading: boolean }) { return <section class="empty-state"><div class="empty-orbit" /><h2>{loading ? "Connecting to Suzumio..." : "No projects initialized"}</h2><p>Initialize a YAML project, then refresh this observatory.</p><code>suzumio init path/to/project.yaml</code></section>; }
function initials(value: string): string { return value.split(/[\s_-]+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function formatTime(value: string): string { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function formatRelative(value: string): string { const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return `${seconds}s ago`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return `${Math.floor(seconds / 86400)}d ago`; }
function historyCompactionId(message: AgentHistoryMessage): string | undefined { const value = message.metadata?.compactionId ?? message.compactionId; return typeof value === "string" ? value : undefined; }
function summarizeJson(value: string): string { try { const parsed = JSON.parse(value) as Record<string, unknown>; return Object.entries(parsed).slice(0, 4).map(([key, item]) => `${key}: ${typeof item === "string" ? item : JSON.stringify(item)}`).join(" - ") || "No payload"; } catch { return value; } }
