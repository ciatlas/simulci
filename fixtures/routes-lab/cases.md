# The cases, what GitHub did, and what the simulator must do

One section per case of the lab. "Observed" is read off `expected.json` (job and step conclusions from the API,
values from the `probe:` lines); every status case ran five times with the same result unless a section says
otherwise. The verdict is the rule the engine implements. Conclusions use GitHub's words: `success`, `failure`,
`cancelled`, `skipped`.

## Status propagation

### 1. skipped-need (`case-skipped-need.yml`)

Claim: a job with `if: false` is `skipped`; of its dependents only those whose `if` tolerates a non-success run.

Observed: `a` skipped. `b` (no `if`) skipped, `f` (`success()`) skipped, `d` (`failure()`) skipped; `c` (`always()`)
and `e` (`!cancelled()`) ran with `needs.a.result=skipped`. Run conclusion `success`. Every job, skipped ones
included, is a check run named by its id with the same conclusion.

Verdict: a skipped need fails the implicit and explicit `success()`, is not a `failure()`, and is visible as
`needs.<id>.result == 'skipped'` only to `always()`/`!cancelled()` dependents; the run still succeeds.

### 2. skipped-job-outputs (`case-skipped-job-outputs.yml`)

Claim: the declared outputs of a skipped job are empty downstream.

Observed: `needs.a.outputs.v` is `''`, `toJSON(needs.a.outputs)` is `{}` (the key is absent, not empty); the step
with `if: needs.a.outputs.v == ''` ran, the `!= ''` one was skipped.

Verdict: a skipped job contributes `outputs: {}`; a missing output reads as `''` and compares equal to `''`.

### 3. skipped-step-outputs (`case-skipped-step-outputs.yml`)

Claim: a skipped step has no outputs and both `outcome` and `conclusion` are `skipped`.

Observed: `steps.s.outputs.x=''`, `toJSON(steps.s.outputs)={}`, `steps.s.outcome=skipped`,
`steps.s.conclusion=skipped`; the `== ''` and `== 'skipped'` step conditions ran, `!= ''` was skipped.

Verdict: as claimed.

### 4. continue-on-error-job (`case-continue-on-error-job.yml`)

Claim: a job that fails under `continue-on-error: true` counts as success for everything downstream.

Observed: the job `a` and its check run report `failure` (its step `failure`), yet the run conclusion is `success`,
`b` (no `if`) and `d` (`always()`) ran, `c` (`failure()`) was skipped, and both saw `needs.a.result=success`.

Verdict: the job's own conclusion is `failure` (API and check), its result for dependents and for the run is
`success`. The simulator must keep the two apart: report `failure` for the job, propagate `success`.

### 5. continue-on-error-step (`case-continue-on-error-step.yml`)

Claim: `outcome` keeps the real result and `conclusion` the one after `continue-on-error`.

Observed: `steps.f.outcome=failure`, `steps.f.conclusion=success`, the step's API conclusion `success`,
`job.status=success`; `if: failure()` skipped, `if: success()` ran.

Verdict: as claimed; the job status never turns to failure through such a step.

### 6. matrix-aggregate (`case-matrix-aggregate.yml`)

Claim: the result of a matrix job for its dependents is the aggregate of its legs; fail-fast cancels the others.

Observed: with `fail-fast: true`, leg 2 `failure`, legs 1 and 3 `cancelled`; with `fail-fast: false`, leg 2
`failure`, legs 1 and 3 `success`. Both dependents (`always()`) saw `needs.<id>.result=failure`. Run `failure`.
In four runs the cancelled legs' `leg` step had finished (`success`) before the job was marked `cancelled`; in one
(39026430814, leg 1) the step itself was `cancelled`: the step conclusion inside a cancelled leg is timing.

Verdict: one failed leg makes the matrix job `failure` for `needs`, whatever happened to the other legs; with
`fail-fast: true` the remaining legs are `cancelled` (their steps unspecified); the run fails.

### 7. matrix-one-failed (`case-matrix-one-failed.yml`)

Claim: with `fail-fast: false` the other leg completes and the aggregate is still `failure`.

Observed: `a (1)` success, `a (2)` failure, `b` (`always()`) ran with `needs.a.result=failure`, `c` (no `if`)
skipped. Run `failure`.

Verdict: as claimed.

### 8. matrix-outputs (`case-matrix-outputs.yml`)

Claim: a matrix job's output is written by whichever leg sets it last, and an empty value does not overwrite.

