import http from "node:http";
import { readFile } from "node:fs/promises";
import { ProjectStore } from "./store.js";
import { ToolSupportHost } from "./tools.js";
import { NonPreemptiveSignalScheduler } from "./scheduler.js";
import type { AgentRecord, MessagePriority, RunnerTurnOutput } from "./types.js";

export type ServeOptions = {
  host: string;
  port: number;
  root?: string;
  scheduler?: boolean;
};

export async function serveSuzumio(options: ServeOptions): Promise<http.Server> {
  const scheduler = new NonPreemptiveSignalScheduler(options.root);
  const toolSupport = new ToolSupportHost(options.root);
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, { root: options.root, schedulerEngine: scheduler, toolSupport }).catch((error) => {
      text(response, error instanceof Error ? error.message : String(error), 500);
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  if (options.scheduler !== false) {
    setInterval(() => void scheduler.tickAll().catch((error) => console.warn("scheduler tick failed", error)), 2_000).unref();
    void scheduler.tickAll().catch(() => undefined);
  }
  console.log(`suzumio listening on http://${options.host}:${options.port}`);
  return server;
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  ctx: { root?: string; schedulerEngine: NonPreemptiveSignalScheduler; toolSupport: ToolSupportHost },
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (request.method === "GET" && url.pathname === "/health") return json(response, { healthy: true });
  if (request.method === "GET" && url.pathname === "/") return html(response, WEBUI_HTML);
  if (request.method === "POST" && url.pathname === "/runner/tool-calls/start") return json(response, await ctx.toolSupport.startToolCall(await readBody(request)));
  if (request.method === "POST" && url.pathname === "/runner/tool-calls/finish") return json(response, await ctx.toolSupport.finishToolCall(await readBody(request)));
  if (request.method === "POST" && url.pathname === "/runner/signals") return json(response, await ctx.toolSupport.recordRunnerSignal(await readBody(request)));
  if (request.method === "POST" && parts[0] === "toolpacks" && parts[2] === "support") return json(response, await ctx.toolSupport.support(parts[1]!, await readBody(request)));
  if (request.method === "POST" && url.pathname === "/turn-output") return json(response, await submitTurnOutput(await readBody(request), ctx.root));

  if (request.method === "GET" && url.pathname === "/api/projects") return json(response, await listProjects(ctx.root));
  if (parts[0] !== "api" || parts[1] !== "projects" || !parts[2]) return json(response, { error: "not found" }, 404);

  const project = parts[2];
  const store = new ProjectStore(project, ctx.root);
  try {
    if (request.method === "GET" && parts.length === 3) return json(response, projectSummary(store));
    if (request.method === "GET" && parts[3] === "agents") return json(response, store.listAgents().map(publicAgent));
    if (request.method === "GET" && parts[3] === "messages") return json(response, store.listMessages(limit(url, 100)));
    if (request.method === "GET" && parts[3] === "events") return json(response, store.listEvents(limit(url, 200)));
    if (request.method === "GET" && parts[3] === "turns") return json(response, store.listTurns(limit(url, 100)));
    if (request.method === "GET" && parts[3] === "tool-calls") return json(response, store.listToolCalls(limit(url, 100)));
    if (request.method === "GET" && parts[3] === "artifacts") return json(response, store.listArtifacts(limit(url, 100)));
    if (request.method === "GET" && parts[3] === "config" && parts[4] === "resolved") return text(response, await readFile(store.paths.resolvedConfig, "utf8"));
    if (request.method === "GET" && parts[3] === "report") return text(response, await reportText(store));
    if (request.method === "GET" && parts[3] === "stream") return streamEvents(response, store, url);

    if (request.method === "POST" && parts[3] === "start") {
      store.setProjectStatus("running");
      await ctx.schedulerEngine.tickProject(project);
      return json(response, projectSummary(store));
    }
    if (request.method === "POST" && parts[3] === "stop") {
      store.setProjectStatus("stopped");
      return json(response, projectSummary(store));
    }
    if (request.method === "POST" && parts[3] === "approve") {
      store.setProjectStatus("completed");
      return json(response, projectSummary(store));
    }
    if (request.method === "POST" && parts[3] === "request-changes") {
      const body = await readBody<Record<string, unknown>>(request);
      store.setProjectStatus("running");
      store.sendMessage({ sender: "user", recipient: optionalString(body.recipient) ?? "pm", priority: "P1", body: requiredString(body.body, "body") });
      await ctx.schedulerEngine.tickProject(project);
      return json(response, projectSummary(store));
    }
    if (request.method === "POST" && parts[3] === "messages") {
      const body = await readBody<Record<string, unknown>>(request);
      const message = store.sendMessage({ sender: optionalString(body.sender) ?? "user", recipient: optionalString(body.recipient), channel: optionalString(body.channel), priority: priority(optionalString(body.priority) ?? "P1"), body: requiredString(body.body, "body") });
      await ctx.schedulerEngine.tickProject(project);
      return json(response, message);
    }
  } finally {
    store.close();
  }
  return json(response, { error: "not found" }, 404);
}

async function submitTurnOutput(body: Record<string, unknown>, root?: string): Promise<Record<string, unknown>> {
  const project = requiredString(body.project, "project");
  const agentId = requiredString(body.agentId, "agentId");
  const turnId = requiredString(body.turnId, "turnId");
  const token = requiredString(body.token, "token");
  const output = outputBody(body.output);
  const store = new ProjectStore(project, root);
  try {
    const agent = store.requireAgent(agentId);
    if (agent.token !== token) throw new Error("Invalid agent token");
    const turn = store.turn(turnId);
    if (turn.agentId !== agent.id) throw new Error(`Turn ${turnId} does not belong to ${agent.id}`);
    if (turn.status !== "running") return { status: turn.status, turnId };
    store.completeTurn(turnId, output);
    return { status: "completed", turnId };
  } finally {
    store.close();
  }
}

function outputBody(value: unknown): RunnerTurnOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("output is required");
  const output = value as Record<string, unknown>;
  return { text: requiredString(output.text, "output.text"), usage: typeof output.usage === "object" && output.usage && !Array.isArray(output.usage) ? (output.usage as Record<string, unknown>) : undefined };
}

