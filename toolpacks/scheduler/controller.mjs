import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const WEEKDAYS = new Map([
  ["sun", 0],
  ["mon", 1],
  ["tue", 2],
  ["wed", 3],
  ["thu", 4],
  ["fri", 5],
  ["sat", 6],
]);

export async function createControllerToolpack(context) {
  return {
    tools: {
      "schedule.once": (input) => scheduleOnce(context, input),
      "schedule.recurring": (input) => scheduleRecurring(context, input),
      "schedule.list": (input) => scheduleList(context, input),
      "schedule.cancel": (input) => scheduleCancel(context, input),
    },
  };
}

export async function createWebuiToolpack(context) {
  return {
    webui: {
      "schedule.jobs": (input) => scheduleList(context, input),
      "schedule.once": (input) => scheduleOnce(context, input),
      "schedule.recurring": (input) => scheduleRecurring(context, input),
      "schedule.cancel": (input) => scheduleCancel(context, input),
    },
  };
}

export async function schedulerTick(context) {
  await sendDueJobs(context);
  return [];
}

async function scheduleOnce(context, input) {
  const args = objectInput(input);
  const now = Date.now();
  const route = routeFromInput(context, args);
  const nextAt = onceNextAt(args, now);
  const state = await loadState(context);
  const job = {
    id: `sch_${randomUUID()}`,
    type: "once",
    status: "active",
    createdAt: iso(now),
    nextAt,
    sentCount: 0,
    sender: stringValue(args.sender) ?? "scheduler",
    recipient: route.recipient,
    channel: route.channel,
    priority: priorityValue(args.priority ?? "P3"),
    waitForQuiet: booleanValue(args.waitForQuiet) ?? false,
    body: requiredString(args.body, "body"),
    schedule: { at: stringValue(args.at), afterMs: delayMs(args) || undefined },
  };
  state.jobs.push(job);
  await saveState(context, state);
  return jobCreatedOutput(job);
}

async function scheduleRecurring(context, input) {
  const args = objectInput(input);
  const now = Date.now();
  const route = routeFromInput(context, args);
  const schedule = recurringSchedule(args);
  const startAt = stringValue(args.startAt);
  const startMs = startAt ? timestamp(startAt, "startAt") : undefined;
  const nextAt = initialRecurringAt(schedule, now, startMs);
  const state = await loadState(context);
  const job = {
    id: `sch_${randomUUID()}`,
    type: "recurring",
    status: "active",
    createdAt: iso(now),
    nextAt,
    sentCount: 0,
    sender: stringValue(args.sender) ?? "scheduler",
    recipient: route.recipient,
    channel: route.channel,
    priority: priorityValue(args.priority ?? "P3"),
    waitForQuiet: booleanValue(args.waitForQuiet) ?? false,
    body: requiredString(args.body, "body"),
    schedule: { ...schedule, startAt },
  };
  state.jobs.push(job);
  await saveState(context, state);
  return jobCreatedOutput(job);
}

async function scheduleList(context, input) {
  const args = objectInput(input ?? {});
  const includeInactive = booleanValue(args.includeInactive) ?? false;
  const state = await loadState(context);
  const jobs = state.jobs.filter((job) => includeInactive || job.status === "active");
  const metrics = [
    { label: "Active", value: state.jobs.filter((job) => job.status === "active").length },
    { label: "Done", value: state.jobs.filter((job) => job.status === "done").length },
    { label: "Cancelled", value: state.jobs.filter((job) => job.status === "cancelled").length },
  ];
  const output = [
    "Scheduled messages:",
    ...(jobs.length ? jobs.map(formatJob) : ["- none"]),
  ].join("\n");
  return { title: "scheduled messages", output, metadata: { metrics, jobs } };
}

async function scheduleCancel(context, input) {
  const args = objectInput(input);
  const id = requiredString(args.id, "id");
  const state = await loadState(context);
  const job = state.jobs.find((item) => item.id === id);
  if (!job) throw new Error(`Unknown scheduled job: ${id}`);
  if (job.status === "active") {
    job.status = "cancelled";
    job.cancelledAt = new Date().toISOString();
    await saveState(context, state);
  }
  return { title: "scheduled message cancelled", output: `Cancelled ${id}.`, metadata: { job } };
}

async function sendDueJobs(context) {
  const state = await loadState(context);
  const now = Date.now();
  const nowText = iso(now);
  let changed = false;
  for (const job of state.jobs) {
    if (job.status !== "active") continue;
    if (timestamp(job.nextAt, "nextAt") > now) continue;
    if (job.waitForQuiet && job.recipient && modelAlive(context, job.recipient)) continue;
    const message = context.store.sendMessage({ sender: job.sender, recipient: job.recipient, channel: job.channel, priority: job.priority, body: job.body });
    job.sentCount = Math.max(0, Math.trunc(Number(job.sentCount) || 0)) + 1;
    job.lastSentAt = nowText;
    job.lastMessageId = message.id;
    if (job.type === "once") {
      job.status = "done";
      job.completedAt = nowText;
    } else {
      job.nextAt = nextRecurringAt(job.schedule, now);
    }
    changed = true;
  }
  if (changed) await saveState(context, state);
}

function modelAlive(context, agentId) {
  return context.agents?.some((agent) => agent.id === agentId && agent.modelAlive) ?? false;
}

