// The low-risk merge lane: a pull request that is a small fix, with no merge
// risk, merges itself once its checks are green. Everything else waits for a
// maintainer (docs/LOW_RISK_MERGE.md).
//
// The risk words are ClawSweeper's own `merge-risk:` labels and its
// `status: 🚀 automerge armed` lane label (openclaw/clawsweeper
// src/clawsweeper-policy.ts), and the size words are Barnacle's labeler size
// buckets (openclaw/openclaw .github/workflows/labeler.yml). This file only
// maps Flow's paths to them. A merge-risk label that ClawSweeper or a person
// adds holds the pull request the same way: the lane never removes one.
//
// Workflows run it from the base branch through actions/github-script. It
// reads the pull request through the API and never checks out its code.

export const ARMED_LABEL = "status: 🚀 automerge armed";
export const ARMED_LABEL_SPEC = {
  color: "0E8A16",
  description: "This PR is in ClawSweeper's automerge lane.",
};

export const MERGE_RISK_LABELS = {
  compatibility: {
    name: "merge-risk: 🚨 compatibility",
    color: "D1242F",
    description:
      "🚨 Merging this PR could break existing users, config, migrations, defaults, or upgrades.",
  },
  messageDelivery: {
    name: "merge-risk: 🚨 message-delivery",
    color: "D1242F",
    description:
      "🚨 Merging this PR could drop, duplicate, misroute, suppress, or wrongly target messages.",
  },
  sessionState: {
    name: "merge-risk: 🚨 session-state",
    color: "F97316",
    description:
      "🚨 Merging this PR could lose, corrupt, stale, or mis-associate session or agent state.",
  },
  authProvider: {
    name: "merge-risk: 🚨 auth-provider",
    color: "F97316",
    description:
      "🚨 Merging this PR could break OAuth, tokens, provider routing, model choice, or credentials.",
  },
  securityBoundary: {
    name: "merge-risk: 🚨 security-boundary",
    color: "B60205",
    description:
      "🚨 Merging this PR could weaken sandboxing, authorization, credentials, or sensitive data.",
  },
  availability: {
    name: "merge-risk: 🚨 availability",
    color: "D93F0B",
    description:
      "🚨 Merging this PR could cause crashes, hangs, restart loops, stalls, or process outages.",
  },
  automation: {
    name: "merge-risk: 🚨 automation",
    color: "FBCA04",
    description:
      "🚨 Merging this PR could break CI, automerge, proof capture, label sync, or automation.",
  },
  other: {
    name: "merge-risk: 🚨 other",
    color: "C5DEF5",
    description: "🚨 Merging this PR has meaningful risk outside the owned taxonomy.",
  },
};
const MERGE_RISK_PREFIX = "merge-risk:";