Observed (legs finished in the order 1, 3, 2 in every run): `needs.a.outputs.w=2` (every leg wrote its number;
the last to finish won, not the highest index) and `needs.a.outputs.v=3` (leg 2 wrote `''` last; the value of
leg 3 survived). The key order in `toJSON(needs.a.outputs)` varied between runs (`{"v","w"}` and `{"w","v"}`):
compare it parsed, not as text.

Verdict: outputs of a matrix job are the per-key union of its legs where the last non-empty write wins; a leg that
sets a key to `''` leaves it untouched. For the simulator, the completion order is an unknown unless mocked; with
one non-empty writer the value is determined.

### 9. reusable-all-skipped (`case-reusable-all-skipped.yml`)

Claim: a reusable workflow whose jobs are all skipped behaves like a skipped job for its caller's dependents.

Observed: checks `call / x` and `call / y` `skipped` (there is no check named `call`); `needs.call.result=skipped`;
the callee's declared output is present but empty, `toJSON(needs.call.outputs)` is `{"o":""}`; `b` (`always()`)
ran, `c` (no `if`) skipped. Run `success`.

Verdict: the caller job's result is `skipped` when every callee job is skipped; its declared outputs exist with
`''` (unlike a skipped job, whose outputs object is empty: cases 2 and 9 differ on `toJSON`, not on the value read).

### 10. reusable-skipped-call (`case-reusable-skipped-call.yml`)

Claim: a caller job with `if: false` is one skipped check and the callee's jobs never appear.

Observed: one check and one job, `call`, `skipped`; no `call / x`. `needs.call.result=skipped`; `b` ran, `c`
skipped.

Verdict: a skipped `uses:` job is reported by its own id, not expanded; dependents see `skipped`.

### 11. output-last-write (`case-output-last-write.yml`)

Claim: writing a key twice to `$GITHUB_OUTPUT` keeps the last value; a heredoc value keeps its newlines.

Observed: `steps.w.outputs.k=second` and `needs.a.outputs.k=second`; `m` is `"line one\nline two"` (as JSON) at
both hops.

Verdict: as claimed; multi-line values survive the step → job output → `needs` path unchanged.

### 12. grandparent-outputs (`case-grandparent-outputs.yml`)

Claim (from the plan): `needs.<id>` of an indirect dependency is visible in a job-level `if` but not in the job's
steps.

Observed: `p` (`needs: m`, `if: needs.a.outputs.v == 'hello'`) ran; in `q` (`needs: m`) the step with the same
condition was skipped, `needs.a.outputs.v` echoed `''` and `toJSON(needs)` was
`{"m":{"result":"success","outputs":{}}}`.

Verdict: the `needs` context of a job-level `if` holds every transitive dependency; the `needs` context on the
runner holds only the direct ones. The simulator evaluates job `if` with the transitive closure and step
expressions with the direct needs.

### 13. composite-action-status (`case-composite-action-status.yml`)

Claim: inside a composite action a failing step makes `failure()` true for the following inner steps; the using
step's `outcome` is `failure` and, under `continue-on-error`, its `conclusion` is `success`.

Observed: inner `if: failure()` ran, inner `if: success()` skipped, inner `if: always()` ran;
`steps.u.outcome=failure`, `steps.u.conclusion=success`, the step's API conclusion `success`, `job.status=success`;
the job's `if: failure()` step skipped, `if: success()` ran. Composite inner steps do not appear in the job's step
list (numbers jump from 6 to 12).

Verdict: status functions inside a composite action see the composite's own steps; the composite as a whole fails
when one of its steps fails, and `continue-on-error` on the using step applies to that whole.

### 14. fail-fast-cancelled (`case-fail-fast-cancelled.yml`)

Claim: when fail-fast cancels legs, the matrix job's result is still `failure`, not `cancelled`.

Observed: legs `cancelled`, `failure`, `cancelled`; `d` (`always()`) and `e` (`failure()`) ran with
`needs.a.result=failure`; `b` (no `if`) and `c` (`cancelled()`) skipped. Run `failure`.

Verdict: the cancelled legs do not make the aggregate `cancelled`: a failed leg dominates; `cancelled()` stays
false for dependents (nobody cancelled the run).

### 15. step-timeout (`case-step-timeout.yml`)

Claim: a step that hits `timeout-minutes` fails (it is not a cancellation).

Observed: step `sleep` `failure`, `steps.t.outcome=failure`, `steps.t.conclusion=failure`, `job.status=failure`;
`if: failure()` ran, `if: cancelled()` and `if: success()` skipped. Job and run `failure`.

