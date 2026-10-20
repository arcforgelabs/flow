#!/usr/bin/env node
// One command for a stable release, as openclaw/openclaw's `pnpm
// release:stable` (docs/RELEASING.md, Release a stable version):
//
//   npm run release:stable -- <YYYY.M.N> [options]
//
// It runs the release as one resumable state machine with these phases:
//
//   cut          picks the cut: the newest main commit that Flow Full Release
//                Validation proved (or --cut-sha). It refuses until the
//                operator confirms that exact commit (--confirm-cut-sha) and
//                names the branch that holds the version's changelog file
//                (--notes-ref). Then Flow Release Branch cuts release/<v>.
//   validate     waits for Flow Full Release Validation on the branch's head.
//   publish      needs --approve-publication. Flow Release Prepare tags the
//                head (signed) and starts Flow Release Publish, then Flow NPM
//                Release; done when npm serves <v>.
//   flip-github  requires the GitHub Release public and latest (Flow NPM
//                Release makes it so after npm is verified).
//   sync-beta    moves npm `beta` up to <v> when it is behind (Flow Release
//                Promote).
//   closeout     the closeout pull request (Flow Release Closeout) that
//                brings what shipped back to main: opens it if GitHub Actions
//                could not, waits for its checks, and merges it.
//
// State lives in .artifacts/release-<v>/state.json. Running the command again
// continues from the first phase not completed; --from <phase> starts again
// from that phase; --status prints the table; --dry-run prints each command
// instead of running it. Every refusal prints "Next:" with the commands to
// run before resuming. GitHub is reached through `gh api` (REST) only, since
// agent sessions cannot reach GitHub's GraphQL API, which `gh pr` uses.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateChecks } from "../deploy-checks.js";
import { parseBaseVersion } from "./release.mjs";

export const PHASES = ["cut", "validate", "publish", "flip-github", "sync-beta", "closeout"];
export const PACKAGE = "@arcforgelabs/flow";
const POLL_MS = 30_000;
// How long a phase waits for a run to start, and for one to finish.
const START_MS = 10 * 60_000;
const FINISH_MS = 120 * 60_000;

export class ReleaseRefusal extends Error {
  constructor(message, next = []) {
    super(message);
    this.next = next;
  }
}

const FLAGS = ["--dry-run", "--status", "--approve-publication", "--help"];
const VALUES = ["--from", "--repo", "--state-dir", "--cut-sha", "--confirm-cut-sha", "--notes-ref"];

function split(argv) {
  const flags = new Set();
  const values = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (FLAGS.includes(arg)) flags.add(arg);
    else if (VALUES.includes(arg)) {
      const found = argv[index + 1];
      if (found === undefined || found.startsWith("--")) throw new ReleaseRefusal(`${arg} needs a value`, ["npm run release:stable -- --help"]);
      values[arg] = found;
      index += 1;
    } else if (arg.startsWith("--")) throw new ReleaseRefusal(`Unknown option ${arg}`, ["npm run release:stable -- --help"]);
    else positionals.push(arg);
  }
  return { flags, values, positionals };
}

export function parseArgs(argv) {
  const { flags, values, positionals } = split(argv);
  if (flags.has("--help")) return null;
  if (positionals.length !== 1) throw new ReleaseRefusal("Expected one stable version (YYYY.M.N)", ["npm run release:stable -- <YYYY.M.N>"]);
  const version = positionals[0];
  try {
    parseBaseVersion(version);
  } catch (error) {
    throw new ReleaseRefusal(error.message, ["npm run release:stable -- <YYYY.M.N>"]);
  }
  const from = values["--from"];
  if (from !== undefined && !PHASES.includes(from)) throw new ReleaseRefusal(`Unknown phase ${from}; phases: ${PHASES.join(", ")}`, [`npm run release:stable -- ${version}`]);
  const options = {
    version,
    from,
    dryRun: flags.has("--dry-run"),
    status: flags.has("--status"),
    approvePublication: flags.has("--approve-publication"),
    repo: values["--repo"] ?? "arcforgelabs/flow",
    stateDir: values["--state-dir"] ?? `.artifacts/release-${version}`,
    cutSha: values["--cut-sha"],
    confirmCutSha: values["--confirm-cut-sha"],
    notesRef: values["--notes-ref"],
  };
  for (const key of ["cutSha", "confirmCutSha"]) {
    if (options[key] !== undefined && !/^[0-9a-f]{40}$/.test(options[key])) {
      throw new ReleaseRefusal(`--${key === "cutSha" ? "cut-sha" : "confirm-cut-sha"} needs a full lowercase commit hash`, [`npm run release:stable -- ${version}`]);
    }
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) throw new ReleaseRefusal("--repo must be owner/name", [`npm run release:stable -- ${version}`]);
  return options;
}