async function listProjects(root?: string): Promise<Record<string, unknown>[]> {
  const names = await ProjectStore.list(root);
  return names.map((name) => {
    const store = new ProjectStore(name, root);
    try {
      return projectSummary(store);
    } finally {
      store.close();
    }
  });
}

function projectSummary(store: ProjectStore): Record<string, unknown> {
  const project = store.projectRow();
  return { ...publicProject(project), agents: store.listAgents().map(publicAgent), recentTurns: store.listTurns(10), recentMessages: store.listMessages(10) };
}

function publicProject(row: Record<string, unknown>): Record<string, unknown> {
  const { config_json: _config, ...safe } = row;
  return safe;
}

function publicAgent(agent: AgentRecord): Record<string, unknown> {
  const { token: _token, ...safe } = agent;
  return safe;
}

async function reportText(store: ProjectStore): Promise<string> {
  const row = store.projectRow();
  const report = row.submitted_report;
  if (typeof report !== "string" || !report) return "No report submitted.\n";
  return readFile(report, "utf8");
}

function streamEvents(response: http.ServerResponse, store: ProjectStore, url: URL): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let seen = new Set<string>();
  const send = () => {
    const events = store.listEvents(limit(url, 100)).reverse() as Array<Record<string, unknown>>;
    for (const event of events) {
      const id = String(event.id);
      if (seen.has(id)) continue;
      seen.add(id);
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  send();
  const timer = setInterval(send, 2_000);
  response.on("close", () => clearInterval(timer));
}

async function readBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? (JSON.parse(text) as T) : ({} as T);
}

function limit(url: URL, fallback: number): number {
  const value = Number(url.searchParams.get("limit") ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.min(500, Math.floor(value)) : fallback;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function priority(value: string): MessagePriority {
  if (value === "P0" || value === "P1" || value === "P2" || value === "P3") return value;
  throw new Error(`Invalid priority: ${value}`);
}

function json(response: http.ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value, null, 2) + "\n");
}

function text(response: http.ServerResponse, value: string, status = 200): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(value.endsWith("\n") ? value : value + "\n");
}

function html(response: http.ServerResponse, value: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(value);
}