// Flow's surfaces for each risk. Every rule a file matches adds its label.
// Tests never carry risk.
const PATH_RISKS = [
  // Schema, migrations and anything that changes an install or an upgrade.
  {
    risk: "compatibility",
    why: "database schema or migration",
    test: (f) =>
      /(^|\/)migrations\//.test(f) ||
      /^server\/db\//.test(f) ||
      /^server\/integrations\/([^/]+\/)?(schema|tables|remove-tables)\.js$/.test(f) ||
      /(^|\/)drizzle\.config\.js$/.test(f) ||
      /^scripts\/db-guard-migrations\.js$/.test(f) ||
      /^server\/import/.test(f) ||
      /^server\/integrations\/seazona\/history\//.test(f),
  },
  {
    risk: "compatibility",
    why: "dependencies, packaging or deploy",
    test: (f) =>
      /^(package\.json|package-lock\.json|\.npmrc|Dockerfile|\.dockerignore|\.replit|replit\.md)$/.test(f) ||
      /^deploy\//.test(f) ||
      /^scripts\/(replit-|deploy-)/.test(f) ||
      /^server\/(release-channel|update-check|deployed-build)\.js$/.test(f) ||
      /^docs\/(REPLIT|SELF_HOSTING)\.md$/.test(f),
  },
  // Flow's writes to Xero and Seazona: the records Flow sends out.
  {
    risk: "messageDelivery",
    why: "how Flow writes to Xero or Seazona",
    test: (f) =>
      /^server\/integrations\/(xero|seazona)\//.test(f) ||
      /^server\/integrations\/(adapters|port|setup|index)\.js$/.test(f) ||
      /^server\/core\/(sending|outbox|queue|pipeline|read-before-act|ledger|links)\.js$/.test(f),
  },
  {
    risk: "availability",
    why: "call guards, rate limits or the server start",
    test: (f) =>
      /^server\/integrations\/(call-guard|health)\.js$/.test(f) ||
      /^server\/rate-limit\.js$/.test(f) ||
      /^server\/(index|app|flow-server)\.js$/.test(f),
  },
  {
    risk: "authProvider",
    why: "sign-in or the Xero connection",
    test: (f) =>
      /^server\/auth\//.test(f) ||
      /^server\/integrations\/xero\/(oauth|connections|webhooks)\.js$/.test(f),
  },
  {
    risk: "securityBoundary",
    why: "secrets or the security policy",
    test: (f) =>
      /^server\/core\/secrets\.js$/.test(f) ||
      /^SECURITY\.md$/.test(f) ||
      /(^|\/)\.gitleaks/.test(f),
  },
  // Barnacle's `triage: risky-infra` surface: CI, release and agent plumbing.
  {
    risk: "automation",
    why: "CI, release or agent automation",
    test: (f) =>
      /^\.github\//.test(f) ||
      /^\.(agents|claude)\//.test(f) ||
      /^scripts\/(release|github)\//.test(f) ||
      /^scripts\/github-sync\.sh$/.test(f) ||
      /^CHANGELOG(\.md$|\/)/.test(f) ||
      /^(AGENTS|CLAUDE)\.md$/.test(f),
  },
  {
    risk: "other",
    why: "the product vision or the licence",
    test: (f) => /^(VISION\.md|LICENSE)$/.test(f),
  },
];

const isTestFile = (f) => /^test\//.test(f) || /\.test\.[cm]?js$/.test(f);

// Barnacle's labeler size buckets, counted the way it counts them.
const SIZE_EXCLUDED = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]);
export function sizeLabel(files) {
  const lines = files.reduce((total, file) => {
    const path = file.filename ?? "";
    if (path.startsWith("docs/") || SIZE_EXCLUDED.has(path)) return total;
    return total + (file.additions ?? 0) + (file.deletions ?? 0);
  }, 0);
  if (lines < 50) return "size: XS";
  if (lines < 200) return "size: S";
  if (lines < 500) return "size: M";
  if (lines < 1000) return "size: L";
  return "size: XL";
}
const SMALL_SIZES = new Set(["size: XS", "size: S", "size: M"]);

// Title types from .github/pull_request_template.md. feat is a new feature;
// refactor and chore are not fixes. test has no type there but is used.
const LOW_RISK_TYPES = new Set(["fix", "improve", "docs", "test"]);
const TRUSTED_AUTHORS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// The Docs Agent (.github/workflows/docs-agent.yml) opens its pull requests
// as a bot from this branch; they count as a maintainer's when they touch
// only the paths the agent may change (docs/AI_BOTS.md).
export const DOCS_AGENT_BRANCH = "docs-agent/refresh";
const isDocsPath = (filename) => filename.startsWith("docs/") || filename === "README.md";
export function isDocsAgentPull({ headRef, authorIsBot, sameRepo, files }) {
  return Boolean(authorIsBot && sameRepo && headRef === DOCS_AGENT_BRANCH && files.length && files.every((f) => isDocsPath(f.filename)));
}

export function titleType(title) {
  return /^([a-z]+)(\([^)]*\))?!?:/.exec(title ?? "")?.[1] ?? null;
}