export const USAGE = `Usage: npm run release:stable -- <YYYY.M.N> [options]
  --cut-sha <sha>            Cut at this main commit instead of the newest validated one
  --confirm-cut-sha <sha>    Confirm the cut (required before the branch is cut)
  --notes-ref <branch>       The branch whose CHANGELOG/ holds the version's files
  --approve-publication      Approve tagging and publishing the release
  --from <${PHASES.join("|")}>
                             Start again from this phase
  --status                   Print the phases and what each recorded
  --dry-run                  Print each command instead of running it
  --repo <owner/name>        Default: arcforgelabs/flow
  --state-dir <directory>    Default: .artifacts/release-<version>`;

export function shellCommand(command, args) {
  return [command, ...args].map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`)).join(" ");
}

// Runs a command and returns its stdout; `allowFailure` returns null instead
// of throwing. A dry run prints the command and returns `dryValue`.
export function createRunner(dryRun, exec = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) {
  return (command, args, { allowFailure = false, dryValue = "", mutates = false } = {}) => {
    if (dryRun && mutates) {
      console.log(`[dry-run] ${shellCommand(command, args)}`);
      return dryValue;
    }
    try {
      return exec(command, args);
    } catch (error) {
      if (allowFailure) return null;
      const stderr = String(error.stderr ?? "").trim();
      throw new ReleaseRefusal(`${shellCommand(command, args)} failed${stderr ? `: ${stderr}` : ""}`);
    }
  };
}

export function emptyState(options) {
  return {
    schemaVersion: 1,
    version: options.version,
    repo: options.repo,
    branch: `release/${options.version}`,
    tag: `v${options.version}`,
    phases: Object.fromEntries(PHASES.map((phase) => [phase, { status: "pending" }])),
    cut: {},
    validate: {},
    publish: {},
    "flip-github": {},
    "sync-beta": {},
    closeout: {},
  };
}

export function loadState(options) {
  const file = join(options.stateDir, "state.json");
  if (!existsSync(file)) return emptyState(options);
  const state = JSON.parse(readFileSync(file, "utf8"));
  if (state.version !== options.version || state.repo !== options.repo) {
    throw new ReleaseRefusal(`${file} belongs to ${state.repo} ${state.version}`, [`npm run release:stable -- ${options.version} --state-dir ${options.stateDir}-${options.version}`]);
  }
  return state;
}

export function saveState(options, state) {
  if (options.dryRun) return;
  mkdirSync(options.stateDir, { recursive: true });
  writeFileSync(join(options.stateDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

export function resumeCommand(options, extra = []) {
  const args = ["npm", "run", "release:stable", "--", options.version];
  if (options.cutSha) args.push("--cut-sha", options.cutSha);
  if (options.notesRef) args.push("--notes-ref", options.notesRef);
  if (options.confirmCutSha) args.push("--confirm-cut-sha", options.confirmCutSha);
  if (options.approvePublication) args.push("--approve-publication");
  if (options.stateDir !== `.artifacts/release-${options.version}`) args.push("--state-dir", options.stateDir);
  return shellCommand(args[0], [...args.slice(1), ...extra]);
}

function json(ctx, args, options = {}) {
  const out = ctx.run("gh", args, options);
  if (out === null) return null;
  return out.trim() === "" ? null : JSON.parse(out);
}

function api(ctx, path, options) {
  return json(ctx, ["api", path], options);
}

const workflowRuns = (ctx, file, query) => api(ctx, `repos/${ctx.state.repo}/actions/workflows/${file}/runs?${query}`)?.workflow_runs ?? [];

// Starts a workflow from main and finds the run it started: the newest run of
// that workflow from main, by this login, created since the dispatch. Two
// candidates refuse instead of guessing, as OpenClaw's orchestrator does.
export function dispatch(ctx, file, fields) {
  const since = new Date(ctx.now() - 5_000).toISOString();
  const args = ["api", "-X", "POST", `repos/${ctx.state.repo}/actions/workflows/${file}/dispatches`, "-f", "ref=main"];
  for (const [key, field] of Object.entries(fields)) args.push("-f", `inputs[${key}]=${field}`);
  ctx.run("gh", args, { mutates: true });
  if (ctx.options.dryRun) return { id: 0, html_url: `(dry run of ${file})` };
  const login = api(ctx, "user").login;
  const deadline = ctx.now() + START_MS;
  for (;;) {
    const runs = workflowRuns(ctx, file, `branch=main&event=workflow_dispatch&created=${encodeURIComponent(`>=${since}`)}&per_page=20`).filter((run) => run.actor?.login === login);
    if (runs.length > 1) throw new ReleaseRefusal(`two ${file} runs started since ${since}; this command cannot tell which is its own`, runs.map((run) => run.html_url));
    if (runs.length === 1) return runs[0];
    if (ctx.now() > deadline) throw new ReleaseRefusal(`${file} did not start a run`, [ctx.resume()]);
    ctx.sleep(POLL_MS);
  }
}

export function waitForRun(ctx, run, what) {
  if (ctx.options.dryRun) return run;
  const deadline = ctx.now() + FINISH_MS;
  let current = run;
  while (current.status !== "completed") {
    if (ctx.now() > deadline) throw new ReleaseRefusal(`${what} is still running: ${current.html_url}`, [ctx.resume()]);
    ctx.sleep(POLL_MS);
    current = api(ctx, `repos/${ctx.state.repo}/actions/runs/${current.id}`);
  }
  if (current.conclusion !== "success") {
    throw new ReleaseRefusal(`${what} ended ${current.conclusion}: ${current.html_url}`, [`gh run view ${current.id} --repo ${ctx.state.repo} --log-failed`, ctx.resume()]);
  }
  ctx.log(`${what} passed: ${current.html_url}`);
  return current;
}

// A run that something else starts (Publish after Prepare, NPM Release after
// Publish): the newest run with this title, waiting for it to appear.
function findRunByTitle(ctx, file, title) {
  if (ctx.options.dryRun) return { id: 0, status: "completed", conclusion: "success", html_url: `(dry run of ${file})` };
  const deadline = ctx.now() + START_MS;
  for (;;) {
    const run = workflowRuns(ctx, file, "branch=main&per_page=20").find((candidate) => candidate.display_title === title);
    if (run) return run;
    if (ctx.now() > deadline) throw new ReleaseRefusal(`no ${file} run "${title}" started`, [ctx.resume()]);
    ctx.sleep(POLL_MS);
  }
}

function branchHead(ctx) {
  return api(ctx, `repos/${ctx.state.repo}/branches/${encodeURIComponent(ctx.state.branch)}`, { allowFailure: true })?.commit?.sha ?? null;
}

function npmVersion(ctx, spec) {
  return ctx.run("npm", ["view", spec, "version", "--prefer-online"], { allowFailure: true })?.trim() || null;
}

const phases = {
  cut(ctx) {
    const { state, options } = ctx;
    const head = branchHead(ctx);
    if (head) {
      state.cut.branchHead = head;
      ctx.log(`${state.branch} exists at ${head}; not cutting again (a second cut needs the maintainer's word)`);
      return;
    }
    let cut = options.cutSha ?? state.cut.cutSha;
    if (!cut) {
      const proved = workflowRuns(ctx, "flow-full-release-validation.yml", "branch=main&status=success&per_page=20");
      cut = proved[0]?.head_sha;
      if (!cut) throw new ReleaseRefusal("Flow Full Release Validation has proved no main commit yet", [`gh workflow run flow-full-release-validation.yml --repo ${state.repo} --ref main`, ctx.resume()]);
    }
    state.cut.cutSha = cut;
    ctx.save();
    const draft = `node scripts/release/changelog.mjs draft --version ${state.version} --target ${cut} --output /tmp/section.md --manifest /tmp/manifest.json`;
    if (options.confirmCutSha !== cut) {
      throw new ReleaseRefusal(`Confirm the cut ${cut} (the newest main commit Flow Full Release Validation proved, unless --cut-sha chose it)`, [
        `git fetch --unshallow --tags origin || git fetch --tags origin`,
        draft,
        `# edit the prose (.agents/skills/flow-changelog-update), then write and verify it at the cut:`,
        `node scripts/release/changelog.mjs write --version ${state.version} --file /tmp/section.md && node scripts/release/changelog.mjs verify --version ${state.version} --target ${cut}`,
        `# commit CHANGELOG/ on a branch, push it, then:`,
        resumeCommand({ ...options, cutSha: options.cutSha }, ["--confirm-cut-sha", cut, ...(options.notesRef ? [] : ["--notes-ref", "<branch>"])]),
      ]);
    }
    if (!options.notesRef) throw new ReleaseRefusal(`Name the branch that holds CHANGELOG/${state.version}.md`, [draft, resumeCommand(options, ["--notes-ref", "<branch>"])]);
    const notes = api(ctx, `repos/${state.repo}/contents/CHANGELOG/${state.version}.md?ref=${encodeURIComponent(options.notesRef)}`, { allowFailure: true });
    if (!notes) throw new ReleaseRefusal(`${options.notesRef} has no CHANGELOG/${state.version}.md`, [draft, resumeCommand(options)]);
    const run = dispatch(ctx, "flow-release-branch.yml", { operation: "cut", version: state.version, commits: cut, notes_ref: options.notesRef });
    state.cut.runId = run.id;
    ctx.save();
    waitForRun(ctx, run, "Flow Release Branch (cut)");
    state.cut.branchHead = ctx.options.dryRun ? "(dry run)" : branchHead(ctx);
    state.cut.confirmedAt = new Date(ctx.now()).toISOString();
  },

  validate(ctx) {
    const { state } = ctx;
    const head = branchHead(ctx) ?? (ctx.options.dryRun ? "(the cut's head)" : null);
    if (!head) throw new ReleaseRefusal(`${state.branch} does not exist`, [ctx.resume(["--from", "cut"])]);
    state.validate.headSha = head;
    if (ctx.options.dryRun) return;
    const deadline = ctx.now() + START_MS;
    let run;
    for (;;) {
      run = workflowRuns(ctx, "flow-full-release-validation.yml", `head_sha=${head}&per_page=20`).find((candidate) => candidate.head_branch === state.branch);
      if (run) break;
      if (ctx.now() > deadline) {
        throw new ReleaseRefusal(`Flow Full Release Validation has not run on ${state.branch} at ${head}`, [`gh workflow run flow-full-release-validation.yml --repo ${state.repo} --ref ${state.branch}`, ctx.resume()]);
      }
      ctx.sleep(POLL_MS);
    }
    state.validate.runId = run.id;
    ctx.save();
    waitForRun(ctx, run, `Flow Full Release Validation of ${state.branch}`);
  },

  publish(ctx) {
    const { state, options } = ctx;
    if (npmVersion(ctx, `${PACKAGE}@${state.version}`) === state.version) {
      ctx.log(`npm already serves ${PACKAGE}@${state.version}`);
      return;
    }
    if (!options.approvePublication) {
      throw new ReleaseRefusal(`Approve publishing ${state.tag} from ${state.branch} at ${state.validate.headSha}`, [resumeCommand(options, ["--approve-publication"])]);
    }
    const tagged = api(ctx, `repos/${state.repo}/git/ref/tags/${state.tag}`, { allowFailure: true });
    if (!tagged) {
      const prepare = dispatch(ctx, "flow-release-prepare.yml", { channel: "stable", branch: state.branch, commit: state.validate.headSha });
      state.publish.prepareRunId = prepare.id;
      ctx.save();
      waitForRun(ctx, prepare, "Flow Release Prepare");
    }
    const publish = waitForRun(ctx, findRunByTitle(ctx, "flow-release-publish.yml", `flow ${state.tag}`), "Flow Release Publish");
    state.publish.publishRunId = publish.id;
    ctx.save();
    const npm = waitForRun(ctx, findRunByTitle(ctx, "flow-npm-release.yml", `flow npm ${state.tag}`), "Flow NPM Release");
    state.publish.npmRunId = npm.id;
    if (!options.dryRun && npmVersion(ctx, `${PACKAGE}@${state.version}`) !== state.version) {
      throw new ReleaseRefusal(`npm does not serve ${PACKAGE}@${state.version} yet`, [`npm view ${PACKAGE} versions --json --prefer-online`, ctx.resume(["--from", "publish"])]);
    }
  },

  "flip-github"(ctx) {
    const { state } = ctx;
    if (ctx.options.dryRun) return;
    // A draft has no tag lookup, so find it in the newest releases.
    const release = (api(ctx, `repos/${state.repo}/releases?per_page=30`) ?? []).find((candidate) => candidate.tag_name === state.tag);
    if (!release) throw new ReleaseRefusal(`GitHub has no release ${state.tag}`, [ctx.resume(["--from", "publish"])]);
    if (release.prerelease) throw new ReleaseRefusal(`${state.tag} is marked pre-release`, [`gh api -X PATCH repos/${state.repo}/releases/${release.id} -F prerelease=false -f make_latest=true`, ctx.resume()]);
    if (release.draft) {
      ctx.run("gh", ["api", "-X", "PATCH", `repos/${state.repo}/releases/${release.id}`, "-F", "draft=false", "-f", "make_latest=true"], { mutates: true });
    }
    const latest = api(ctx, `repos/${state.repo}/releases/latest`);
    if (latest.tag_name !== state.tag) throw new ReleaseRefusal(`GitHub's latest release is ${latest.tag_name}, not ${state.tag}`, [`gh release edit ${state.tag} --repo ${state.repo} --latest`, ctx.resume()]);
  },

  "sync-beta"(ctx) {
    const { state } = ctx;
    const beta = ctx.run("npm", ["view", PACKAGE, "dist-tags.beta", "--prefer-online"], { allowFailure: true })?.trim() || "";
    const base = beta.replace(/-.*$/, "");
    let behind = !beta;
    if (beta) {
      const [x, y] = [base.split(".").map(Number), state.version.split(".").map(Number)];
      const order = x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
      behind = order < 0 || (order === 0 && beta !== state.version);
    }
    if (!behind) {
      ctx.log(`npm beta is ${beta}, not behind ${state.version}`);
      return;
    }
    const run = dispatch(ctx, "flow-release-promote.yml", { tag: state.tag });
    state["sync-beta"].runId = run.id;
    ctx.save();
    waitForRun(ctx, run, "Flow Release Promote (beta up to stable)");
  },

  closeout(ctx) {
    const { state, options } = ctx;
    const head = `${state.version}-main-closeout`;
    const branch = `release/${head}`;
    const onMain = api(ctx, `repos/${state.repo}/contents/CHANGELOG/${state.version}.md?ref=main`, { allowFailure: true });
    if (onMain) {
      ctx.log(`main already carries CHANGELOG/${state.version}.md`);
      return;
    }
    const owner = state.repo.split("/")[0];
    const prs = () => api(ctx, `repos/${state.repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`) ?? [];
    let pr = prs()[0];
    if (!pr && !options.dryRun) {
      const deadline = ctx.now() + START_MS;
      while (!api(ctx, `repos/${state.repo}/branches/${encodeURIComponent(branch)}`, { allowFailure: true })) {
        if (ctx.now() > deadline) throw new ReleaseRefusal(`Flow Release Closeout has not pushed ${branch}`, [`gh workflow run flow-release-closeout.yml --repo ${state.repo} --ref main -f tag=${state.tag}`, ctx.resume()]);
        ctx.sleep(POLL_MS);
      }
      pr = prs()[0];
      if (!pr) {
        pr = JSON.parse(ctx.run("gh", ["api", "-X", "POST", `repos/${state.repo}/pulls`, "-f", "base=main", "-f", `head=${branch}`, "-f", `title=chore(release): close out ${state.version} on main`, "-f", `body=Before: main does not carry what ${state.tag} shipped.\n\nAfter: main has the ${state.version} changelog files and the shipped version.\n\nOpened by npm run release:stable (docs/RELEASING.md, Close out on main).`], { mutates: true }));
      }
    }
    if (!pr) return;
    state.closeout.pullRequest = pr.html_url;
    ctx.save();
    if (!options.approvePublication) throw new ReleaseRefusal(`Approve merging the closeout ${pr.html_url}`, [resumeCommand(options, ["--approve-publication"])]);
    if (!options.dryRun) {
      // The checks the main ruleset requires: test and gitleaks.
      const deadline = ctx.now() + FINISH_MS;
      for (;;) {
        const runs = api(ctx, `repos/${state.repo}/commits/${pr.head.sha}/check-runs?per_page=100`)?.check_runs ?? [];
        const result = evaluateChecks(runs);
        if (result.passed) break;
        if (result.problems.some((problem) => /: (failure|cancelled|timed_out|action_required)$/.test(problem))) {
          throw new ReleaseRefusal(`the closeout ${pr.html_url} failed its checks: ${result.problems.join("; ")}`, [ctx.resume()]);
        }
        if (ctx.now() > deadline) throw new ReleaseRefusal(`the closeout's checks have not passed: ${result.problems.join("; ")}`, [ctx.resume()]);
        ctx.sleep(POLL_MS);
      }
    }
    ctx.run("gh", ["api", "-X", "PUT", `repos/${state.repo}/pulls/${pr.number}/merge`, "-f", "merge_method=squash"], { mutates: true });
    state.closeout.mergedAt = new Date(ctx.now()).toISOString();
  },
};

