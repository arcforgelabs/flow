// scripts/ai/clawrouter-budget.mjs: the model choice for Flow's AI workflows.
import test from "node:test";
import assert from "node:assert/strict";
import { chooseModel, chooseSummary, readBudget, reportSummary } from "../scripts/ai/clawrouter-budget.mjs";

const models = { primary: "big", fallback: "small", threshold: 0.8 };
const budget = (spentMicros, limitMicros = 10_000_000) => ({ configured: true, ledger: "durable_object", windowKey: "2026-10", limitMicros, spentMicros, remainingMicros: limitMicros - spentMicros });

test("below the threshold the primary model runs", () => {
  assert.deepEqual(chooseModel(budget(7_999_999), models), { model: "big", reason: "budget-ok" });
});

test("at the threshold the cheaper model runs", () => {
  assert.deepEqual(chooseModel(budget(8_000_000), models), { model: "small", reason: "budget-high" });
  assert.deepEqual(chooseModel(budget(12_000_000), models), { model: "small", reason: "budget-high" });
});

test("an unread or unmetered budget keeps the primary model", () => {
  assert.equal(chooseModel(null, models).reason, "budget-unknown");
  assert.equal(chooseModel({ configured: false, limitMicros: null, spentMicros: null }, models).model, "big");
  assert.equal(chooseModel({ configured: true, ledger: "unavailable", limitMicros: 5, spentMicros: null }, models).model, "big");
});

test("a zero budget picks the cheaper model and says it is blocked", () => {
  assert.deepEqual(chooseModel(budget(0, 0), models), { model: "small", reason: "budget-blocked" });
});

test("no fallback keeps the primary model", () => {
  assert.equal(chooseModel(budget(9_000_000), { primary: "big" }).model, "big");
});

test("the summary shows spend, budget, share and model, and never a key", () => {
  const text = chooseSummary({ label: "Docs Agent", budget: budget(2_500_000), choice: { model: "big", reason: "budget-ok" }, threshold: 0.8 });
  assert.match(text, /\$2\.50/);
  assert.match(text, /\$10\.00/);
  assert.match(text, /25%/);
  assert.match(text, /`big`/);
  const after = reportSummary({ label: "Docs Agent", before: 2_500_000, after: budget(2_750_000) });
  assert.match(after, /this run \| \$0\.25/);
});

test("readBudget sends the key as a bearer token and returns null on failure", async () => {
  let seen;
  const ok = async (url, init) => {
    seen = { url: String(url), auth: init.headers.authorization };
    return new Response(JSON.stringify({ budget: budget(1) }), { status: 200 });
  };
  assert.equal((await readBudget({ url: "https://router.test", key: "k", fetchImpl: ok })).spentMicros, 1);
  assert.deepEqual(seen, { url: "https://router.test/v1/usage", auth: "Bearer k" });
  assert.equal(await readBudget({ url: "https://router.test", key: "k", fetchImpl: async () => new Response("no", { status: 401 }) }), null);
  assert.equal(await readBudget({ url: "https://router.test", key: "k", fetchImpl: async () => { throw new Error("down"); } }), null);
  assert.equal(await readBudget({ url: "", key: "k" }), null);
});
