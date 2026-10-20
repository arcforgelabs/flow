// The low-risk merge lane (docs/LOW_RISK_MERGE.md): which pull requests merge
// themselves, and that the workflow never runs pull request code.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ARMED_LABEL,
  MERGE_RISK_LABELS,
  checksState,
  classify,
  run,
  isDocsAgentPull,
  sizeLabel,
} from "../scripts/github/low-risk-merge.mjs";

const file = (filename, lines = 10) => ({ filename, additions: lines, deletions: 0 });
const base = {
  title: "fix: invoice tabs switch at once",
  files: [file("server/ui/invoices.js"), file("test/invoice-list.test.js")],
  authorAssociation: "OWNER",
  baseRef: "main",
  defaultBranch: "main",
  sameRepo: true,
};
const risksOf = (overrides) => [...classify({ ...base, ...overrides }).risks.keys()];

test("a small fix with no risky files is low risk", () => {
  const decision = classify(base);
  assert.equal(decision.lowRisk, true);
  assert.deepEqual(decision.holds, []);
  assert.equal(decision.size, "size: XS");
});

test("improve, docs and test titles are in the lane; feat, refactor and chore are not", () => {
  for (const title of ["improve: quieter alerts", "docs: Xero setup", "test: pager", "fix(ui): tabs"]) {
    assert.equal(classify({ ...base, title }).lowRisk, true, title);
  }
  for (const title of ["feat: a new page", "refactor: split", "chore: bump", "Fix tabs"]) {
    assert.equal(classify({ ...base, title }).lowRisk, false, title);
  }
  assert.match(classify({ ...base, title: "feat: a new page" }).holds[0], /new feature/);
});

test("each Flow surface carries ClawSweeper's merge-risk label", () => {
  const cases = [
    ["server/db/migrations/0012_jobs.sql", MERGE_RISK_LABELS.compatibility.name],
    ["server/integrations/xero/migrations/0003.sql", MERGE_RISK_LABELS.compatibility.name],
    ["server/db/schema.js", MERGE_RISK_LABELS.compatibility.name],
    ["package-lock.json", MERGE_RISK_LABELS.compatibility.name],
    ["server/integrations/xero/drafts.js", MERGE_RISK_LABELS.messageDelivery.name],
    ["server/integrations/seazona/act.js", MERGE_RISK_LABELS.messageDelivery.name],
    ["server/core/sending.js", MERGE_RISK_LABELS.messageDelivery.name],
    ["server/auth/session.js", MERGE_RISK_LABELS.authProvider.name],
    ["server/integrations/xero/oauth.js", MERGE_RISK_LABELS.authProvider.name],
    ["server/core/secrets.js", MERGE_RISK_LABELS.securityBoundary.name],
    ["server/integrations/call-guard.js", MERGE_RISK_LABELS.availability.name],
    [".github/workflows/ci.yml", MERGE_RISK_LABELS.automation.name],
    ["scripts/github/low-risk-merge.mjs", MERGE_RISK_LABELS.automation.name],
    ["CHANGELOG/2026.10.33.md", MERGE_RISK_LABELS.automation.name],
    ["VISION.md", MERGE_RISK_LABELS.other.name],
  ];
  for (const [filename, label] of cases) {
    const risks = risksOf({ files: [file(filename)] });
    assert.ok(risks.includes(label), `${filename} -> ${label}, got ${risks}`);
    assert.equal(classify({ ...base, files: [file(filename)] }).lowRisk, false, filename);
  }
});

test("tests and pages carry no risk, even next to an integration", () => {
  assert.deepEqual(risksOf({ files: [file("test/seazona-sync.test.js"), file("server/ui/board.js"), file("docs/XERO.md")] }), []);
});

test("forks, outside authors, other bases and large changes are held", () => {
  assert.equal(classify({ ...base, sameRepo: false }).lowRisk, false);
  assert.equal(classify({ ...base, authorAssociation: "CONTRIBUTOR" }).lowRisk, false);
  assert.equal(classify({ ...base, baseRef: "release" }).lowRisk, false);
  assert.equal(classify({ ...base, files: [file("server/ui/board.js", 500)] }).lowRisk, false);
  assert.equal(classify({ ...base, files: [file("server/ui/board.js", 499)] }).lowRisk, true);
});

test("a merge-risk label from ClawSweeper or a person holds the pull request", () => {
  const decision = classify({ ...base, labels: ["merge-risk: 🚨 other"] });
  assert.equal(decision.lowRisk, false);
  assert.match(decision.holds[0], /added by a reviewer/);
});

test("size follows Barnacle's labeler buckets and skips docs and lockfiles", () => {
  assert.equal(sizeLabel([file("a.js", 49)]), "size: XS");
  assert.equal(sizeLabel([file("a.js", 50)]), "size: S");
  assert.equal(sizeLabel([file("a.js", 200)]), "size: M");
  assert.equal(sizeLabel([file("a.js", 999)]), "size: L");
  assert.equal(sizeLabel([file("a.js", 1000)]), "size: XL");
  assert.equal(sizeLabel([file("docs/A.md", 5000), file("package-lock.json", 5000)]), "size: XS");
});