export function printStatus(state, log = console.log) {
  for (const phase of PHASES) {
    const details = Object.entries(state[phase] ?? {}).map(([key, found]) => `${key}=${found}`).join(" ");
    log(`${phase.padEnd(12)} ${state.phases[phase].status.padEnd(10)} ${details}`.trimEnd());
  }
}

// `exec` stands in for child_process in tests; `sleep` and `now` for time.
export function runReleaseStable(options, { exec, sleep, now = () => Date.now(), log = (line) => console.log(`[release-stable] ${line}`) } = {}) {
  const state = loadState(options);
  if (options.status) {
    printStatus(state);
    return state;
  }
  if (options.from) {
    for (const phase of PHASES.slice(PHASES.indexOf(options.from))) state.phases[phase] = { status: "pending" };
  }
  const ctx = {
    options,
    state,
    run: createRunner(options.dryRun, exec),
    save: () => saveState(options, state),
    log,
    now,
    sleep: sleep ?? ((ms) => execFileSync("sleep", [String(ms / 1000)])),
    resume: (extra) => resumeCommand(options, extra),
  };
  ctx.save();
  for (const phase of PHASES) {
    if (state.phases[phase].status === "completed") continue;
    state.phases[phase] = { status: "running", startedAt: new Date(now()).toISOString() };
    ctx.save();
    log(`${phase}: starting`);
    try {
      phases[phase](ctx);
    } catch (error) {
      state.phases[phase].status = "refused";
      state.phases[phase].error = error.message;
      ctx.save();
      throw error instanceof ReleaseRefusal ? error : new ReleaseRefusal(error.message, [ctx.resume()]);
    }
    state.phases[phase].status = options.dryRun ? "pending" : "completed";
    state.phases[phase].completedAt = new Date(now()).toISOString();
    ctx.save();
    log(`${phase}: ${options.dryRun ? "dry run done" : "completed"}`);
  }
  log(`Released: https://github.com/${state.repo}/releases/tag/${state.tag}`);
  return state;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (!options) console.log(USAGE);
    else runReleaseStable({ ...options, stateDir: resolve(options.stateDir) });
  } catch (error) {
    console.error(`Refused: ${error.message}`);
    if (error instanceof ReleaseRefusal && error.next.length) console.error(`Next:\n${error.next.join("\n")}`);
    process.exitCode = 2;
  }
}
