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

The callers are `case-remote-*.yml` in the lab; the callees are in the public `ciatlas/simulci-lab-remote`, whose tree
is `remote/` here (README.md "The remote repository"). Their runs are in `expected-remote.json`, with the commit each
called workflow resolved to (`referenced`) and the commit of each action a job downloaded (`actions`); dispatches
GitHub refused, which leave no run, are in `refused.json`. `a` is the remote commit `d19def8…`, `b` is `38a93ff…`.
Round 1 (lab commit `2035977…`, 2026-10-30) ran with the remote's `v1` and `main` on `a`, round 2 (lab `4061055…`)
with both on `b`. Every run concluded `success`.

### R1. remote-reusable-outputs (`case-remote-reusable-outputs.yml`)

Claim: a remote reusable workflow behaves as a local one (cases 9 and 10).

Observed: `echo / x` ran, `needs.echo.result=success`, `needs.echo.outputs.o=hello`, `toJSON` `{"o":"hello"}`. The
all-skipped callee: checks `skipped / x` and `skipped / y` `skipped`, no check `skipped`; `needs.skipped.result=skipped`;
`needs.skipped.outputs.o=''`, `toJSON` `{"o":""}`. The `if: false` remote call: one check `not-called`, `skipped`,
`needs.not-called.result=skipped`. `b` (`always()`) ran; `c` (no `if`, needing a skipped call) skipped.

Verdict: identical to cases 9 and 10; where the callee lives changes nothing about results, outputs or check names.

### R2. remote-relative-workflow, remote-self (`case-remote-relative-workflow.yml`, `case-remote-self.yml`)

Claim: a job's `./.github/workflows/…` inside a remote is the remote repository's file at the commit the outer
workflow was read at; `$/` inside a remote, at job and step level, is the remote's repository at that commit.

Observed: never `caller`. Round 1: `by-sha` and `by-tag` both `remote-a`. Round 2: `by-sha` (outer `@a`) read the
inner at `a` (`r2-inner=remote-a`) while the remote's `main` was on `b`; `by-tag` (outer `@v1` = `b`) read the inner
at `b`, and `referenced` lists it as `callee-r2-inner.yml@38a93ff…` with ref `refs/tags/v1`, the outer's ref. `$/`
(no checkout, round 2, `main` on `b`): the job-level call ran the remote's inner at `a` (`referenced`
`callee-r2-inner.yml@d19def8…`), and the step-level `$/.github/actions/r2-self` was downloaded as
`ciatlas/simulci-lab-remote@d19def8…` and echoed `remote-a`.

