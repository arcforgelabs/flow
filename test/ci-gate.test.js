// The CI gate (.github/workflows/ci.yml, `flow/ci-gate`) is the one CI check
// the main ruleset requires. These tests hold the two ways it could let a
// failure through: a lane the gate does not wait for, and a changed path that
// turns no lane on.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const SCOPE = join(ROOT, ".github/scripts/ci-scope.py");

function jobs() {
  const body = CI.slice(CI.indexOf("\njobs:\n"));
  return [...body.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]);
}

function scopes() {
  const m = CI.match(/SCOPES: >-\n((?: {12}.*\n)+)/);
  return JSON.parse(m[1].replace(/\n/g, " "));
}

function gateNeeds() {
  const m = CI.match(/\n {2}ci-gate:\n(?: {4}.*\n)*? {4}needs: \[([^\]]+)\]/);
  return m[1].split(",").map((s) => s.trim());
}

test("the gate waits for every other job in ci.yml", () => {
  const all = jobs();
  assert.ok(all.includes("ci-gate"));
  assert.deepEqual(gateNeeds().sort(), all.filter((j) => j !== "ci-gate").sort());
  assert.match(CI, /\n {2}ci-gate:\n {4}name: flow\/ci-gate\n/);
});

test("every lane runs only when preflight turns it on", () => {
  const lanes = Object.keys(scopes()).map((l) => (l === "app" ? ["test", "docker-build", "package"] : [l])).flat();
  assert.deepEqual(lanes.sort(), jobs().filter((j) => j !== "ci-gate" && j !== "preflight").sort());
  for (const lane of lanes) {
    const key = ["test", "docker-build", "package"].includes(lane) ? "app" : lane.replace(/-/g, "_");
    assert.match(CI, new RegExp(`\\n {2}${lane}:\\n(?: {4}.*\\n)*? {4}if: needs\\.preflight\\.outputs\\.${key} == 'true'\\n`), lane);
  }
});