test("checks are green only when all are done, none failed, and test and gitleaks passed", () => {
  const done = (name, conclusion = "success") => ({ name, status: "completed", conclusion });
  assert.equal(checksState([done("test"), done("gitleaks"), done("package")]).green, true);
  assert.equal(checksState([done("test"), done("gitleaks"), { name: "docker-build", status: "in_progress" }]).green, false);
  assert.equal(checksState([done("test"), done("gitleaks"), done("package", "failure")]).green, false);
  assert.deepEqual(checksState([done("test")]).missing, ["gitleaks"]);
  assert.equal(checksState([done("test"), done("gitleaks"), done("lane", "failure")], ["lane"]).green, true);
});

function fakeGitHub({ pr, files, checkRuns, labels = [] }) {
  const calls = [];
  const record = (name) => async (args) => {
    calls.push([name, args]);
    return { data: {} };
  };
  const lists = new Map();
  const github = {
    calls,
    rest: {
      pulls: {
        get: async () => ({ data: { ...pr, labels: labels.map((name) => ({ name })) } }),
        listFiles: "listFiles",
        merge: record("merge"),
      },
      issues: {
        getLabel: async () => ({ data: {} }),
        createLabel: record("createLabel"),
        addLabels: record("addLabels"),
        removeLabel: record("removeLabel"),
        listComments: "listComments",
        createComment: record("createComment"),
        updateComment: record("updateComment"),
      },
      checks: { listForRef: "listForRef" },
    },
    paginate: async (method) => lists.get(method),
  };
  lists.set("listFiles", files);
  lists.set("listComments", []);
  lists.set("listForRef", checkRuns);
  return github;
}

const core = { notice() {}, warning() {}, summary: { addRaw() {}, async write() {} } };
const openPr = {
  number: 7,
  state: "open",
  draft: false,
  mergeable: true,
  title: "fix: tabs",
  author_association: "OWNER",
  base: { ref: "main", repo: { full_name: "arcforgelabs/flow" } },
  head: { sha: "abc1234def", repo: { full_name: "arcforgelabs/flow" } },
};
const context = { repo: { owner: "arcforgelabs", repo: "flow" }, payload: { pull_request: { number: 7 }, repository: { default_branch: "main" } } };
const green = [
  { name: "test", status: "completed", conclusion: "success" },
  { name: "gitleaks", status: "completed", conclusion: "success" },
];

test("run arms and merges a low-risk pull request at its exact head", async () => {
  const github = fakeGitHub({ pr: openPr, files: [file("server/ui/a.js")], checkRuns: green });
  await run({ github, context, core });
  const merge = github.calls.find(([name]) => name === "merge");
  assert.deepEqual(merge[1], { owner: "arcforgelabs", repo: "flow", pull_number: 7, sha: "abc1234def", merge_method: "squash" });
  assert.deepEqual(github.calls.find(([name]) => name === "addLabels")[1].labels, [ARMED_LABEL]);
});

test("run does not merge a draft, a held pull request, pending checks, or when switched off", async () => {
  const cases = [
    { pr: { ...openPr, draft: true } },
    { pr: { ...openPr, title: "feat: a page" } },
    { checkRuns: [green[0]] },
    { options: { mergeEnabled: false } },
  ];
  for (const { pr = openPr, checkRuns = green, options = {} } of cases) {
    const github = fakeGitHub({ pr, files: [file("server/ui/a.js")], checkRuns });
    await run({ github, context, core, ...options });
    assert.equal(github.calls.some(([name]) => name === "merge"), false, JSON.stringify({ pr: pr.title, options }));
  }
});

test("run labels the risk and takes the lane label off a held pull request", async () => {
  const github = fakeGitHub({ pr: openPr, files: [file("server/integrations/xero/drafts.js")], checkRuns: green, labels: [ARMED_LABEL] });
  await run({ github, context, core });
  assert.deepEqual(github.calls.find(([name]) => name === "addLabels")[1].labels, [MERGE_RISK_LABELS.messageDelivery.name]);
  assert.equal(github.calls.find(([name]) => name === "removeLabel")[1].name, ARMED_LABEL);
  assert.equal(github.calls.some(([name]) => name === "merge"), false);
});

test("the workflow runs only trusted default-branch code", () => {
  const workflow = readFileSync(resolve(import.meta.dirname, "../.github/workflows/low-risk-merge.yml"), "utf8");
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head/);
  assert.doesNotMatch(workflow, /workflow_run\.head_sha/);
  assert.match(workflow, /persist-credentials: false/);
});

test("the Docs Agent's docs-only pull requests count as a maintainer's", () => {
  const docs = { ...base, title: "docs: refresh documentation", authorAssociation: "NONE", headRef: "docs-agent/refresh", authorIsBot: true, files: [file("docs/XERO.md"), file("README.md")] };
  assert.equal(classify(docs).lowRisk, true);
  assert.equal(classify({ ...docs, authorIsBot: false }).lowRisk, false);
  assert.equal(classify({ ...docs, headRef: "other" }).lowRisk, false);
  assert.equal(classify({ ...docs, sameRepo: false }).lowRisk, false);
  assert.equal(classify({ ...docs, files: [file("docs/XERO.md"), file("server/ui/board.js")] }).lowRisk, false);
  assert.equal(isDocsAgentPull({ ...docs, files: [] }), false);
});
