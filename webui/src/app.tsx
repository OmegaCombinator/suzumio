import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import {
  listProjects,
  loadAgentHistory,
  loadAgentHistoryArchive,
  loadMessage,
  loadMessages,
  loadProjectTask,
  loadToolStatus,
  loadToolUi,
  sendMessage,
  invokeToolUi,
  updateProject,
  type Agent,
  type AgentHistoryArchiveResponse,
  type AgentHistoryMessage,
  type Message,
  type Priority,
  type Project,
  type ProjectStatus,
  type ToolStatus,
  type ToolUiEntry,
  type ToolUiResult,
} from "./api";

type View = "overview" | "history" | "messages" | "tools";

const viewLabels: Record<View, string> = {
  overview: "Overview",
  history: "Agent history",
  messages: "Messages",
  tools: "Tool status",
};

type RouteState = { project?: string; view: View };

const viewIds = new Set<View>(Object.keys(viewLabels) as View[]);

function currentRoute(): RouteState {
  if (typeof window === "undefined") return { view: "overview" };
  const raw = window.location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts.length === 0) return { view: "overview" };
  if (viewIds.has(parts[0] as View)) return { view: parts[0] as View };
  const view = viewIds.has(parts[1] as View) ? parts[1] as View : "overview";
  return { project: parts[0], view };
}

function writeRoute(project: string, view: View, replace = false): void {
  if (typeof window === "undefined" || !project) return;
  const toolKey = view === "tools" ? currentToolRouteKey() : undefined;
  const next = `#/${encodeURIComponent(project)}/${view}${toolKey ? `/${encodeURIComponent(toolKey)}` : ""}`;
  if (window.location.hash === next) return;
  if (replace) window.history.replaceState(null, "", next);
  else window.location.hash = next;
}

function currentToolRouteKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.location.hash.replace(/^#\/?/, "");
  const parts = raw.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  return parts[1] === "tools" ? parts[2] : undefined;
}

function writeToolRoute(project: string, key: string): void {
  if (typeof window === "undefined" || !project) return;
  const next = `#/${encodeURIComponent(project)}/tools/${encodeURIComponent(key)}`;
  if (window.location.hash !== next) window.location.hash = next;
}

