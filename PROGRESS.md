# Progress

## 2026-11-18 ~21:30 CST — first full build written

- Repo created: https://github.com/aixinnongnong/github-core-clone (public, empty, main).
- All source written in this session (draft + revisions): main.ts, app.ts, store.ts, git.ts,
  gitproto.ts, rest.ts, graphql.ts, mcp.ts, scenario.ts, package.json, tsconfig.json, LICENSE,
  README.md.
- Surfaces implemented: git smart HTTP (upload-pack v2/v0, receive-pack v0, ls-refs, fetch with
  shallow/deepen), REST v3 (repos, branches, commits, contents, labels, issues, comments, pulls,
  files, merge), GraphQL v4 (viewer, repository, node, issues/pullRequests connections, __type
  introspection, 5 mutations, batched documents), MCP (server/discover 2026-07-28, initialize
  fallback, tools/list, tools/call with 8 tools).
- Viewer login derived from the scenario seed (adaiversen), with a hardcoded fallback.

## 2026-11-18 ~22:10 CST — local trial: 120/120, perf 184/200

- Ran the kit's real env + suite locally (program/env/server.mjs, no Docker) against the forge,
  three trials. Trial 1: 69/120. Trial 2: 111/120. Trial 3: **120/120** (git 30/30, graphql
  20/20, issues 15/15, mcp 15/15, protocol 5/5, pulls 20/20, repos 15/15), working 1.
- Perf (trial 3): push p50 409 ms / 50 pts, clone p50 92 ms / 44 pts, read p50 862 ms / 46 pts,
  write p50 122 ms / 44 pts; total 184/200, perf_p50_us 250852. Estimated total ~984/1000
  (600 feature + 200 agent + 184 perf), above the reference forge's ~900.
- Bugs found and fixed by the trials:
  1. PUT /contents response lacked `content.encoding` (broke ~44 checks that use contents in
     their fixture) — the content object now carries type/encoding/content/sha/size/name/path.
  2. A depth-1 fetch sent the whole history: `collectReachable` followed parents past the
     depth cutoff. Replaced with `fetchObjects`, which follows a commit's tree always but its
     parents only when they are themselves selected; tag wants are now sent and walked into.
  3. `buildTreeFromFiles` dropped top-level directories: `childDir.slice(0, lastIndexOf('/'))`
     computed the parent of `config` as `confi`, so files under `config/` never reached the root
     tree. Fixed the parent/name computation for slash-less directories.
- The forge is deterministic (no wall clock, no unseeded randomness in anything sent; commit
  times and request ids are counters), so a replay of the same requests leaves the same state.
- Submitted by the parent with the keypair (the builder does not submit).
