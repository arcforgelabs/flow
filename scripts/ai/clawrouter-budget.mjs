#!/usr/bin/env node
// ClawRouter budget check for Flow's AI workflows (docs/AI_BOTS.md).
//
// `choose` reads the key's monthly budget from ClawRouter's /v1/usage and
// picks the model: the primary model, or the cheaper fallback once the spent
// share reaches the threshold. `report` reads the budget again after the run
// and writes what the run cost. Both write a table to the job summary.
//
// Environment: CLAWROUTER_URL (https origin), CLAWROUTER_KEY (the policy key).
// The key is never printed. A failed read keeps the primary model and says so.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_THRESHOLD = 0.8;

// budget: the `budget` object of GET /v1/usage, or null when unread.
export function chooseModel(budget, { primary, fallback, threshold = DEFAULT_THRESHOLD }) {
  if (!primary) throw new Error("a primary model is required");
  const limit = budget?.limitMicros;
  const spent = budget?.spentMicros;
  if (!budget || budget.configured !== true || !Number.isFinite(limit) || !Number.isFinite(spent)) {
    return { model: primary, reason: "budget-unknown" };
  }
  if (limit <= 0) return { model: fallback || primary, reason: "budget-blocked" };
  if (fallback && spent / limit >= threshold) return { model: fallback, reason: "budget-high" };
  return { model: primary, reason: "budget-ok" };
}

export function dollars(micros) {
  return Number.isFinite(micros) ? `$${(micros / 1_000_000).toFixed(2)}` : "unknown";
}

const REASONS = {
  "budget-ok": "Budget below the threshold: primary model",
  "budget-high": "Budget at or above the threshold: cheaper model",
  "budget-blocked": "Budget is zero: ClawRouter refuses calls",
  "budget-unknown": "Budget could not be read: primary model",
};

export function chooseSummary({ label, budget, choice, threshold }) {
  const share = Number.isFinite(budget?.limitMicros) && budget.limitMicros > 0 && Number.isFinite(budget?.spentMicros)
    ? `${Math.round((budget.spentMicros / budget.limitMicros) * 100)}%`
    : "unknown";
  return [
    `### ${label}: AI cost`,
    "",
    "| Item | Value |",
    "| --- | --- |",
    `| Month (UTC) | ${budget?.windowKey ?? "unknown"} |`,
    `| Spent this month | ${dollars(budget?.spentMicros)} |`,
    `| Monthly budget | ${dollars(budget?.limitMicros)} |`,
    `| Used | ${share} (cheaper model from ${Math.round(threshold * 100)}%) |`,
    `| Model | \`${choice.model}\` |`,
    `| Why | ${REASONS[choice.reason]} |`,
    "",
  ].join("\n");
}

export function reportSummary({ label, before, after }) {
  const cost = Number.isFinite(before) && Number.isFinite(after?.spentMicros) ? after.spentMicros - before : NaN;
  return [
    `| ${label}: this run | ${dollars(cost)} |`,
    `| ${label}: spent after the run | ${dollars(after?.spentMicros)} |`,
    `| ${label}: remaining | ${dollars(after?.remainingMicros)} |`,
    "",
  ].join("\n");
}

export async function readBudget({ url, key, fetchImpl = fetch }) {
  if (!url || !key) return null;
  try {
    const response = await fetchImpl(new URL("/v1/usage", url), {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body.budget === "object" ? body.budget : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = { command: argv[0] };
  for (let i = 1; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

function write(file, text) {
  if (file) appendFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const label = args.label || "AI";
  const budget = await readBudget({ url: process.env.CLAWROUTER_URL, key: process.env.CLAWROUTER_KEY });
  if (args.command === "choose") {
    const threshold = Number.parseFloat(args.threshold || "") || DEFAULT_THRESHOLD;
    const choice = chooseModel(budget, { primary: args.primary, fallback: args.fallback, threshold });
    write(process.env.GITHUB_OUTPUT, `model=${choice.model}\nreason=${choice.reason}\nspent_micros=${budget?.spentMicros ?? ""}`);
    write(process.env.GITHUB_STEP_SUMMARY, chooseSummary({ label, budget, choice, threshold }));
    if (choice.reason === "budget-unknown") console.log("::warning::ClawRouter budget could not be read; using the primary model.");
    console.log(`${label}: model ${choice.model} (${choice.reason}).`);
  } else if (args.command === "report") {
    const before = args.before === undefined || args.before === "" ? NaN : Number(args.before);
    write(process.env.GITHUB_STEP_SUMMARY, reportSummary({ label, before, after: budget }));
    console.log(`${label}: spent ${dollars(budget?.spentMicros)} of ${dollars(budget?.limitMicros)} this month.`);
  } else {
    throw new Error("usage: clawrouter-budget.mjs choose|report [--label L] [--primary M --fallback M --threshold 0.8] [--before micros]");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