function select(files, env = {}, between = []) {
  const dir = mkdtempSync(join(tmpdir(), "flow-ci-scope-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" }).trim();
    git("init", "-q");
    writeFileSync(join(dir, "seed"), "x");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    for (const file of between) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), "y");
    }
    if (between.length) {
      git("add", "-A");
      git("commit", "-qm", "branch");
    }
    for (const file of files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), "x");
    }
    git("add", "-A");
    git("commit", "-qm", "head", "--allow-empty");
    const head = git("rev-parse", "HEAD");
    const out = execFileSync("python3", ["-I", SCOPE], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, EVENT: "pull_request", BASE: base, HEAD: head, SWITCH: "on", SCOPES: JSON.stringify(scopes()), ...env },
    });
    return Object.fromEntries(out.trim().split("\n").map((l) => l.split("=")).map(([k, v]) => [k, v === "true"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a code change runs the app lanes", () => {
  assert.deepEqual(select(["server/index.js"]), { app: true, check_docs: false });
  assert.deepEqual(select(["package.json"]), { app: true, check_docs: false });
  assert.deepEqual(select(["CHANGELOG/2026.11.4.md"]), { app: true, check_docs: false });
  assert.deepEqual(select(["skills/flow/SKILL.md"]), { app: true, check_docs: false });
  assert.deepEqual(select(["design-system/components/Tip/README.md"]), { app: true, check_docs: false });
  assert.deepEqual(select([".github/workflows/mobile.yml"]), { app: true, check_docs: false });
  assert.deepEqual(select(["a-new-top-level-file.js"]), { app: true, check_docs: false });
});

test("a docs or agent-notes change skips the app lanes", () => {
  assert.deepEqual(select(["docs/XERO.md"]), { app: false, check_docs: true });
  assert.deepEqual(select(["AGENTS.md", ".agents/skills/flow-release/SKILL.md"]), { app: false, check_docs: false });
  assert.deepEqual(select(["docs/XERO.md", "server/index.js"]), { app: true, check_docs: true });
});

test("CI itself, an empty diff and every run that is not a pull request select every lane", () => {
  assert.deepEqual(select([".github/workflows/ci.yml"]), { app: true, check_docs: true });
  assert.deepEqual(select([".github/scripts/ci-scope.py"]), { app: true, check_docs: true });
  assert.deepEqual(select([]), { app: true, check_docs: true });
  assert.deepEqual(select(["docs/XERO.md"], { EVENT: "push" }), { app: true, check_docs: true });
  assert.deepEqual(select(["docs/XERO.md"], { REF: "abc123" }), { app: true, check_docs: true });
});

test("while the switch is off, every pull request runs every lane", () => {
  assert.deepEqual(select(["docs/XERO.md"], { SWITCH: "" }), { app: true, check_docs: true });
  assert.deepEqual(select(["docs/XERO.md"], { SWITCH: "off" }), { app: true, check_docs: true });
});

test("lanes come from the diff against main, so a stacked pull request retargeted to main cannot skip a lane", () => {
  // Main, then a branch with a code change, then a docs-only pull request on that branch.
  assert.deepEqual(select(["docs/XERO.md"], {}, ["server/index.js"]), { app: true, check_docs: true });
});

test("npm test imports test/mobile files, so only the phone suite's saved images skip the app lanes", () => {
  assert.deepEqual(select(["test/mobile/server.js"]), { app: true, check_docs: false });
  assert.deepEqual(select(["test/mobile/screens.js"]), { app: true, check_docs: false });
  assert.deepEqual(select(["test/mobile/__screenshots__/phone.spec.js/jobs-dark.png"]), { app: false, check_docs: false });
});

function lanesMap() {
  return JSON.parse(CI.match(/LANES: '([^']+)'/)[1]);
}

test("the gate's lane map and preflight's outputs name every lane and scope", () => {
  const keys = Object.keys(scopes()).map((l) => l.replace(/-/g, "_"));
  assert.deepEqual(Object.keys(lanesMap()).sort(), gateNeeds().filter((j) => j !== "preflight").sort());
  assert.deepEqual([...new Set(Object.values(lanesMap()))].sort(), keys.sort());
  for (const key of keys) assert.match(CI, new RegExp(`\\n {6}${key}: \\$\\{\\{ steps\\.scope\\.outputs\\.${key} \\}\\}\\n`), key);
});

function gate(outputs, results, preflight = "success") {
  const code = CI.match(/python3 -I -c '\n([\s\S]*?)\n {10}'\n/)[1].replace(/^ {10}/gm, "");
  const needs = { preflight: { result: preflight, outputs } };
  for (const [lane, result] of Object.entries(results)) needs[lane] = { result, outputs: {} };
  try {
    execFileSync("python3", ["-I", "-c", code], { env: { PATH: process.env.PATH, NEEDS: JSON.stringify(needs), LANES: JSON.stringify(lanesMap()) }, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

test("the gate passes only when each selected lane passed and each other lane skipped", () => {
  const on = { app: "true", check_docs: "false" };
  const ok = { test: "success", "docker-build": "success", package: "success", "check-docs": "skipped" };
  assert.equal(gate(on, ok), true);
  assert.equal(gate(on, { ...ok, test: "failure" }), false);
  assert.equal(gate(on, { ...ok, test: "cancelled" }), false);
  assert.equal(gate(on, { ...ok, test: "skipped" }), false, "a selected lane that skipped");
  assert.equal(gate({ app: "false", check_docs: "true" }, { test: "skipped", "docker-build": "skipped", package: "skipped", "check-docs": "success" }), true);
  assert.equal(gate({ app: "true" }, ok), false, "a missing preflight output");
  assert.equal(gate({ app: "", check_docs: "false" }, ok), false, "an empty preflight output");
  assert.equal(gate(on, ok, "failure"), false);
  const { package: _, ...noPackage } = ok;
  assert.equal(gate(on, noPackage), false, "a lane the gate does not wait for");
});