export function App() {
  const initialRoute = currentRoute();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState(initialRoute.project ?? "");
  const [project, setProject] = useState<Project>();
  const selectedRef = useRef(initialRoute.project ?? "");
  const viewRef = useRef<View>(initialRoute.view);
  const [view, setViewState] = useState<View>(initialRoute.view);
  const [messages, setMessages] = useState<Message[]>([]);
  const [toolStatuses, setToolStatuses] = useState<ToolStatus[]>([]);
  const [toolUiEntries, setToolUiEntries] = useState<ToolUiEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [panelLoading, setPanelLoading] = useState(false);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date>();

  function setView(next: View) {
    viewRef.current = next;
    setViewState(next);
    writeRoute(selectedRef.current, next);
  }

  async function refreshProjects(preferred?: string, refreshPanel = false) {
    try {
      const nextProjects = await listProjects();
      const nextSelected = preferred || selectedRef.current || nextProjects[0]?.id || "";
      const nextProject = nextProjects.find((item) => item.id === nextSelected) ?? nextProjects[0];
      const nextId = nextProject?.id ?? "";
      setProjects(nextProjects);
      setSelected(nextId);
      setProject(nextProject);
      selectedRef.current = nextId;
      if (nextId) writeRoute(nextId, viewRef.current, true);
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
      if (nextView === "tools") {
        const [nextToolStatuses, nextToolUiEntries] = await Promise.all([loadToolStatus(projectId), loadToolUi(projectId)]);
        setToolStatuses(nextToolStatuses);
        setToolUiEntries(nextToolUiEntries);
      }
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
    writeRoute(projectId, viewRef.current);
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
    const onHashChange = () => {
      const route = currentRoute();
      viewRef.current = route.view;
      setViewState(route.view);
      if (route.project && route.project !== selectedRef.current) {
        selectedRef.current = route.project;
        setSelected(route.project);
        setLoading(true);
        void refreshProjects(route.project, true);
      }
    };
    window.addEventListener("hashchange", onHashChange);
    void refreshProjects(selectedRef.current || undefined);
    const timer = window.setInterval(() => void refreshProjects(), 5_000);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.clearInterval(timer);
    };
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
              {view === "messages" && <MessagesPanel projectId={project.id} messages={messages} loading={panelLoading} />}
              {view === "tools" && <ToolsPanel projectId={project.id} entries={toolUiEntries} statuses={toolStatuses} loading={panelLoading} />}
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
  const [expanded, setExpanded] = useState(false);
  const [task, setTask] = useState(project.task);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskError, setTaskError] = useState("");
  const canExpand = task.length > 420 || task.includes("[truncated") || project.task.includes("[truncated");

  useEffect(() => {
    setExpanded(false);
    setTask(project.task);
    setTaskError("");
  }, [project.id, project.task]);

  async function toggleTask() {
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (!project.task.includes("[truncated") && !task.includes("[truncated")) return;
    setTaskLoading(true);
    setTaskError("");
    try {
      setTask(await loadProjectTask(project.id));
    } catch (cause) {
      setTaskError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setTaskLoading(false);
    }
  }

  return (
    <section class="hero">
      <div class="hero-copy">
        <div class="hero-meta"><StatusPill status={project.status} /><span>Updated {formatRelative(project.updated_at)}</span></div>
        <h2>{project.name}</h2>
        <p class={`hero-task ${expanded ? "expanded" : "collapsed"}`}>{task}</p>
        {canExpand && <button class="hero-task-toggle" disabled={taskLoading} onClick={() => void toggleTask()}>{taskLoading ? "Loading full task..." : expanded ? "Collapse task" : "Expand full task"}</button>}
        {taskError && <div class="form-error">{taskError}</div>}
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
        <Metric label="Messages" value={stats?.messageCount ?? 0} sub="open Messages to inspect" tone="amber" />
        <Metric label="Activations" value={stats?.activationCount ?? 0} sub={`${stats?.runningActivationCount ?? 0} running, ${stats?.failedActivationCount ?? 0} failed`} tone={stats?.failedActivationCount ? "coral" : "sky"} />
        <Metric label="Tools" value={stats?.toolCallCount ?? 0} sub="open Tool status for details" tone="violet" />
      </section>
      <section class="dashboard-grid">
        <Panel title="Agent roster" subtitle="Durable roles and current states" className="span-7">
          <div class="agent-grid">{project.agents.map((agent) => <AgentCard agent={agent} />)}</div>
        </Panel>
        <Panel title="Send a signal" subtitle="Message an agent and wake it when idle" className="span-5"><Composer project={project} onSent={onSent} /></Panel>
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

function MessagesPanel({ projectId, messages, loading }: { projectId: string; messages: Message[]; loading: boolean }) {
  return <Panel title="Messages" subtitle={loading ? "Loading..." : `${messages.length} recent conversation items`}><MessageList projectId={projectId} messages={[...messages].reverse()} verbose /></Panel>;
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
  const toolName = historyToolName(message);
  const title = toolName ? `${message.sequence}. ${message.role} / ${toolName}` : `${message.sequence}. ${message.role} / ${message.kind}`;
  return (
    <article class={`history-item history-${message.role} ${message.archived ? "archived" : ""}`}>
      <div class="item-title"><strong>{title}</strong><small>{formatRelative(message.createdAt)}</small></div>
      <div class="history-meta"><span>{message.id}</span>{message.activationId && <span>{message.activationId}</span>}{toolName && <span class="history-tool-chip">{toolName}</span>}{message.archived && <span>archived</span>}</div>
      <details open={message.role === "compaction" || message.role === "user"}>
        <summary>{message.content.length.toLocaleString()} chars</summary>
        <pre>{message.content}</pre>
      </details>
      {compactionId && message.role === "compaction" && <button class="ghost-button mini-button" onClick={() => onArchive(message)}>View raw archive</button>}
    </article>
  );
}

type ToolWorkspaceItem =
  | { key: string; kind: "tool"; title: string; kicker: string; description?: string; status: ToolStatus; entries: ToolUiEntry[] }
  | { key: string; kind: "control"; title: string; kicker: string; description?: string; entry: ToolUiEntry };

function ToolsPanel({ projectId, entries, statuses, loading }: { projectId: string; entries: ToolUiEntry[]; statuses: ToolStatus[]; loading: boolean }) {
  const items = toolWorkspaceItems(statuses, entries);
  const [selectedKey, setSelectedKey] = useState(() => currentToolRouteKey() ?? "");
  const selected = items.find((item) => item.key === selectedKey) ?? items[0];

  useEffect(() => {
    if (!items.length) return;
    const routed = currentToolRouteKey();
    const next = routed && items.some((item) => item.key === routed) ? routed : selectedKey && items.some((item) => item.key === selectedKey) ? selectedKey : items[0]!.key;
    if (next !== selectedKey) setSelectedKey(next);
    if (!routed || routed !== next) writeToolRoute(projectId, next);
  }, [projectId, items.map((item) => item.key).join("\0")]);

  function select(item: ToolWorkspaceItem) {
    setSelectedKey(item.key);
    writeToolRoute(projectId, item.key);
  }

  if (!items.length) return <Panel title="Tool workspace" subtitle={loading ? "Loading..." : "No tools registered"}><Blank label={loading ? "Loading tool workspace..." : "No configured tools or WebUI controls yet"} /></Panel>;

  return (
    <section class="tool-workspace">
      <aside class="tool-index-card">
        <div class="tool-index-head">
          <span class="eyebrow">TOOL WORKSPACE</span>
          <strong>{items.length} pages</strong>
          <small>{statuses.length} runtime tools / {entries.length} controls</small>
        </div>
        <div class="tool-index-list">
          {items.map((item) => <ToolIndexButton item={item} active={item.key === selected?.key} onSelect={() => select(item)} />)}
        </div>
      </aside>
      <div class="tool-page-shell">
        {selected?.kind === "tool" ? <ToolDetailPage projectId={projectId} item={selected} /> : selected && <ToolControlPage projectId={projectId} item={selected} />}
      </div>
    </section>
  );
}

function ToolIndexButton({ item, active, onSelect }: { item: ToolWorkspaceItem; active: boolean; onSelect: () => void }) {
  const state = item.kind === "tool" ? toolState(item.status) : item.entry.kind;
  const count = item.kind === "tool" ? item.status.callCount : undefined;
  return (
    <button class={`tool-index-button ${active ? "active" : ""}`} onClick={onSelect}>
      <span class="tool-index-main"><strong>{item.title}</strong><small>{item.kicker}</small></span>
      <span class="tool-index-side"><StatusPill status={state} compact />{count !== undefined && <small>{count.toLocaleString()}</small>}</span>
    </button>
  );
}

function ToolDetailPage({ projectId, item }: { projectId: string; item: Extract<ToolWorkspaceItem, { kind: "tool" }> }) {
  const status = item.status;
  return (
    <article class="tool-page-card">
      <header class="tool-page-hero">
        <div>
          <span class="eyebrow">{item.kicker}</span>
          <h3>{item.title}</h3>
          {item.description && <p>{item.description}</p>}
        </div>
        <StatusPill status={toolState(status)} />
      </header>
      <ToolStatusSummary status={status} />
      <section class="tool-page-section">
        <div class="tool-section-title"><strong>Controls</strong><span>{item.entries.length ? `${item.entries.length} WebUI controls` : "No dedicated control"}</span></div>
        {item.entries.length ? <div class="tool-control-stack">{item.entries.map((entry) => <ToolUiCard projectId={projectId} entry={entry} />)}</div> : <Blank label="This tool only has runtime status right now" />}
      </section>
    </article>
  );
}

function ToolControlPage({ projectId, item }: { projectId: string; item: Extract<ToolWorkspaceItem, { kind: "control" }> }) {
  return (
    <article class="tool-page-card">
      <header class="tool-page-hero tool-page-hero-control">
        <div>
          <span class="eyebrow">{item.kicker}</span>
          <h3>{item.title}</h3>
          {item.description && <p>{item.description}</p>}
        </div>
        <span class="tool-ui-kind">{item.entry.kind}</span>
      </header>
      <ToolUiCard projectId={projectId} entry={item.entry} />
    </article>
  );
}

function ToolStatusSummary({ status }: { status: ToolStatus }) {
  return (
    <section class="tool-status-summary">
      <div><span>Total calls</span><strong>{status.callCount.toLocaleString()}</strong></div>
      <div><span>Running</span><strong>{status.runningCount.toLocaleString()}</strong></div>
      <div><span>Completed</span><strong>{status.completedCount.toLocaleString()}</strong></div>
      <div><span>Failed</span><strong>{status.failedCount.toLocaleString()}</strong></div>
      <div class="wide"><span>Enabled agents</span><strong>{status.enabledForAgents.length ? status.enabledForAgents.join(", ") : "No current agent allowlist"}</strong></div>
      <div class="wide"><span>Last activity</span><strong>{status.lastAt ? `${formatRelative(status.lastAt)}${status.lastAgentId ? ` by ${status.lastAgentId}` : ""}` : "No calls yet"}</strong></div>
      {status.submittedReportPath && <div class="wide"><span>Final report</span><strong>{status.submittedReportPath}</strong></div>}
      {status.lastError && <div class="wide error"><span>Last error</span><strong>{status.lastError}</strong></div>}
    </section>
  );
}

function toolWorkspaceItems(statuses: ToolStatus[], entries: ToolUiEntry[]): ToolWorkspaceItem[] {
  const toolNames = new Set(statuses.map((status) => status.tool));
  const controlsByTool = new Map<string, ToolUiEntry[]>();
  const standalone: ToolUiEntry[] = [];
  for (const entry of entries) {
    const related = relatedToolsForEntry(entry).filter((tool) => toolNames.has(tool));
    if (!related.length) {
      standalone.push(entry);
      continue;
    }
    for (const tool of related) controlsByTool.set(tool, [...(controlsByTool.get(tool) ?? []), entry]);
  }
  return [
    ...standalone.map((entry) => ({ key: `control:${entry.toolpackId}:${entry.id}`, kind: "control" as const, title: entry.title, kicker: `${entry.toolpackId} / ${entry.id}`, description: entry.description, entry })),
    ...statuses.map((status) => ({
      key: `tool:${status.tool}`,
      kind: "tool" as const,
      title: status.tool,
      kicker: status.toolpackId ? `${status.toolpackKind ?? "toolpack"} / ${status.toolpackId}` : "observed runtime tool",
      description: status.description,
      status,
      entries: controlsByTool.get(status.tool) ?? [],
    })),
  ];
}

function relatedToolsForEntry(entry: ToolUiEntry): string[] {
  if (entry.id === "messages.conversation" || entry.id === "messages.send") return ["messages.send"];
  if (entry.id === "coordination.signals") return ["coordination.wait_for_signal"];
  if (entry.id === "completion.report") return ["completion.submit"];
  if (entry.id === "file.activity") return ["file.read", "file.write", "file.patch"];
  if (entry.id === "shell.activity") return ["shell.exec"];
  if (entry.id === "web.activity") return ["web.fetch"];
  return [];
}

function toolState(status: ToolStatus): "ready" | "running" | "completed" | "failed" | "submitted" {
  return status.submittedReportPath ? "submitted" : status.lastStatus ?? "ready";
}

function ToolUiCard({ projectId, entry }: { projectId: string; entry: ToolUiEntry }) {
  const [form, setForm] = useState<Record<string, unknown>>(() => defaultToolUiInput(entry));
  const [result, setResult] = useState<ToolUiResult>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const fields = toolUiFields(entry);
  const required = toolUiRequired(entry);

  useEffect(() => {
    const initial = defaultToolUiInput(entry);
    setForm(initial);
    setResult(undefined);
    setError("");
    if (entry.kind === "panel") void run(initial);
  }, [projectId, entry.toolpackId, entry.id]);

  async function run(input = form) {
    setRunning(true);
    setError("");
    try {
      setResult(await invokeToolUi(projectId, entry, input));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  }

  function submit(event: SubmitEvent) {
    event.preventDefault();
    void run();
  }

  return (
    <article class="tool-ui-card">
      <div class="item-title"><strong>{entry.title}</strong><span class="tool-ui-kind">{entry.kind}</span></div>
      <small>{entry.toolpackId} / {entry.id}</small>
      {entry.description && <p>{entry.description}</p>}
      <form class="tool-ui-form" onSubmit={submit}>
        {fields.map(([name, schema]) => <ToolUiField name={name} schema={schema} value={form[name]} required={required.has(name)} onChange={(value) => setForm((current) => ({ ...current, [name]: value }))} />)}
        <button class="secondary-button" disabled={running}>{running ? "Running..." : entry.submitLabel ?? (entry.kind === "panel" ? "Refresh" : "Run")}</button>
      </form>
      {error && <div class="form-error">{error}</div>}
      {result && <ToolUiResultView result={result} />}
    </article>
  );
}

function ToolUiField({ name, schema, value, required, onChange }: { name: string; schema: Record<string, unknown>; value: unknown; required: boolean; onChange: (value: unknown) => void }) {
  const label = typeof schema.title === "string" ? schema.title : name;
  const description = typeof schema.description === "string" ? schema.description : undefined;
  const enumValues = Array.isArray(schema.enum) ? schema.enum.filter((item): item is string => typeof item === "string") : [];
  const type = typeof schema.type === "string" ? schema.type : "string";
  return (
    <label class="tool-ui-field">
      <span>{label}{required ? " *" : ""}</span>
      {enumValues.length ? (
        <select value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.currentTarget.value)}>
          {!required && <option value="">(empty)</option>}
          {enumValues.map((item) => <option value={item}>{item}</option>)}
        </select>
      ) : type === "boolean" ? (
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.currentTarget.checked)} />
      ) : type === "number" || type === "integer" ? (
        <input type="number" value={typeof value === "number" ? String(value) : ""} onInput={(event) => onChange(event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value))} />
      ) : (
        <textarea value={typeof value === "string" ? value : ""} onInput={(event) => onChange(event.currentTarget.value)} rows={2} />
      )}
      {description && <small>{description}</small>}
    </label>
  );
}