Verdict: a step timeout is an ordinary step failure.

### 16. if-boolean-literal (`case-if-boolean-literal.yml`, `-zero.yml`, `-empty.yml`)

Claim: which literal forms of `if:` run, and whether they all parse.

Observed: all three files parsed. Skipped: `if: false`, `if: 'false'`, `if: ${{ false }}`, `if: ${{ 'false' }}`,
`if: 0`, and the job with `if: false`. Ran: `if: true`, `if: 'true'`, `if: 1`, `if: ''`.

Verdict: the YAML value is taken as expression text (`false`, `'false'` and `0` all mean false); an empty `if` is
no condition (`success()`); and `${{ 'false' }}` is rendered to the text `false` and then read as the expression
`false`, so the simulator renders `${{ }}` in `if` to a string first and parses that string as the condition
rather than taking the expression's value (a non-empty string would otherwise be truthy).

### 17. unknown-or-true (`case-unknown-or-true.yml`)

Claim: a missing value is falsy, so `missing || true` runs and `missing && true` does not; a missing input equals
`''`.

Observed (push and `workflow_dispatch` alike): jobs `or` and `inputs-missing` ran, `and` skipped; the step
versions likewise; `vars.DOES_NOT_EXIST=''`, `or-value=true`, `and-value=''`, `inputs.missing=''`;
`toJSON(inputs)` is `{}` on push and `{"present":"declared-default"}` on dispatch, where `inputs.present` was
`''` on push.

Verdict: as claimed; `x && y` yields `x` when `x` is falsy and renders as `''`; `inputs` is empty on events
without inputs and holds declared defaults on `workflow_dispatch`.

## Triggers

### 18. filter-paths, filter-paths-ignore, filter-branches-and-paths

Claim: `paths`/`paths-ignore` filter pushes by the changed files; combined with `branches` both must match.

Observed: `paths: ['src/**']` ran for the `src/`-only push and for the tag push (changed files: `src/main.txt`),
not for the initial, `docs/`-only or branch pushes. `paths-ignore: ['docs/**']` ran for the initial push (files
outside `docs/` changed), the `src/` push and the tag push, not for the `docs/`-only push nor the branch push
(`docs/pr.md`). `branches: [main]` + `paths: ['src/**']` ran once, for the `src/` push to `main`; not for the tag.

Verdict: as claimed, with two details: path filters do not apply to tag pushes (a tag push with `paths` runs
regardless), and `branches` without `tags` excludes tag pushes.

### 19. filter-tags, filter-branches-tags

Claim: `tags: ['v*']` alone runs for tag pushes only; with `branches: [main]` either may match.

Observed: `filter-tags` ran once (`refs/tags/v0.0.1`); `filter-branches-tags` ran for every push to `main` and for
the tag, not for the branch `probe/pr`. A bare `on: push` ran for every push: `main`, the tag and the branch.

Verdict: as claimed; `branches`/`tags` each restrict their own kind of ref, and the absence of both means every ref.

### 20. types-default, types-labeled

Claim: `on: pull_request` without `types` runs on `opened` (and `synchronize`, `reopened`), not on `labeled`;
`types: [labeled]` runs on `labeled` only.

Observed: `case-types-default` ran once, `event.action=opened` (`refs/pull/1/merge`, `head_ref=probe/pr`);
`case-types-labeled` ran once, `event.action=labeled`, `event.label.name=probe`. Neither ran for the other
activity.

Verdict: as claimed.

### 21. skip-ci

Claim: a commit whose message contains `[skip ci]` starts no push run, and `workflow_dispatch` still runs on it.

Observed: no run at all has `sha` `e623802…` with event `push` (none of the 22 workflows that run on every push
started); `case-skip-ci` and `case-unknown-or-true` dispatched on that commit ran (`event=workflow_dispatch`).
The later README commit `5e59469…`, also `[skip ci]`, started nothing either.

Verdict: `[skip ci]` in the head commit's message suppresses every `push` workflow of that push; a
`workflow_dispatch` on the same commit runs normally.

## Remote reusable workflows and actions (L1)

The callers are `case-remote-*.yml` in the lab; the callees are the public `ciatlas/simulci-lab-remote`, whose tree
is `remote/` here (README.md "The remote repository"). Their runs are in `expected-remote.json`, with the commit
each called workflow resolved to (`referenced`) and the commit of each action a job downloaded (`actions`).
`a` is the remote commit `d19def8…`, `b` is `38a93ff…`; round 1 ran with `v1` and `main` on `a`, round 2 with both
on `b`.