Verdict: as claimed. A remote's `./` (job level) and `$/` (both levels) are `<remote>@<the commit its parent was read
at>`: synthesis § 2.4's row 3 and K1's reading of `self: true` inside an external unit hold. GitHub records the
`./` callee under its parent's ref name.

### R3. remote-workspace-action (`case-remote-workspace-action.yml`)

Claim: a step's `./` inside a remote is the runner's workspace, not the remote repository.

Observed: without a checkout the step failed (`bare.outcome=failure`; its API conclusion `success` under
`continue-on-error`). After a default `actions/checkout` (`checkout.repository=ciatlas/simulci-lab`) the caller's
copy ran (`r3-action=caller`).

Verdict: as claimed; a remote's step-level `./` reads whatever the job checked out, by default the caller's
repository, never the remote's. Core's mapping (`workspacePath`) stands.

### R4. remote-node-undeclared-output (`case-remote-node-undeclared-output.yml`)

Claim: a node action's outputs are what it writes, declared or not.

Observed: `steps.n.outputs.declared=d`, `steps.n.outputs.undeclared=u`, `toJSON(steps.n.outputs)`
`{"declared":"d","undeclared":"u"}`.

Verdict: as claimed; `action.yml`'s `outputs` do not filter a node action's outputs, so an undeclared one is
readable (unlike a composite's, R8). An unknown output of a remote node action is unknown, not `''`.

### R5. remote-tag-vs-sha (`case-remote-tag-vs-sha.yml`)

Claim: a tag or branch ref runs the commit it points at when the run starts; a SHA ref never moves.

Observed: round 1 `r5-version=a` three times. Round 2 `by-tag` and `by-branch` `b`, `by-sha` `a`; `referenced`
records `@v1` and `@main` at `38a93ff…` (refs `refs/tags/v1`, `refs/heads/main`), `@<a>` at `d19def8…` with no ref.

Verdict: as claimed.

### R6. remote-secrets-inherit (`case-remote-secrets-inherit.yml`)

Claim: `secrets: inherit` passes secrets to a remote of the same owner, not to one of another owner, without failing.

Observed: same owner `lab-secret=true`; other owner (`rumankazi/simulci-lab-remote`, same commit) `lab-secret=false`;
both `github-token=true` and `owner=ciatlas` (the caller's context); both calls `success`.

Verdict: as claimed; across owners `inherit` silently passes nothing but `GITHUB_TOKEN`, so secrets read there are
`''`.

### R7. remote-nesting-10 … -21, remote-total-50, -51

Claim: GitHub runs ten levels (the caller and nine reusable workflows) and refuses eleven; 50 distinct called
workflows run, 51 are refused.

Observed: `nesting-10` and `nesting-11` ran to their leaf (check `call / next / … / leaf`, 9 and 10 entries in
`referenced`). Depths 12 to 21 (local wrappers in front of the remote chain, added after `nesting-11` ran) were
refused at dispatch: no run, `HTTP 422 … error parsing called workflow` with the chain, ending `job "next" calls
workflow "…", but doing so would exceed the limit on called workflow depth of 10` (`refused.json`). `total-50` ran
its 50 leaves; `total-51` was refused at dispatch: `too many workflows are referenced, total: 51, limit: 50`.

Verdict: the depth limit counts called workflows, not the caller: a caller and ten nested callees (eleven files)
run, a twelfth file is refused; local and remote links count alike. The total is 50 distinct called workflows. Both
refusals happen when the run would be created, so they never show as a failed run (a push would start nothing for
that workflow); the message names the call that crosses the limit.

### R8. remote-composite-outputs (`case-remote-composite-outputs.yml`)

Claim: a composite action exposes only its declared outputs.

Observed: `steps.c.outputs.o=x`, `steps.c.outputs.extra=''`, `toJSON(steps.c.outputs)` `{"o":"x"}`.

Verdict: as claimed.

### R9. remote-actions-lock, -uncovered, -local-callee, -missing

Claim (K4, unverified until here): GitHub runs an `actions.lock` pin only in a workflow the lock covers.

The lock (`repo/.github/workflows/actions.lock`, written by `gh actions-lock` v0.4.0 with `--no-narrow` over three
workflows) pins `ciatlas/simulci-lab-remote@v1` to `a` under `case-remote-actions-lock.yml` and `-missing.yml` (whose
`@main` step was added afterwards), and lists `case-remote-actions-lock-local-callee.yml` with no pins (the tool
does not follow its local callee).

Observed: round 1 all three ran `a`. Round 2 (`v1` on `b`): the covered workflow downloaded
`ciatlas/simulci-lab-remote@v1` at `d19def8…` and echoed `a`; the uncovered one downloaded it at `38a93ff…` and
echoed `b`; the step inside the local callee of a covered workflow ran `b` and did not fail. The covered workflow
whose step the lock lacks was refused at dispatch in both rounds: `Invalid dependency lockfile … references actions
not present in the lockfile: ciatlas/simulci-lab-remote@main`.

Verdict: a pin applies only in a workflow the lock lists, keyed by that workflow's own path (K4's `pinApplies`
holds): an uncovered workflow runs the tag, and a local reusable workflow's steps are judged by the callee's own
path (here uncovered, so the tag), not by the covered caller's. A covered workflow with a step the lock lacks is
not a failing job but a workflow GitHub refuses to start. The lock is in effect on the lab's plan (Team, private
repository).

### R10. remote-same-repo-ref, remote-same-repo-self

Claim (finding 5): a full ref to the running repository runs that ref, never the working copy.

Observed: on `main` all three read `main`. On `probe/r10` (copy says `branch`): `full-ref`
(`ciatlas/simulci-lab/…@main`) read `main`, `referenced` at `2035977…` (`refs/heads/main`); `relative` (`./`) and
`self` (`$/`) read `branch`, `referenced` at the branch head `17ffb50…`.

Verdict: as claimed; a same-repository full ref is a remote at that ref, and `./` and `$/` are the running commit.