function ToolUiResultView({ result }: { result: ToolUiResult }) {
  const metrics = toolUiMetrics(result);
  return (
    <div class="tool-ui-result">
      {result.title && <strong>{result.title}</strong>}
      {metrics.length > 0 && <div class="tool-ui-metrics">{metrics.map((metric) => <div><span>{metric.label}</span><strong>{String(metric.value)}</strong>{metric.description && <small>{metric.description}</small>}</div>)}</div>}
      <pre>{result.output}</pre>
    </div>
  );
}

function Panel({ title, subtitle, className = "", children }: { title: string; subtitle?: string; className?: string; children: ComponentChildren }) {
  return <section class={`panel ${className}`}><header class="panel-heading"><div><h3>{title}</h3>{subtitle && <p>{subtitle}</p>}</div></header>{children}</section>;
}

function Metric({ label, value, sub, tone }: { label: string; value: number; sub: string; tone: string }) {
  return <div class={`metric metric-${tone}`}><span>{label}</span><strong>{value}</strong><small>{sub}</small></div>;
}

function AgentCard({ agent }: { agent: Agent }) {
  return <article class={`agent-card agent-${agent.status}`}><div class="agent-avatar">{initials(agent.displayName || agent.id)}</div><div><div class="item-title"><strong>{agent.displayName}</strong><StatusPill status={agent.status} compact /></div><p>{agent.role}</p><small>{agent.id}{agent.activeActivationId ? ` - ${agent.activeActivationId}` : ""}</small></div></article>;
}