function routeFromInput(context, args) {
  const recipient = stringValue(args.recipient);
  const channel = stringValue(args.channel);
  if (recipient && channel) throw new Error("Use either recipient or channel, not both");
  if (channel) {
    const channels = context.store.config().channels ?? [];
    if (!channels.includes(channel)) throw new Error(`Unknown channel: ${channel}`);
    return { channel };
  }
  const agents = context.store.listAgents();
  const target = recipient ?? defaultRecipient(context, agents);
  if (target !== "user" && !agents.some((agent) => agent.id === target)) throw new Error(`Unknown recipient: ${target}`);
  return { recipient: target };
}

function defaultRecipient(context, agents) {
  const coordinator = context.store.config().communication?.coordinatorAgent ?? "pm";
  if (agents.some((agent) => agent.id === coordinator)) return coordinator;
  return agents[0]?.id ?? "user";
}

function onceNextAt(args, now) {
  const at = stringValue(args.at);
  if (at) return iso(timestamp(at, "at"));
  const delay = delayMs(args);
  if (!delay) throw new Error("schedule.once requires at or a positive after* delay");
  return iso(now + delay);
}

function delayMs(args) {
  return Math.max(0,
    numberValue(args.afterMs) ?? 0,
  )
    + Math.max(0, numberValue(args.afterSeconds) ?? 0) * 1000
    + Math.max(0, numberValue(args.afterMinutes) ?? 0) * 60_000
    + Math.max(0, numberValue(args.afterHours) ?? 0) * 3_600_000
    + Math.max(0, numberValue(args.afterDays) ?? 0) * 86_400_000;
}

function recurringSchedule(args) {
  const interval = Math.max(0,
    numberValue(args.everyMs) ?? 0,
  )
    + Math.max(0, numberValue(args.everyMinutes) ?? 0) * 60_000
    + Math.max(0, numberValue(args.everyHours) ?? 0) * 3_600_000
    + Math.max(0, numberValue(args.everyDays) ?? 0) * 86_400_000;
  const weekday = stringValue(args.weekday);
  const time = stringValue(args.time);
  if (interval > 0 && (weekday || time)) throw new Error("Use either an every* interval or weekday/time, not both");
  if (interval > 0) return { mode: "interval", everyMs: interval };
  if (!weekday || !time) throw new Error("schedule.recurring requires a positive every* interval, or weekday plus time");
  if (!WEEKDAYS.has(weekday)) throw new Error(`Invalid weekday: ${weekday}`);
  const [hour, minute] = parseTime(time);
  return { mode: "weekly", weekday, hour, minute, timezone: "UTC" };
}

function nextRecurringAt(schedule, afterMs) {
  if (schedule.mode === "interval") {
    const everyMs = Math.max(1, Math.trunc(Number(schedule.everyMs)));
    return iso(afterMs + everyMs);
  }
  if (schedule.mode === "weekly") {
    const weekday = WEEKDAYS.get(schedule.weekday);
    if (weekday === undefined) throw new Error(`Invalid weekday: ${schedule.weekday}`);
    const hour = Math.max(0, Math.min(23, Math.trunc(Number(schedule.hour))));
    const minute = Math.max(0, Math.min(59, Math.trunc(Number(schedule.minute))));
    const base = new Date(afterMs);
    const start = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour, minute, 0, 0);
    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = start + offset * 86_400_000;
      if (new Date(candidate).getUTCDay() === weekday && candidate > afterMs) return iso(candidate);
    }
  }
  throw new Error(`Invalid recurring schedule: ${JSON.stringify(schedule)}`);
}

function initialRecurringAt(schedule, now, startMs) {
  if (schedule.mode === "interval" && startMs && startMs > now) return iso(startMs);
  return nextRecurringAt(schedule, startMs && startMs > now ? startMs - 1 : now);
}

function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid time, expected HH:MM: ${value}`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error(`Invalid time, expected HH:MM: ${value}`);
  return [hour, minute];
}

async function loadState(context) {
  const file = stateFile(context);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return { version: 1, jobs: Array.isArray(parsed.jobs) ? parsed.jobs : [] };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { version: 1, jobs: [] };
    throw error;
  }
}

async function saveState(context, state) {
  const file = stateFile(context);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, jobs: state.jobs }, null, 2) + "\n", "utf8");
}

function stateFile(context) {
  return path.join(context.store.paths.root, "toolpack-state", "scheduler", "jobs.json");
}

function jobCreatedOutput(job) {
  return {
    title: "scheduled message created",
    output: [`Scheduled ${job.id}.`, `Next: ${job.nextAt}`, `Route: ${job.sender} -> ${job.recipient ?? job.channel}`, `Priority: ${job.priority}`].join("\n"),
    metadata: { job },
  };
}

function formatJob(job) {
  const route = job.recipient ?? job.channel ?? "no target";
  const quiet = job.waitForQuiet ? ", waits for quiet" : "";
  return `- ${job.id} [${job.status}/${job.type}] next ${job.nextAt ?? "none"}, ${job.priority} ${job.sender} -> ${route}, sent ${job.sentCount ?? 0}${quiet}: ${oneLine(job.body, 140)}`;
}

function objectInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object");
  return input;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function booleanValue(value) {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Expected finite number, got ${String(value)}`);
  return value;
}

function priorityValue(value) {
  if (PRIORITIES.has(value)) return value;
  throw new Error(`Invalid priority: ${String(value)}`);
}

function timestamp(value, label) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`Invalid ${label} timestamp: ${value}`);
  return ms;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function oneLine(value, limit) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}
