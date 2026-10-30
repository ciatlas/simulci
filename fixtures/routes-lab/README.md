# Conclusions captured from GitHub: the routes lab

The workflows live in the private lab repository `ciatlas/simulci-lab` (one small workflow per case, listed in its
README with the claim each one tests; `cases.md` here repeats the claims next to what GitHub actually did).
`expected.json` holds every completed run of that repository: the run (workflow, event, ref, commit, changed files,
conclusion), its jobs and steps with the conclusions GitHub's API reports, the check runs it created (so check names
are recorded too), and the `probe: <label>=<value>` lines the jobs echoed, pulled from the job logs: the values of
`needs.<id>.result`, `steps.<id>.outcome`, outputs, `toJSON(needs)` and so on as the runner saw them. Those values
are the oracle the engine's conformance tests compare against; nothing in the file was typed by hand.

The engine is only tested on what the oracle observed: a run means "this input produced these conclusions", not
"this is how it is documented".

## The workflows

`repo/` is the lab repository's `.github/` tree and README at the last run-starting commit
(`e623802ba524a344c2033c94c438a38fe0e8c07f`), so the engine can simulate exactly what the runs executed. Workflows
under `fixtures/` are inert for GitHub; the one true copy is the lab repository.

## Re-capturing

```sh
node scripts/capture-lab.mjs --repo ciatlas/simulci-lab --except case-remote- --out fixtures/routes-lab/expected.json \
  --pushes fixtures/routes-lab/pushes.json
node scripts/capture-lab.mjs --repo ciatlas/simulci-lab --only case-remote- --remotes \
  --out fixtures/routes-lab/expected-remote.json
```

The second form is the remote cases (below). Uses `GITHUB_TOKEN` or `GH_TOKEN`, else the `gh` CLI's token; without
`--out` the JSON goes to stdout; `--run <id>` (repeatable) captures only those runs; `--only` and `--except` select
runs by a pattern on the workflow path; `--remotes` adds, per run, the commit each called workflow resolved to
(`referenced`, from the run's `referenced_workflows`) and, per job, the commit of each action it downloaded
(`actions`, from the log's `Download action repository` lines); requests answered with a 5xx are retried twice.
Runs are ordered by id, jobs and checks by name, steps by number and probes by label, and the file carries no
timestamps, so the only thing that changes between two captures of the same lab state is nothing. To probe something new, add `case-<slug>.yml` to the lab, push `main`, wait for the runs, re-capture and
describe the case in `cases.md`.

## The push table (`pushes.json`)

Every push to the lab, oldest first, with the workflows whose `push` runs it started: `{ kind, ref, sha, message,
changed, workflows }`, where `kind` is `push`, `branch_creation` (both from the repository's activity API) or `tag`
(from the tags API, which gives no time, so tags come last), and `changed` is the files the push changed (the
compare of `before` and `sha`, or the commit's files for a new ref). A workflow file of the lab that is not in
`workflows` did not trigger on that push, which is what makes "did not trigger" measurable; the table above is the
same data as prose.

## The lab's state behind this capture

`main` is at `5e594693380fa34235983969abd581e7523d7cb8` (a README-only commit with `[skip ci]`, which started no run;
the last commit that did is `e623802…`). The pushes, in order, and what each one exercised:

| Commit | Push | Exercised |
|---|---|---|
| `5043371fae5a0dae0899a01f8a8b7de8deb63eb1` | `main`, the workflows and README | every status case; `paths-ignore: docs/**` runs (files outside `docs/` changed), `paths: src/**` does not |
| `c3741fa8b8dd8c6e8f57f060173648d8b9bcbfdc` | `main`, `docs/note.md` only | `paths-ignore` skips, `paths: src/**` skips, `branches` + `paths` skips, `branches` + `tags` runs |
| `37e44101431bc8c46dc3ba1631d9dcf92cda5ea3` | `main`, `src/main.txt` only | every path filter runs |
| `37e44101431bc8c46dc3ba1631d9dcf92cda5ea3` | tag `v0.0.1` (on the same commit) | `tags: v*` runs, `branches: [main]` + `paths` does not; path filters are ignored for tags; bare `on: push` runs again |
| `e623802ba524a344c2033c94c438a38fe0e8c07f` | `main`, `docs/skip.md`, message with `[skip ci]` | no push run at all; `workflow_dispatch` of `case-skip-ci` and `case-unknown-or-true` on this commit |
| `0ca8d4f44a28f6d4444d9fc36f355dcd476f8f48` | branch `probe/pr`, `docs/pr.md` only; then pull request #1, then the label `probe` | bare `on: push` runs for the branch, `branches: [main]` does not; `pull_request` runs on `opened`, `types: [labeled]` on `labeled` |

Every status case therefore ran five times (three `main` pushes that start workflows, the tag, the branch): 115
runs. Job conclusions and probe values were identical across the five runs of every case, with two artifacts of
timing that `cases.md` names where they occur: the step conclusion inside a leg that fail-fast cancelled, and the
key order of a `toJSON(needs.<id>.outputs)` string.

## The remote repository (`remote/`)

Cases R1-R10 (`cases.md`) call reusable workflows and actions in the public `ciatlas/simulci-lab-remote`. `remote/`
is its tree at commit `a`, `d19def8c3562ef6c1be3f12443345575530f1ac4`, where `main` and the lightweight tag `v1`
start. Commit `b`, `38a93ff01695fd104bfe8bc8b79ceeae91206ddc`, is `a` with five probe lines changed from `a` to `b`:
`remote-a` → `remote-b` in `callee-r2-inner.yml` (twice), `callee-r2-outer.yml` and `actions/r2-self/action.yml`,
`r5-version=a` → `=b` in `callee-r5-version.yml`, and `r9-action=a` → `=b` in `actions/r9-action/action.yml`. Round
2 runs with `main` and `v1` on `b`. `rumankazi/simulci-lab-remote` holds the same two commits, so case R6 calls one
commit under two owners. The lab's callers (`repo/.github/workflows/case-remote-*.yml`) name `a` by its SHA.

The runs are in `expected-remote.json`, in `expected.json`'s format plus `referenced` and `actions`. The lab's
commits for them all carry `[skip ci]`, and the callers run on `workflow_dispatch`, so `expected.json` gains no runs.

### Running the remote cases

1. Create `ciatlas/simulci-lab-remote` and `rumankazi/simulci-lab-remote`, both public and empty, and push commit
   `a` as `main` with the tag `v1` to both (a local repository with both commits, `b` on the branch `moved`, is the
   source).
2. Add the lab secret `LAB_SECRET` (any value; R6 reports only whether it arrived).
3. In the lab: commit the callers, then write the lock with `gh actions-lock --no-narrow` over
   `case-remote-actions-lock.yml`, `case-remote-actions-lock-local-callee.yml` and
   `case-remote-actions-lock-missing.yml` while the last lacks its `@main` step, add that step, and commit both. Push
   `main`, then the branch `probe/r10`, one `[skip ci]` commit on top whose `callee-r10.yml` probe says `branch`.
4. Round 1: dispatch every `case-remote-*.yml` on `main`, and the two R10 callers on `probe/r10`.
5. Move: push `b` to `main` and force `v1` to `b` in both remote repositories.
6. Round 2: dispatch R2 (`relative-workflow`, `self`), R5 and the four R9 callers on `main`.
7. Capture with the second command above; the `referenced` and `actions` SHAs say which round a run was.