function MessageList({ projectId, messages, verbose = false }: { projectId?: string; messages: Message[]; verbose?: boolean }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [fullBodies, setFullBodies] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState("");
  const [error, setError] = useState("");

  async function toggle(message: Message) {
    const nextExpanded = !expanded[message.id];
    setExpanded((current) => ({ ...current, [message.id]: nextExpanded }));
    if (!nextExpanded || !projectId || fullBodies[message.id] !== undefined) return;
    setLoadingId(message.id);
    setError("");
    try {
      const full = await loadMessage(projectId, message.id);
      setFullBodies((current) => ({ ...current, [message.id]: full.body }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoadingId("");
    }
  }

  if (!messages.length) return <Blank label="No messages yet" />;
  return (
    <div class="stack-list message-list">
      {error && <div class="form-error">{error}</div>}
      {messages.map((message) => {
        const isExpanded = expanded[message.id] === true;
        const body = isExpanded ? fullBodies[message.id] ?? message.body : message.body;
        const loading = loadingId === message.id;
        return (
          <article class={`message-item message-card priority-${message.priority.toLowerCase()} ${isExpanded ? "open" : ""}`}>
            <div class="message-card-head">
              <div class="message-route">
                <MessageParty label="From" value={message.sender} tone="source" />
                <span class="message-route-line"><span>to</span></span>
                <MessageParty label={message.recipient ? "Recipient" : "Channel"} value={messageTarget(message)} tone="target" />
              </div>
              <div class="message-status"><small>{formatRelative(message.createdAt)}</small><span class={`priority-badge priority-badge-${message.priority.toLowerCase()}`}>{message.priority}</span></div>
            </div>
            <p class={`message-body ${isExpanded ? "expanded" : verbose ? "relaxed" : ""}`}>{body}</p>
            <div class="message-actions">
              <span>{message.id}</span>
              <span>{body.length.toLocaleString()} chars</span>
              <button class="ghost-button mini-button" disabled={loading} onClick={() => void toggle(message)}>{loading ? "Loading..." : isExpanded ? "Collapse" : "Expand full"}</button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function MessageParty({ label, value, tone }: { label: string; value: string; tone: string }) {
  return <div class={`message-party message-party-${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function StatusPill({ status, compact = false }: { status: ProjectStatus | Agent["status"] | "running" | "completed" | "failed" | "cancelled" | "ready" | "panel" | "action"; compact?: boolean }) { return <span class={`status-pill status-${status} ${compact ? "compact" : ""}`}>{status}</span>; }
function Blank({ label }: { label: string }) { return <div class="blank">{label}</div>; }
function EmptyState({ loading }: { loading: boolean }) { return <section class="empty-state"><div class="empty-orbit" /><h2>{loading ? "Connecting to Suzumio..." : "No projects initialized"}</h2><p>Initialize a YAML project, then refresh this observatory.</p><code>suzumio init path/to/project.yaml</code></section>; }
function initials(value: string): string { return value.split(/[\s_-]+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function formatTime(value: string): string { return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); }
function formatRelative(value: string): string { const seconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return `${seconds}s ago`; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`; return `${Math.floor(seconds / 86400)}d ago`; }
function messageTarget(message: Message): string { return message.recipient ?? message.channel ?? "broadcast"; }
function historyCompactionId(message: AgentHistoryMessage): string | undefined { const value = message.metadata?.compactionId ?? message.compactionId; return typeof value === "string" ? value : undefined; }
function historyToolName(message: AgentHistoryMessage): string | undefined { const structured = message.parts?.find((part) => (part.type === "tool_call" || part.type === "tool_result") && part.toolName)?.toolName; if (structured) return structured; const metadataTool = message.metadata?.tool; if (typeof metadataTool === "string" && metadataTool) return metadataTool; return extractToolNameFromText(message.content); }
function extractToolNameFromText(value: string): string | undefined { const match = value.match(/^Tool:\s*(.+)$/m); return match?.[1]?.trim() || undefined; }
function toolUiSchema(entry: ToolUiEntry): Record<string, unknown> { return isRecord(entry.inputSchema) ? entry.inputSchema : {}; }
function toolUiFields(entry: ToolUiEntry): Array<[string, Record<string, unknown>]> { const properties = toolUiSchema(entry).properties; return isRecord(properties) ? Object.entries(properties).map(([key, value]) => [key, isRecord(value) ? value : {}]) : []; }
function toolUiRequired(entry: ToolUiEntry): Set<string> { const required = toolUiSchema(entry).required; return new Set(Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : []); }
function defaultToolUiInput(entry: ToolUiEntry): Record<string, unknown> { const out: Record<string, unknown> = {}; for (const [key, schema] of toolUiFields(entry)) { if (schema.default !== undefined) out[key] = schema.default; else if (schema.type === "boolean") out[key] = false; } return out; }
function toolUiMetrics(result: ToolUiResult): Array<{ label: string; value: string | number | boolean; description?: string }> { const metrics = result.metadata?.metrics; if (!Array.isArray(metrics)) return []; return metrics.flatMap((item) => { if (!isRecord(item) || typeof item.label !== "string") return []; const value = typeof item.value === "string" || typeof item.value === "number" || typeof item.value === "boolean" ? item.value : JSON.stringify(item.value ?? ""); return [{ label: item.label, value, description: typeof item.description === "string" ? item.description : undefined }]; }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
