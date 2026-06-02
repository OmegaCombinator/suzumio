import type { AgentHistoryMessage } from "./types.js";

export const DEFAULT_TAIL_MESSAGES = 12;
export const MAX_MODEL_MESSAGE_CHARS = 40_000;
export const MAX_MODEL_TOOL_RESULT_CHARS = 12_000;
export const MAX_RETRY_TAIL_CHARS = 80_000;
export const MAX_SUMMARY_CHARS = 20_000;
export const MAX_SUMMARY_HISTORY_CHARS = 80_000;
export const MAX_SUMMARY_TURN_CHARS = 12_000;
export const MAX_SUMMARY_TOOL_RESULT_CHARS = 3_000;

const FALLBACK_RECENT_MESSAGES = 10;
const FALLBACK_MESSAGE_CHARS = 900;

export function renderHistoryMessageForModel(item: AgentHistoryMessage): string {
  const content = renderHistoryMessage(item);
  return trimChars(content, item.role === "tool_result" ? MAX_MODEL_TOOL_RESULT_CHARS : MAX_MODEL_MESSAGE_CHARS);
}

export function trimHistoryForSummary(history: AgentHistoryMessage[]): string {
  let used = 0;
  const rendered: string[] = [];
  for (const item of history) {
    const limit = item.role === "tool_result" ? MAX_SUMMARY_TOOL_RESULT_CHARS : MAX_SUMMARY_TURN_CHARS;
    const body = trimChars(renderHistoryForSummary(item), limit);
    const remaining = MAX_SUMMARY_HISTORY_CHARS - used;
    if (remaining <= 0) break;
    rendered.push(body.length > remaining ? trimChars(body, remaining) : body);
    used += body.length;
  }
  return rendered.join("\n\n");
}

export function retryTailMessageCount(history: AgentHistoryMessage[], maxMessages = DEFAULT_TAIL_MESSAGES, maxChars = MAX_RETRY_TAIL_CHARS): number {
  if (history.length <= 1) return history.length;
  let used = 0;
  let count = 0;
  for (let index = history.length - 1; index >= 0 && count < maxMessages; index -= 1) {
    const chars = renderHistoryMessageForModel(history[index]!).length;
    if (count > 0 && used + chars > maxChars) break;
    used += chars;
    count += 1;
  }
  return Math.max(1, count);
}

export function fallbackAgentHistorySummary(input: {
  agentId: string;
  history: AgentHistoryMessage[];
  archived: AgentHistoryMessage[];
  keepTail: number;
  overflowError: string;
  summaryError: string;
  selectedModel?: string;
}): string {
  const firstPrompt = input.history.find((message) => message.kind === "activation_prompt") ?? input.history[0];
  const recentArchived = input.archived.slice(-FALLBACK_RECENT_MESSAGES);
  const paths = extractPaths(recentArchived.map((message) => message.content).join("\n"));
  const lines = [
    "## Goal",
    `- ${firstPrompt ? firstUsefulLine(firstPrompt.content) : `Continue the assigned activation for ${input.agentId}.`}`,
    "",
    "## Constraints & Preferences",
    "- Follow the active agent prompt, project task, and remaining recent history messages.",
    "- Prefer concise tool output and avoid re-reading large archived history unless necessary.",
    "",
    "## Progress",
    "### Done",
    `- Preserved ${input.archived.length} older history messages in the history archive after a provider context overflow.`,
    "",
    "### In Progress",
    `- Continue from the latest ${input.keepTail} unarchived history messages after this summary.`,
    "",
    "### Blocked",
    `- Original provider overflow error: ${trimInline(input.overflowError, 700)}`,
    `- Model-based history summarization failed, so this deterministic fallback summary was used: ${trimInline(input.summaryError, 700)}`,
    "",
    "## Key Decisions",
    "- Older raw history remains archived; only a compact summary and recent tail should be replayed to the model.",
    "",
    "## Next Steps",
    "- Continue the current activation using the recent tail messages as the freshest source of truth.",
    "- If critical details seem missing, inspect the history archive referenced by the compaction metadata instead of asking the user to repeat context.",
    "",
    "## Critical Context",
    `- Agent: ${input.agentId}`,
    input.selectedModel ? `- Selected model: ${input.selectedModel}` : undefined,
    `- Archived sequence range: ${sequenceRange(input.archived)}`,
    `- Recent archived messages: ${recentArchived.map(renderFallbackMessageLine).join("; ") || "(none)"}`,
    "",
    "## Relevant Files",
    ...(paths.length ? paths.map((file) => `- ${file}`) : ["- (none recovered from the compacted segment)"]),
  ].filter((line): line is string => line !== undefined);
  return trimChars(lines.join("\n"), MAX_SUMMARY_CHARS);
}

function renderHistoryMessage(item: AgentHistoryMessage): string {
  if (item.role === "compaction") return `# Compacted Agent History\n\n${item.content}`;
  if (item.role === "tool_call") return `# Tool Call Record\n\n${item.content}`;
  if (item.role === "tool_result") return `# Tool Result Record\n\n${item.content}`;
  return item.content;
}

function renderHistoryForSummary(item: AgentHistoryMessage): string {
  return [`## ${item.sequence} ${item.role} ${item.kind}`, `Time: ${item.createdAt}`, item.activationId ? `Activation: ${item.activationId}` : undefined, item.compactionId ? `Archived by: ${item.compactionId}` : undefined, "", item.content].filter(Boolean).join("\n");
}

function renderFallbackMessageLine(message: AgentHistoryMessage): string {
  return `${message.sequence} ${message.role}/${message.kind}: ${trimInline(firstUsefulLine(message.content), FALLBACK_MESSAGE_CHARS)}`;
}

function sequenceRange(messages: AgentHistoryMessage[]): string {
  if (messages.length === 0) return "(none)";
  const sequences = messages.map((message) => message.sequence);
  return `${Math.min(...sequences)}-${Math.max(...sequences)} (${messages.length} messages)`;
}

function firstUsefulLine(text: string): string {
  return trimInline(text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Continue the assigned activation.", FALLBACK_MESSAGE_CHARS);
}

function extractPaths(text: string): string[] {
  const found = new Set<string>();
  const pattern = /(?:^|\s)(\/[^\s"'<>`]+|(?:\.\.?\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)/g;
  for (const match of text.matchAll(pattern)) {
    const value = match[1]?.replace(/[),.;:]+$/, "");
    if (!value || value.length > 180) continue;
    if (!value.includes("/") || value.includes("//")) continue;
    found.add(value);
    if (found.size >= 12) break;
  }
  return [...found];
}

function trimInline(text: string, maxChars: number): string {
  return trimChars(text.replace(/\s+/g, " ").trim(), maxChars).replace(/\n+/g, " ");
}

export function trimChars(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n[truncated ${trimmed.length - maxChars} chars]`;
}
