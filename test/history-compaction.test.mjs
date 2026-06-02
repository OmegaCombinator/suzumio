import assert from "node:assert/strict";
import test from "node:test";
import { fallbackAgentHistorySummary, renderHistoryMessageForModel, retryTailMessageCount, trimHistoryForSummary } from "../dist/history-compaction.js";

function historyMessage(sequence, role, kind, content) {
  return {
    id: `hist_${sequence}`,
    project: "project",
    agentId: "agent",
    activationId: "act",
    role,
    kind,
    content,
    sequence,
    archived: false,
    metadata: {},
    parts: [],
    createdAt: "2026-06-02T00:00:00.000Z",
  };
}

test("fallback summary stays bounded and records summary failure", () => {
  const huge = "x".repeat(500_000);
  const history = [
    historyMessage(1, "user", "activation_prompt", "Prove the target theorem in /workspace/src/example.ac"),
    historyMessage(2, "tool_result", "tool_result", huge),
    historyMessage(3, "assistant", "assistant_output", "Continue from recent state."),
  ];
  const summary = fallbackAgentHistorySummary({
    agentId: "agent",
    history,
    archived: history.slice(0, 2),
    keepTail: 1,
    overflowError: "Your input exceeds the context window of this model.",
    summaryError: "summary prompt is too long",
    selectedModel: "worker",
  });

  assert(summary.length <= 20_000);
  assert.match(summary, /summary prompt is too long/);
  assert.match(summary, /\/workspace\/src\/example\.ac/);
  assert.doesNotMatch(summary, /x{10_000}/);
});

test("summary rendering caps large tool results", () => {
  const summaryInput = trimHistoryForSummary([
    historyMessage(1, "tool_result", "tool_result", "a".repeat(200_000)),
    historyMessage(2, "tool_result", "tool_result", "b".repeat(200_000)),
  ]);

  assert(summaryInput.length <= 80_000);
  assert.match(summaryInput, /truncated/);
  assert.doesNotMatch(summaryInput, /a{50_000}/);
});

test("retry tail selection respects the replay character budget", () => {
  const history = Array.from({ length: 20 }, (_, index) => historyMessage(index + 1, "assistant", "assistant_output", `message ${index}\n${"c".repeat(30_000)}`));
  const keepTail = retryTailMessageCount(history, 12, 80_000);

  assert(keepTail >= 1);
  assert(keepTail < 12);
});

test("model replay trims giant tool results", () => {
  const rendered = renderHistoryMessageForModel(historyMessage(1, "tool_result", "tool_result", "d".repeat(200_000)));

  assert(rendered.length < 20_000);
  assert.match(rendered, /Tool Result Record/);
  assert.match(rendered, /truncated/);
});
