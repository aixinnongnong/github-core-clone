# github-core-clone

A GitHub-compatible git forge in a single Node.js process, built for
[make.fun's github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01)
($500 in USDC). One process, no dependencies, no git binary, no outside service: it serves
git smart HTTP, GitHub REST v3, GraphQL v4 and MCP from one in-memory store.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on
its own. There is nothing to install: the program imports `node:http`, `node:crypto`,
`node:zlib` and its own modules only, and the trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`.

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite runs
   and `{"done":true}` once its export is written. Poll with a short backoff.
4. **Exit 0** when it does.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, node, issues/pull-requests connections, introspection, five mutations |
| `POST /mcp` | Model Context Protocol over streamable HTTP (revision 2026-07-28, with a legacy initialize fallback): server/discover, tools/list, tools/call |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 and v0), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the HTTP server and routing.
- `store.ts`: the in-memory store and the git-level operations (trees, commits, merges).
- `git.ts`: the git object model, packfile read/write and pkt-line codec.
- `gitproto.ts`: the git smart-HTTP handlers.
- `rest.ts`: the REST v3 handlers.
- `graphql.ts`: the GraphQL parser and executor.
- `mcp.ts`: the MCP JSON-RPC handlers.
- `scenario.ts`: the seeded RNG that derives the token owner's login (the viewer).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Determinism

The store holds no wall clock and no unseeded randomness: timestamps are the trial's fixed
"now" (or a counter-derived commit time), request ids are a counter, and the viewer login is
derived from the scenario's fixed seed. A replay of the same requests leaves the same state.
