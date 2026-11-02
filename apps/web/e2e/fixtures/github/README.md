# A public repository, as api.github.com serves it

What `e2e/github-api.ts` answers for `ciatlas/flowpact`, so no browser test calls GitHub. Recorded anonymously
from api.github.com on 2026-10-30 (commit `a3d3e9d`):

- `repo.json`: `GET /repos/ciatlas/flowpact`, trimmed to the fields the page reads and a few around them.
- `root-tree.json`: `GET /repos/ciatlas/flowpact/git/trees/a3d3e9d…` (a commit SHA names its root tree).
- `github-tree.json`: `GET …/git/trees/<.github's tree>?recursive=1`; `size` is the file's, entries are blobs and trees.
- `action.yml`: `GET …/git/blobs/<sha>` with `Accept: application/vnd.github.raw+json`, the bytes as served.
- `headers.json`: the response headers the page needs across origins (CORS, the rate limit).

The workflow files are `e2e/fixtures/flowpact/*.yml`, under `.github/workflows/`: the fake puts them in the
recorded `.github` tree with their git blob SHAs in place of the recorded ones, so a test can move a file to a new
commit. Probed on the same day: a 304 to `If-None-Match` still counts against the anonymous limit, and the API
allows `If-None-Match` and `X-GitHub-Api-Version` in a preflight.

A pull request from a fork, recorded anonymously on 2026-11-02 from `actions/checkout#2593` (the contributor's login
replaced): `pull.json` is `GET /repos/actions/checkout/pulls/2593`, `pull-files.json` its
`GET …/pulls/2593/files?per_page=100&page=1`, both trimmed to the fields the page reads and a few around them. The
fake takes their shape and puts `ciatlas/flowpact`'s names, the head commit and the files of each test in it. Probed
the same day, which is why the fake serves a pull request's head through the opened repository: the base
repository's `git/trees/<fork head>`, `git/trees/<.github>?recursive=1`, `git/blobs/<a blob only the fork has>` and
`commits/<fork head>` all answer 200, and so does `git/trees/<head>` of a closed pull request whose fork is deleted
(`head.repo: null`, `actions/checkout#2486`).

