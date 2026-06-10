import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ITEM_STATUSES = new Set(["tbd", "done", "wont_do"]);
const CLOSE_STATUSES = new Set(["done", "abandoned"]);
const NUDGE_KIND = "plan.continuation_nudge";

export async function createControllerToolpack(context) {
  return {
    tools: {
      "plan.create": (input) => planCreate(context, input),
      "plan.status": (input) => planStatus(context, input),
      "plan.update": (input) => planUpdate(context, input),
      "plan.set_item_status": (input) => planSetItemStatus(context, input),
      "plan.close": (input) => planClose(context, input),
    },
  };
}

export async function createWebuiToolpack(context) {
  return {
    webui: {
      "plan.board": (input) => planStatus(context, input),
      "plan.create": (input) => planCreate(context, input),
      "plan.update": (input) => planUpdate(context, input),
      "plan.set_item_status": (input) => planSetItemStatus(context, input),
      "plan.close": (input) => planClose(context, input),
    },
  };
}

export async function schedulerTick(context) {
  return maybePlanContinuationNudge(context);
}

async function planCreate(context, input) {
  const args = objectInput(input);
  const now = new Date().toISOString();
  const state = await loadState(context);
  if (state.activePlan && !isPlanComplete(state.activePlan) && !booleanValue(args.replaceActive)) {
    throw new Error(`Active plan already exists: ${state.activePlan.id}. Use plan.update or pass replaceActive:true.`);
  }
  if (state.activePlan) archiveActivePlan(state, booleanValue(args.replaceActive) ? "replaced" : state.activePlan.status ?? "done", "replaced by new plan", now);
  const itemTexts = itemTextsFromInput(args);
  if (itemTexts.length === 0) throw new Error("plan.create requires at least one item in itemsText");
  const plan = {
    id: `pln_${randomUUID()}`,
    status: "active",
    title: requiredString(args.title, "title"),
    targetAgent: targetAgent(context, args.targetAgent),
    instructions: stringValue(args.instructions),
    items: [],
    nextItemNumber: 1,
    nudgeCooldownMs: nonNegativeInteger(args.nudgeCooldownMs, 60_000),
    maxNudges: nonNegativeInteger(args.maxNudges, 0),
    nudgeCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  appendItems(plan, itemTexts, now);
  state.activePlan = plan;
  await saveState(context, state);
  return planOutput("plan created", state, { includeArchived: false });
}

async function planStatus(context, input) {
  const args = objectInput(input ?? {});
  const state = await loadState(context);
  return planOutput("plan status", state, { includeArchived: booleanValue(args.includeArchived) ?? false });
}

async function planUpdate(context, input) {
  const args = objectInput(input);
  const state = await loadState(context);
  const plan = requireActivePlan(state);
  const now = new Date().toISOString();
  const title = stringValue(args.title);
  if (title) plan.title = title;
  if (args.targetAgent !== undefined) plan.targetAgent = targetAgent(context, args.targetAgent);
  if (args.instructions !== undefined) plan.instructions = stringValue(args.instructions);
  if (args.nudgeCooldownMs !== undefined) plan.nudgeCooldownMs = nonNegativeInteger(args.nudgeCooldownMs, plan.nudgeCooldownMs ?? 60_000);
  if (args.maxNudges !== undefined) plan.maxNudges = nonNegativeInteger(args.maxNudges, plan.maxNudges ?? 0);
  const itemTexts = itemTextsFromInput(args);
  if (itemTexts.length > 0) {
    const mode = stringValue(args.itemMode) ?? "append";
    if (mode !== "append" && mode !== "replace") throw new Error(`Invalid itemMode: ${mode}`);
    if (mode === "replace") {
      plan.items = [];
      plan.nextItemNumber = 1;
    }
    appendItems(plan, itemTexts, now);
    if (plan.status === "done" && !isPlanComplete(plan)) {
      plan.status = "active";
      delete plan.completedAt;
    }
  }
  plan.updatedAt = now;
  finalizePlanIfComplete(plan, now);
  await saveState(context, state);
  return planOutput("plan updated", state, { includeArchived: false });
}

async function planSetItemStatus(context, input) {
  const args = objectInput(input);
  const state = await loadState(context);
  const plan = requireActivePlan(state);
  const item = findItem(plan, args);
  const status = itemStatus(args.status);
  const now = new Date().toISOString();
  item.status = status;
  item.updatedAt = now;
  if (args.text !== undefined) item.text = requiredString(args.text, "text");
  if (args.note !== undefined) item.note = stringValue(args.note);
  if (plan.status === "done" && !isPlanComplete(plan)) {
    plan.status = "active";
    delete plan.completedAt;
  }
  plan.updatedAt = now;
  finalizePlanIfComplete(plan, now);
  await saveState(context, state);
  return planOutput("plan item updated", state, { includeArchived: false });
}

async function planClose(context, input) {
  const args = objectInput(input ?? {});
  const state = await loadState(context);
  const plan = requireActivePlan(state);
  const status = closeStatus(stringValue(args.status) ?? "done");
  if (status === "done" && !isPlanComplete(plan)) throw new Error("Cannot close plan as done while items are still tbd; mark them done or wont_do first, or close as abandoned.");
  const now = new Date().toISOString();
  archiveActivePlan(state, status, stringValue(args.reason), now);
  await saveState(context, state);
  return planOutput("plan closed", state, { includeArchived: true });
}

async function maybePlanContinuationNudge(context) {
  const state = await loadState(context);
  const plan = state.activePlan;
  if (!plan || plan.status !== "active") return [];
  const now = new Date().toISOString();
  if (isPlanComplete(plan)) {
    finalizePlanIfComplete(plan, now);
    await saveState(context, state);
    return [];
  }
  if (!context.agents?.some((agent) => agent.id === plan.targetAgent)) return [];
  if (modelAlive(context, plan.targetAgent)) return [];
  if (hasPendingPlanNudge(context, plan)) return [];
  const lastNudgeMs = plan.lastNudgeAt ? Date.parse(plan.lastNudgeAt) : 0;
  const cooldownMs = Math.max(0, Math.trunc(Number(plan.nudgeCooldownMs) || 0));
  if (lastNudgeMs && cooldownMs > 0 && Date.now() - lastNudgeMs < cooldownMs) return [];
  const maxNudges = Math.max(0, Math.trunc(Number(plan.maxNudges) || 0));
  if (maxNudges > 0 && Math.max(0, Math.trunc(Number(plan.nudgeCount) || 0)) >= maxNudges) return [];

  const remaining = plan.items.filter((item) => item.status === "tbd");
  plan.nudgeCount = Math.max(0, Math.trunc(Number(plan.nudgeCount) || 0)) + 1;
  plan.lastNudgeAt = now;
  plan.updatedAt = now;
  await saveState(context, state);
  return [{
    kind: NUDGE_KIND,
    targetAgent: plan.targetAgent,
    priority: "P2",
    usefulEffect: false,
    payload: {
      planId: plan.id,
      title: plan.title,
      message: continuationMessage(plan, remaining),
      remainingItems: remaining.map((item) => ({ id: item.id, text: item.text })),
      nudgeCount: plan.nudgeCount,
    },
  }];
}

function continuationMessage(plan, remaining) {
  return [
    "Continue the active plan before routine queued work.",
    "",
    `Plan: ${plan.title}`,
    `Plan id: ${plan.id}`,
    `Target agent: ${plan.targetAgent}`,
    plan.instructions ? `Instructions: ${plan.instructions}` : undefined,
    "",
    "Remaining TBD items:",
    ...remaining.map((item) => `- ${item.id}: ${item.text}`),
    "",
    "After meaningful progress, call plan.set_item_status to mark items done or wont_do. Use plan.status if you need the current plan state.",
  ].filter(Boolean).join("\n");
}

function hasPendingPlanNudge(context, plan) {
  const rows = context.store.db.prepare("SELECT payload_json FROM signals WHERE project = ? AND kind = ? AND target_agent = ? AND status = 'pending'").all(context.project, NUDGE_KIND, plan.targetAgent);
  return rows.some((row) => {
    try {
      const payload = JSON.parse(String(row.payload_json ?? "{}"));
      return payload.planId === plan.id;
    } catch {
      return true;
    }
  });
}

function modelAlive(context, agentId) {
  return context.agents?.some((agent) => agent.id === agentId && agent.modelAlive) ?? false;
}

function archiveActivePlan(state, status, reason, now) {
  if (!state.activePlan) return;
  const archived = { ...state.activePlan, status, closeReason: reason, closedAt: now, updatedAt: now };
  if (status === "done" && !archived.completedAt) archived.completedAt = now;
  state.archivedPlans = [archived, ...(state.archivedPlans ?? [])].slice(0, 20);
  state.activePlan = null;
}

function appendItems(plan, itemTexts, now) {
  for (const text of itemTexts) {
    const n = Math.max(1, Math.trunc(Number(plan.nextItemNumber) || 1));
    plan.items.push({ id: `item_${n}`, text, status: "tbd", createdAt: now, updatedAt: now });
    plan.nextItemNumber = n + 1;
  }
}

function finalizePlanIfComplete(plan, now) {
  if (!isPlanComplete(plan)) return;
  plan.status = "done";
  plan.completedAt = plan.completedAt ?? now;
}

function isPlanComplete(plan) {
  return Array.isArray(plan.items) && plan.items.length > 0 && plan.items.every((item) => item.status === "done" || item.status === "wont_do");
}

function requireActivePlan(state) {
  if (!state.activePlan) throw new Error("No active plan. Use plan.create first.");
  return state.activePlan;
}

function findItem(plan, args) {
  const itemId = stringValue(args.itemId);
  if (itemId) {
    const item = plan.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error(`Unknown plan item: ${itemId}`);
    return item;
  }
  const index = numberValue(args.itemIndex);
  if (index !== undefined) {
    const item = plan.items[Math.trunc(index) - 1];
    if (!item) throw new Error(`Unknown plan item index: ${index}`);
    return item;
  }
  throw new Error("plan.set_item_status requires itemId or itemIndex");
}

function planOutput(title, state, options) {
  const active = state.activePlan;
  const metrics = active ? planMetrics(active) : [{ label: "Active plan", value: "none" }];
  const sections = [];
  if (active) sections.push(formatPlan(active));
  else sections.push("No active plan.");
  if (options.includeArchived) {
    const archived = state.archivedPlans ?? [];
    sections.push("", "Archived plans:", ...(archived.length ? archived.map(formatArchivedPlan) : ["- none"]));
  }
  return { title, output: sections.join("\n"), metadata: { metrics, activePlan: active, archivedPlans: options.includeArchived ? state.archivedPlans ?? [] : undefined } };
}

function planMetrics(plan) {
  const counts = countStatuses(plan.items);
  return [
    { label: "Status", value: plan.status },
    { label: "TBD", value: counts.tbd ?? 0 },
    { label: "Done", value: counts.done ?? 0 },
    { label: "Won't do", value: counts.wont_do ?? 0 },
    { label: "Nudges", value: Math.max(0, Math.trunc(Number(plan.nudgeCount) || 0)), description: plan.lastNudgeAt ? `last ${plan.lastNudgeAt}` : undefined },
  ];
}

function formatPlan(plan) {
  const counts = countStatuses(plan.items);
  return [
    `Plan ${plan.id}: ${plan.title}`,
    `Status: ${plan.status}`,
    `Target: ${plan.targetAgent}`,
    `Items: ${counts.tbd ?? 0} tbd, ${counts.done ?? 0} done, ${counts.wont_do ?? 0} wont_do`,
    `Nudges: ${plan.nudgeCount ?? 0}${plan.lastNudgeAt ? `, last ${plan.lastNudgeAt}` : ""}`,
    plan.instructions ? `Instructions: ${plan.instructions}` : undefined,
    "",
    "Items:",
    ...plan.items.map(formatItem),
  ].filter(Boolean).join("\n");
}

function formatArchivedPlan(plan) {
  return `- ${plan.id} [${plan.status}] ${plan.title} (${plan.closedAt ?? plan.completedAt ?? plan.updatedAt ?? "unknown time"})`;
}

function formatItem(item, index) {
  const note = item.note ? ` — ${item.note}` : "";
  return `${index + 1}. ${item.id} [${item.status}] ${item.text}${note}`;
}

function countStatuses(items) {
  const counts = {};
  for (const item of items ?? []) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return counts;
}

async function loadState(context) {
  const file = stateFile(context);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return { version: 1, activePlan: parsed.activePlan ?? null, archivedPlans: Array.isArray(parsed.archivedPlans) ? parsed.archivedPlans : [] };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return { version: 1, activePlan: null, archivedPlans: [] };
    throw error;
  }
}

