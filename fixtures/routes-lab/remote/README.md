# simulci routes lab: the remote side

Reusable workflows and actions that the private routes lab (`ciatlas/simulci-lab`) calls as remotes. Their real
results, captured from the lab's runs, are what [simulci](https://github.com/ciatlas/simulci) tests its remote
reusable workflows against (`fixtures/routes-lab/` there: `remote/` is this tree, `cases.md` cases R1-R10).

Nothing here runs on its own: every workflow is `on: workflow_call`. Files whose probe says `a` say `b` on the
commit the tag `v1` moves to (cases R2, R5 and R9). A mirror under another owner (`rumankazi/simulci-lab-remote`)
holds the same commits, for case R6.