// What the lane decides for one pull request. `risks` are the merge-risk
// labels its files carry; `holds` say why it is not in the lane.
export function classify({ title, files, labels = [], authorAssociation, baseRef, defaultBranch, sameRepo, headRef, authorIsBot = false }) {
  const risks = new Map();
  for (const { filename } of files) {
    if (isTestFile(filename)) continue;
    for (const rule of PATH_RISKS) {
      if (!rule.test(filename)) continue;
      const name = MERGE_RISK_LABELS[rule.risk].name;
      if (!risks.has(name)) risks.set(name, { why: rule.why, files: [] });
      risks.get(name).files.push(filename);
    }
  }

  const size = sizeLabel(files);
  const type = titleType(title);
  const holds = [];
  if (!sameRepo) holds.push("it comes from a fork");
  const trusted = TRUSTED_AUTHORS.has(authorAssociation) || isDocsAgentPull({ headRef, authorIsBot, sameRepo, files });
  if (!trusted) holds.push("its author is not a maintainer");
  if (baseRef !== defaultBranch) holds.push(`its base is ${baseRef}, not ${defaultBranch}`);
  if (!LOW_RISK_TYPES.has(type)) {
    holds.push(
      type === "feat"
        ? "it is a new feature (feat)"
        : `its title type is ${type ? `\`${type}\`` : "missing"}; the lane takes fix, improve, docs and test`,
    );
  }
  if (!SMALL_SIZES.has(size)) holds.push(`it is ${size}; the lane takes XS, S and M`);
  for (const [name, { why }] of risks) holds.push(`${name} (${why})`);
  for (const label of labels) {
    if (label.startsWith(MERGE_RISK_PREFIX) && !risks.has(label)) holds.push(`${label} (added by a reviewer)`);
  }

  return { lowRisk: holds.length === 0, risks, size, type, holds };
}

// Whether every check on the head commit is done and none failed, and the
// required ones (.github/rulesets/main.json) are there.
export const REQUIRED_CHECKS = ["test", "gitleaks"];
const PASSING = new Set(["success", "neutral", "skipped"]);
export function checksState(checkRuns, ignore = []) {
  const runs = checkRuns.filter((run) => !ignore.includes(run.name));
  const pending = runs.filter((run) => run.status !== "completed").map((run) => run.name);
  const failed = runs
    .filter((run) => run.status === "completed" && !PASSING.has(run.conclusion))
    .map((run) => run.name);
  const missing = REQUIRED_CHECKS.filter(
    (name) => !runs.some((run) => run.name === name && run.status === "completed" && run.conclusion === "success"),
  );
  return { green: pending.length === 0 && failed.length === 0 && missing.length === 0, pending, failed, missing };
}

const COMMENT_MARKER = "<!-- flow-low-risk-merge -->";

function commentBody(pr, decision, checks, outcome) {
  const lines = [COMMENT_MARKER, "### Low-risk merge lane", ""];
  if (decision.lowRisk) {
    lines.push(`**Armed** (\`${ARMED_LABEL}\`): ${decision.type}, ${decision.size}, no merge risk.`);
    lines.push("", outcome);
  } else {
    lines.push("**Held for a maintainer.** This PR is not in the lane because:", "");
    for (const hold of decision.holds) lines.push(`- ${hold}`);
  }
  if (decision.risks.size) {
    lines.push("", "<details><summary>Files behind each merge risk</summary>", "");
    for (const [name, { files }] of decision.risks) {
      lines.push(`- ${name}: ${files.map((f) => `\`${f}\``).join(", ")}`);
    }
    lines.push("", "</details>");
  }
  if (decision.lowRisk && !checks.green) {
    const waits = [
      ...checks.pending.map((n) => `${n} running`),
      ...checks.failed.map((n) => `${n} failed`),
      ...checks.missing.filter((n) => !checks.pending.includes(n) && !checks.failed.includes(n)).map((n) => `${n} not reported`),
    ];
    if (waits.length) lines.push("", `Checks: ${waits.join(", ")}.`);
  }
  lines.push("", `Head: ${pr.head.sha.slice(0, 7)}. Rules: \`docs/LOW_RISK_MERGE.md\`.`);
  return lines.join("\n");
}

async function ensureLabel(github, repo, { name, color, description }) {
  try {
    await github.rest.issues.getLabel({ ...repo, name });
  } catch (error) {
    if (error?.status !== 404) throw error;
    await github.rest.issues.createLabel({ ...repo, name, color, description });
  }
}

