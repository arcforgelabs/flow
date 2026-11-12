"""Select CI lanes from the changed paths (the upstream ci.yml preflight job).

Copied from arcforgelabs/platform .github/scripts/ci-scope.py, with one
addition: a glob that starts with "!" removes paths from a lane.

SCOPES is a JSON map of lane -> path globs. A pull request turns a lane on when
a changed path matches one of its globs and none of its "!" globs. The diff is
against the default branch (BASE), whatever the pull request's base is: a
retarget starts no new run. Every lane turns on for a push, a manual run, a
release check (a workflow_call with a ref), a change to CI itself, an empty
diff, or while the switch (SWITCH, repository variable FLOW_CI_SCOPE) is not
"on". Prints one `lane=true|false` line per lane for
$GITHUB_OUTPUT.
"""
import json
import os
import re
import subprocess

CI_FILES = {".github/workflows/ci.yml", ".github/scripts/ci-scope.py"}


def regex(glob):
    out, i = "", 0
    while i < len(glob):
        if glob.startswith("**/", i):
            out, i = out + "(?:.*/)?", i + 3
        elif glob.startswith("**", i):
            out, i = out + ".*", i + 2
        elif glob[i] == "*":
            out, i = out + "[^/]*", i + 1
        elif glob[i] == "?":
            out, i = out + "[^/]", i + 1
        else:
            out, i = out + re.escape(glob[i]), i + 1
    return re.compile(out + r"\Z")


def changed_paths():
    """The changed paths of a pull request, or None for every other run."""
    if os.environ.get("SWITCH") != "on":
        return None
    if os.environ.get("EVENT") != "pull_request" or os.environ.get("REF"):
        return None
    # --no-renames: a rename lists both its old and its new path.
    return subprocess.run(
        ["git", "diff", "--no-renames", "--name-only", "-z",
         f"{os.environ['BASE']}...{os.environ['HEAD']}"],
        check=True, capture_output=True, text=True).stdout.split("\0")


def main():
    scopes = json.loads(os.environ["SCOPES"])
    diff = changed_paths()
    diff = None if diff is None else [f for f in diff if f]
    every = diff is None or not diff or bool(CI_FILES & set(diff))
    for lane, globs in scopes.items():
        take = [regex(g) for g in globs if not g.startswith("!")]
        drop = [regex(g[1:]) for g in globs if g.startswith("!")]
        on = every or any(
            any(p.match(f) for p in take) and not any(p.match(f) for p in drop)
            for f in diff)
        print(f"{lane.replace('-', '_')}={'true' if on else 'false'}")


if __name__ == "__main__":
    main()