async function saveState(context, state) {
  const file = stateFile(context);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, activePlan: state.activePlan ?? null, archivedPlans: state.archivedPlans ?? [] }, null, 2) + "\n", "utf8");
}

function stateFile(context) {
  return path.join(context.store.paths.root, "toolpack-state", "plan", "state.json");
}

function targetAgent(context, value) {
  const requested = stringValue(value) ?? context.store.config().communication?.coordinatorAgent ?? "pm";
  if (!context.store.listAgents().some((agent) => agent.id === requested)) throw new Error(`Unknown targetAgent: ${requested}`);
  return requested;
}

function itemTextsFromInput(args) {
  if (Array.isArray(args.items)) return args.items.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  const text = stringValue(args.itemsText);
  if (!text) return [];
  return text.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*]\s+|\d+[.)]\s*)/, "").trim()).filter(Boolean);
}

function objectInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Tool input must be an object");
  return input;
}

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
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

function nonNegativeInteger(value, fallback) {
  const n = numberValue(value);
  if (n === undefined) return fallback;
  return Math.max(0, Math.trunc(n));
}

function itemStatus(value) {
  if (ITEM_STATUSES.has(value)) return value;
  throw new Error(`Invalid item status: ${String(value)}`);
}

function closeStatus(value) {
  if (CLOSE_STATUSES.has(value)) return value;
  throw new Error(`Invalid close status: ${String(value)}`);
}