async function upsertComment(github, repo, number, body) {
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: number, per_page: 100 });
  const existing = comments.find((c) => c.body?.startsWith(COMMENT_MARKER));
  if (existing) {
    if (existing.body !== body) await github.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ ...repo, issue_number: number, body });
  }
}

// The pull request numbers an event is about.
export function pullNumbers(context) {
  const { payload } = context;
  if (payload.pull_request) return [payload.pull_request.number];
  if (payload.workflow_run) return (payload.workflow_run.pull_requests ?? []).map((pr) => pr.number);
  if (payload.inputs?.pr) return [Number(payload.inputs.pr)];
  return [];
}

// `merger` merges; labels and the comment use `github`. A merge made with the
// workflow's own token starts no workflow on main, so the workflow passes an
// App token here when it has one.
export async function run({ github, merger = github, context, core, mergeEnabled = true, ignoreChecks = [] }) {
  const repo = context.repo;
  const defaultBranch = context.payload.repository?.default_branch ?? "main";
  for (const number of pullNumbers(context)) {
    const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: number });
    if (pr.state !== "open") continue;

    const files = await github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: number, per_page: 100 });
    const labels = pr.labels.map((l) => l.name);
    const decision = classify({
      title: pr.title,
      files,
      labels,
      authorAssociation: pr.author_association,
      baseRef: pr.base.ref,
      defaultBranch,
      sameRepo: pr.head.repo?.full_name === pr.base.repo.full_name,
      headRef: pr.head.ref,
      authorIsBot: pr.user?.type === "Bot",
    });

    // Labels: add the merge risks found; the lane label follows the decision.
    const add = [...decision.risks.keys()].filter((name) => !labels.includes(name));
    for (const name of add) {
      const spec = Object.values(MERGE_RISK_LABELS).find((l) => l.name === name);
      await ensureLabel(github, repo, spec);
    }
    if (decision.lowRisk && !labels.includes(ARMED_LABEL)) {
      await ensureLabel(github, repo, { name: ARMED_LABEL, ...ARMED_LABEL_SPEC });
      add.push(ARMED_LABEL);
    }
    if (add.length) await github.rest.issues.addLabels({ ...repo, issue_number: number, labels: add });
    if (!decision.lowRisk && labels.includes(ARMED_LABEL)) {
      await github.rest.issues.removeLabel({ ...repo, issue_number: number, name: ARMED_LABEL });
    }

    const checkRuns = await github.paginate(github.rest.checks.listForRef, { ...repo, ref: pr.head.sha, per_page: 100 });
    const checks = checksState(checkRuns, ignoreChecks);

    let outcome = "It merges itself (squash) when every check on its head is green.";
    if (decision.lowRisk && !mergeEnabled) {
      outcome = "Merging is switched off (repository variable `FLOW_LOW_RISK_MERGE` is `off`); a maintainer merges it.";
    } else if (decision.lowRisk && pr.draft) {
      outcome = "It is a draft. It merges itself when it is ready for review and its checks are green.";
    } else if (decision.lowRisk && checks.green) {
      if (pr.mergeable === false) {
        outcome = "It has a merge conflict with the base branch; it merges when that is resolved.";
      } else {
        try {
          // sha: GitHub refuses the merge if the head moved after this read.
          await merger.rest.pulls.merge({ ...repo, pull_number: number, sha: pr.head.sha, merge_method: "squash" });
          outcome = `Merged ${pr.head.sha.slice(0, 7)} (squash): low risk and every check green.`;
          core.notice(`Merged #${number}: low risk and every check green.`);
        } catch (error) {
          outcome = `GitHub did not merge it yet: ${error.message}`;
          core.warning(`#${number}: ${error.message}`);
        }
      }
    }

    await upsertComment(github, repo, number, commentBody(pr, decision, checks, outcome));
    core.summary.addRaw(`#${number}: ${decision.lowRisk ? "low risk" : "held"}. ${decision.holds.join("; ")}\n`);
  }
  await core.summary.write();
}