**Not yet run: every "Observed" below is pending until the lab's runs exist.**

### R1. remote-reusable-outputs (`case-remote-reusable-outputs.yml`)

Claim: a remote reusable workflow behaves as a local one (cases 9 and 10): the call that runs is `success` with
`needs.echo.outputs.o=hello` and checks `echo / x`; the all-skipped callee is `success` with an empty output,
`toJSON` `{}`, and checks `skipped / x`, `skipped / y` reported `skipped`; the `if: false` call is `skipped` with one
check `not-called`; `c` (no `if`) runs.

Observed: pending.

### R2. remote-relative-workflow, remote-self (`case-remote-relative-workflow.yml`, `case-remote-self.yml`)

Claim: a job's `./.github/workflows/…` inside a remote is the remote repository's file at the commit the outer
workflow was read at (`docs`: "the same commit as the caller workflow"): `by-sha` reads `remote-a` in both rounds,
`by-tag` `remote-a` then `remote-b`; never `caller`. `$/` inside a remote, at job and step level, is likewise the
remote's repository at that commit: `r2-inner=remote-a` and `r2-self-action=remote-a` in both rounds.

Observed: pending.

### R3. remote-workspace-action (`case-remote-workspace-action.yml`)

Claim: a step's `./` inside a remote is the runner's workspace, not the remote repository: without a checkout the
step fails (`bare.outcome=failure`); after a default checkout, which checks out the caller's repository
(`checkout.repository=ciatlas/simulci-lab`), the caller's action runs (`r3-action=caller`).

Observed: pending.

### R4. remote-node-undeclared-output (`case-remote-node-undeclared-output.yml`)

Claim: a node action's outputs are what it writes, declared or not: `steps.n.outputs.undeclared=u`,
`toJSON(steps.n.outputs)` holds both keys. (If GitHub filters by `action.yml`, it reads `''`; the engine's model of
action outputs follows whichever the lab shows.)

Observed: pending.

### R5. remote-tag-vs-sha (`case-remote-tag-vs-sha.yml`)

Claim: a tag or branch ref runs the commit it points at when the run starts; a SHA ref never moves. Round 1:
`r5-version=a` three times. Round 2: `by-tag` and `by-branch` `b`, `by-sha` `a`; `referenced` records the same SHAs.

Observed: pending.

### R6. remote-secrets-inherit (`case-remote-secrets-inherit.yml`)

Claim: `secrets: inherit` passes the caller's secrets to a remote of the same owner (`lab-secret=true`) but not to
one of another owner (docs: within the same organization or enterprise), where `lab-secret=false`; the run does not
fail for it, and `GITHUB_TOKEN` reaches both.

Observed: pending.

### R7. remote-nesting-10, -11, remote-total-50, -51

Claim: GitHub runs a workflow tree of ten levels (the caller and nine reusable workflows) and refuses eleven; it
runs 50 distinct reusable workflows called from one workflow and refuses 51. A refused tree is a run that fails
before any job starts.

Observed: pending.

### R8. remote-composite-outputs (`case-remote-composite-outputs.yml`)

Claim: a composite action exposes only its declared outputs: `steps.c.outputs.o=x`, `steps.c.outputs.extra=''`,
`toJSON(steps.c.outputs)` `{"o":"x"}`.

Observed: pending.

### R9. remote-actions-lock, -uncovered, -local-callee, -missing

Claim (K4, **unverified**): GitHub runs an `actions.lock` pin only in a workflow the lock covers. Round 2 (`v1` on
`b`): the covered workflow runs `a` (`r9-action=a`, `actions` shows `a`'s SHA), the uncovered one runs `b`. A step
in a local reusable workflow called by a covered workflow is pinned under the callee's own path, so with no entry for
the callee it runs `b` (or fails, if GitHub treats the callee as covered through its caller). In the covered
workflow with a step the lock lacks, that step fails with `lockfile missing pin`; if it runs instead, the lock is
not in effect in the lab and the other R9 results say nothing about pins.

Observed: pending.

### R10. remote-same-repo-ref, remote-same-repo-self

Claim (finding 5): a full ref to the running repository (`ciatlas/simulci-lab/…@main`) runs that ref, never the
working copy: on `probe/r10` the `full-ref` job reads `r10-copy=main` while `relative` (`./`) and `self` (`$/`)
read `branch`. On `main` all three read `main`.

Observed: pending.
