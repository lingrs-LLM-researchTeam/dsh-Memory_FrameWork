import { expect, it } from "vitest";
import { rebalance, type Weights, type WeightKey } from "../src/ui-models.js";
import { plainText } from "../src/runtime.js";

it("rebalances six weights without changing budgets and handles zero remainder", () => {
  const defaults: Weights = {
    task: 0.3,
    relevance: 0.25,
    evidence: 0.2,
    importance: 0.1,
    dependency: 0.1,
    recency: 0.05,
    redundancy: 0.15,
    half_life_days: 60,
    limit: 8,
    context_chars: 16000,
    min_relevance: 0.05,
  };
  const keys: WeightKey[] = [
    "task",
    "relevance",
    "evidence",
    "importance",
    "dependency",
    "recency",
  ];
  let next = defaults;
  for (const key of keys)
    for (const value of [0, 0.01, 0.4, 1]) {
      next = rebalance(next, key, value);
      expect(keys.reduce((sum, k) => sum + next[k], 0)).toBeCloseTo(1, 12);
      expect(keys.every((k) => next[k] >= 0 && next[k] <= 1)).toBe(true);
      expect(next.context_chars).toBe(16000);
    }
});

it("extracts text blocks without fabricating media contents", () => {
  expect(
    plainText([
      { type: "text", text: "actual text" },
      { type: "image", data: "secret" },
      { type: "text", text: "second" },
    ]),
  ).toBe("actual text\nsecond");
});