const WEBUI_HTML = String.raw`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Suzumio</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #101114; color: #eceff4; }
    header { display: flex; gap: 16px; align-items: center; padding: 16px 20px; border-bottom: 1px solid #2a2d35; }
    h1 { margin: 0; font-size: 18px; letter-spacing: .04em; }
    main { display: grid; grid-template-columns: 320px 1fr; min-height: calc(100vh - 58px); }
    aside { border-right: 1px solid #2a2d35; padding: 16px; }
    section { padding: 16px; }
    button, select, input, textarea { background: #181b22; color: #eceff4; border: 1px solid #3a3f4b; border-radius: 8px; padding: 8px; }
    button { cursor: pointer; }
    .card { background: #151820; border: 1px solid #2a2d35; border-radius: 12px; padding: 12px; margin-bottom: 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
    .muted { color: #a7adba; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #0b0c10; padding: 10px; border-radius: 8px; }
    textarea { width: 100%; min-height: 90px; box-sizing: border-box; }
    .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #263247; color: #b7cdfb; }
  </style>
</head>
<body>
  <header><h1>Suzumio</h1><select id="project"></select><button onclick="refresh()">Refresh</button></header>
  <main>
    <aside>
      <div class="card"><strong>Send Message</strong><p><input id="recipient" placeholder="recipient agent id" value="pm" /></p><textarea id="body" placeholder="message"></textarea><p><button onclick="sendMessage()">Send</button></p></div>
      <div id="projects"></div>
    </aside>
    <section>
      <div id="summary" class="card"></div>
      <div class="grid"><div class="card"><h3>Agents</h3><div id="agents"></div></div><div class="card"><h3>Artifacts</h3><div id="artifacts"></div></div></div>
      <div class="grid"><div class="card"><h3>Messages</h3><div id="messages"></div></div><div class="card"><h3>Turns</h3><div id="turns"></div></div></div>
      <div class="card"><h3>Events</h3><div id="events"></div></div>
    </section>
  </main>
  <script>
    async function api(path, options) { const r = await fetch(path, options); if (!r.ok) throw new Error(await r.text()); return r.json(); }
    async function loadProjects() { const projects = await api('/api/projects'); const sel = document.getElementById('project'); sel.innerHTML = projects.map(p => '<option>'+p.id+'</option>').join(''); document.getElementById('projects').innerHTML = projects.map(p => '<div class="card"><b>'+p.id+'</b><br><span class="pill">'+p.status+'</span></div>').join(''); if (projects[0]) await loadProject(sel.value || projects[0].id); }
    async function loadProject(name) { if (!name) return; const [p, events, artifacts] = await Promise.all([api('/api/projects/'+name), api('/api/projects/'+name+'/events?limit=40'), api('/api/projects/'+name+'/artifacts')]); document.getElementById('summary').innerHTML = '<b>'+p.id+'</b> <span class="pill">'+p.status+'</span><p class="muted">'+p.task+'</p>'; document.getElementById('agents').innerHTML = p.agents.map(a => '<p><b>'+a.id+'</b> <span class="pill">'+a.status+'</span><br><span class="muted">'+a.role+'</span></p>').join(''); document.getElementById('messages').innerHTML = p.recentMessages.map(m => '<pre><b>'+m.sender+'</b> -> '+(m.recipient || m.channel)+' ['+m.priority+']\n'+m.body+'</pre>').join(''); document.getElementById('turns').innerHTML = p.recentTurns.map(t => '<pre><b>'+t.agentId+'</b> '+t.status+'\n'+(t.text || t.error || '').slice(0, 600)+'</pre>').join(''); document.getElementById('events').innerHTML = events.reverse().map(e => '<pre>'+e.type+' '+e.created_at+'\n'+e.data_json+'</pre>').join(''); document.getElementById('artifacts').innerHTML = artifacts.map(a => '<pre>'+a.id+' '+a.name+'\n'+a.path+'</pre>').join('') || '<p class="muted">No artifacts</p>'; }
    async function refresh() { const name = document.getElementById('project').value; if (name) await loadProject(name); else await loadProjects(); }
    async function sendMessage() { const name = document.getElementById('project').value; await api('/api/projects/'+name+'/messages', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ recipient: document.getElementById('recipient').value, body: document.getElementById('body').value }) }); document.getElementById('body').value=''; await refresh(); }
    document.getElementById('project').addEventListener('change', e => loadProject(e.target.value));
    loadProjects().catch(e => document.body.innerHTML = '<pre>'+e.stack+'</pre>'); setInterval(refresh, 5000);
  </script>
</body>
</html>`;
