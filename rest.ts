// The GitHub REST v3 surface: repositories, branches, commits, contents, labels, issues,
// comments, pull requests, files and merges. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors carry a JSON body with a string message; a missing or wrong bearer
// token is a 401; a repository under any owner but the token's login is a 404, never a 403.
// Unknown routes are a JSON 404 and a malformed JSON body is a 400.

import type { IncomingHttpHeaders } from 'node:http';
import { type Store, type Repo, type Issue, type Pull, type Label } from './store.ts';
import { parseCommit } from './git.ts';

export interface RestResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly headers?: Readonly<Record<string, string>>;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function json(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): RestResponse {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), headers };
}

function noContent(status: number, headers: Readonly<Record<string, string>> = {}): RestResponse {
  return { status, contentType: JSON_TYPE, body: Buffer.alloc(0), headers };
}

function notFound(message = 'Not Found'): RestResponse {
  return json(404, { message });
}

function badRequest(message: string): RestResponse {
  return json(400, { message });
}

function unauthorized(): RestResponse {
  return json(401, { message: 'Requires authentication' });
}

/** The token the env gave this entry (MAKEFUN_SHOP_TOKEN), or '' when unset. */
function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/** Whether the request's bearer token is the shop token. */
function isAuthenticated(headers: IncomingHttpHeaders): boolean {
  const token = shopToken();
  const authorization = headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(authorization);
  if (match === null) return false;
  const presented = match[1] as string;
  if (token === '') return presented !== '';
  return presented === token;
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewer.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: label.name, name: label.name, color: label.color, description: label.description };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: { login: store.viewer.login, id: store.viewer.id },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: store.viewer.login, id: store.viewer.id },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Parse a JSON request body, or return null when it is malformed. */
function parseBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Build a pagination Link header for a list, from the request's host. */
function pageLinks(headers: IncomingHttpHeaders, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string | null {
  const host = headers.host ?? 'localhost';
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return null;
  const build = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `http://${host}${path}?${q.toString()}`;
  };
  return `<${build(page + 1)}>; rel="next", <${build(lastPage)}>; rel="last"`;
}

function pageOf<T>(items: readonly T[], query: URLSearchParams): { page: T[]; pageNumber: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const pageNumber = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const start = (pageNumber - 1) * perPage;
  return { page: items.slice(start, start + perPage), pageNumber, perPage };
}

/**
 * Route one REST request. `segments` are the path parts after `/api/v3`. Returns a response, or
 * null when the path is not a REST route at all.
 */
export function handleRest(
  store: Store,
  method: string,
  segments: readonly string[],
  query: URLSearchParams,
  headers: IncomingHttpHeaders,
  body: Buffer,
): RestResponse | null {
  if (!isAuthenticated(headers)) return unauthorized();

  // GET /api/v3/ — the API root.
  if (method === 'GET' && segments.length === 0) {
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (method === 'GET' && segments.length === 1 && segments[0] === 'meta') {
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_enterprise_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (method === 'GET' && segments.length === 1 && segments[0] === 'user') {
    const viewer = store.viewer;
    return json(200, { login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email, type: 'User' });
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.viewerRepos();
      const { page, pageNumber, perPage } = pageOf(repos, query);
      const link = pageLinks(headers, '/api/v3/user/repos', query, pageNumber, perPage, repos.length);
      return json(200, page.map((repo) => repoJson(store, repo)), link !== null ? { link } : {});
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const record = asRecord(parsed.value);
      const name = asString(record.name);
      if (name === '') return json(422, { message: 'Validation Failed: name is required' });
      if (store.getRepo(store.viewer.login, name) !== undefined) {
        return json(422, { message: `Validation Failed: name already exists on this account` });
      }
      const repo = store.createRepo(name, asString(record.description), asBoolean(record.private));
      return json(201, repoJson(store, repo));
    }
    return notFound();
  }

  // Everything below is /api/v3/repos/{owner}/{repo}[/...]
  if (segments.length < 3 || segments[0] !== 'repos') return null;
  const owner = decodeURIComponent(segments[1] as string);
  const repoName = decodeURIComponent(segments[2] as string);
  const repo = store.getRepo(owner, repoName);
  // A repository belongs to the token's login; any other owner is a 404, never a 403.
  if (repo === undefined || owner !== store.viewer.login) return notFound();
  const rest = segments.slice(3);

  // GET/PATCH/DELETE /api/v3/repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(store, repo));
    if (method === 'PATCH') {
      const parsed = parseBody(body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const record = asRecord(parsed.value);
      if (typeof record.description === 'string') repo.description = record.description;
      if (typeof record.private === 'boolean') repo.private = record.private;
      repo.updatedAt = store.nowIso;
      return json(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      return noContent(204);
    }
    return notFound();
  }

  // GET /api/v3/repos/{owner}/{repo}/branches
  if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
    const branches = store.branchNames(repo).map((name) => ({
      name,
      commit: { sha: repo.refs.get(`refs/heads/${name}`) ?? '' },
      protected: false,
    }));
    return json(200, branches);
  }

  // GET /api/v3/repos/{owner}/{repo}/branches/{branch}
  if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
    const branch = decodeURIComponent(rest[1] as string);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return notFound('Branch not found');
    return json(200, { name: branch, commit: { sha: tip }, protected: false });
  }

  // GET /api/v3/repos/{owner}/{repo}/commits
  if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
    const shaParam = query.get('sha');
    const refName = shaParam !== null ? (shaParam.startsWith('refs/') ? shaParam : `refs/heads/${shaParam}`) : `refs/heads/${repo.defaultBranch}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined) return json(200, []);
    const commits = store.commitsFrom(repo, tip).map((oid) => {
      const obj = repo.objects.get(oid);
      const commit = obj !== undefined && obj.type === 'commit' ? parseCommit(obj.data) : null;
      return {
        sha: oid,
        commit: {
          message: commit?.message ?? '',
          author: { name: store.viewer.name, email: store.viewer.email, date: store.nowIso },
          committer: { name: store.viewer.name, email: store.viewer.email, date: store.nowIso },
          tree: { sha: commit?.tree ?? '' },
        },
        parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
      };
    });
    const { page } = pageOf(commits, query);
    return json(200, page);
  }

  // /api/v3/repos/{owner}/{repo}/git/refs[/{ref}]
  if (rest.length >= 2 && rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const parsed = parseBody(body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const record = asRecord(parsed.value);
      const ref = asString(record.ref);
      const sha = asString(record.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
        return json(422, { message: 'Validation Failed: ref and sha are required' });
      }
      if (repo.refs.has(ref)) return json(422, { message: 'Validation Failed: Reference already exists' });
      const obj = repo.objects.get(sha);
      if (obj === undefined || obj.type !== 'commit') return json(422, { message: 'Validation Failed: sha is not a commit' });
      repo.refs.set(ref, sha);
      return json(201, { ref, object: { sha, type: 'commit' }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}` });
    }
    if (method === 'GET' && rest.length > 2) {
      const ref = `refs/${rest.slice(2).map((part) => decodeURIComponent(part)).join('/')}`;
      const oid = repo.refs.get(ref);
      if (oid === undefined) return notFound('Reference does not exist');
      const obj = repo.objects.get(oid);
      return json(200, { ref, object: { sha: oid, type: obj?.type ?? 'commit' }, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}` });
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{repo}/contents/{path}
  if (rest.length >= 2 && rest[0] === 'contents') {
    const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
    const refParam = query.get('ref');
    const refName = refParam !== null ? (refParam.startsWith('refs/') ? refParam : `refs/heads/${refParam}`) : `refs/heads/${repo.defaultBranch}`;
    if (method === 'GET') {
      const tip = repo.refs.get(refName);
      if (tip === undefined) return notFound();
      const treeOid = store.treeOf(repo, tip);
      if (treeOid === undefined) return notFound();
      const file = store.fileAt(repo, refName, path);
      if (file !== undefined) {
        return json(200, {
          type: 'file',
          encoding: 'base64',
          content: file.data.toString('base64'),
          sha: file.oid,
          size: file.data.length,
          name: path.split('/').pop() ?? path,
          path,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
        });
      }
      const entries = store.dirAt(repo, refName, path);
      // A path that is neither a file nor a directory does not exist.
      const flat = store.flattenTree(repo, treeOid);
      const isDir = [...flat.keys()].some((p) => p.startsWith(`${path}/`));
      if (!isDir && entries.length === 0) return notFound();
      return json(200, entries.map((entry) => ({
        type: entry.type,
        name: entry.name,
        path: entry.path,
        sha: entry.oid,
        size: entry.type === 'file' ? (repo.objects.get(entry.oid)?.data.length ?? 0) : 0,
        url: `/api/v3/repos/${owner}/${repoName}/contents/${entry.path}`,
      })));
    }
    if (method === 'PUT') {
      const parsed = parseBody(body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const record = asRecord(parsed.value);
      const message = asString(record.message, `Update ${path}`);
      const contentB64 = asString(record.content);
      const branch = asString(record.branch, repo.defaultBranch);
      const sha = typeof record.sha === 'string' ? record.sha : undefined;
      let content: Buffer;
      try {
        content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      } catch {
        return badRequest('content is not valid base64');
      }
      const existing = store.fileAt(repo, `refs/heads/${branch}`, path);
      if (existing !== undefined) {
        if (sha === undefined) return json(422, { message: 'Validation Failed: sha wasn\'t supplied' });
        if (sha !== existing.oid) return json(409, { message: 'Conflict: sha does not match the current file' });
        const { blobOid, commitOid } = store.writeFile(repo, branch, path, content, message);
        return json(200, {
          content: {
            type: 'file',
            encoding: 'base64',
            content: content.toString('base64'),
            sha: blobOid,
            name: path.split('/').pop() ?? path,
            path,
            size: content.length,
            url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
          },
          commit: { sha: commitOid },
        });
      }
      if (sha !== undefined) return json(409, { message: 'Conflict: sha does not match (the file does not exist)' });
      const { blobOid, commitOid } = store.writeFile(repo, branch, path, content, message);
      return json(201, {
        content: {
          type: 'file',
          encoding: 'base64',
          content: content.toString('base64'),
          sha: blobOid,
          name: path.split('/').pop() ?? path,
          path,
          size: content.length,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
        },
        commit: { sha: commitOid },
      });
    }
    if (method === 'DELETE') {
      const parsed = parseBody(body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const record = asRecord(parsed.value);
      const message = asString(record.message, `Delete ${path}`);
      const branch = asString(record.branch, repo.defaultBranch);
      const sha = typeof record.sha === 'string' ? record.sha : undefined;
      const existing = store.fileAt(repo, `refs/heads/${branch}`, path);
      if (existing === undefined) return notFound();
      if (sha !== undefined && sha !== existing.oid) return json(409, { message: 'Conflict: sha does not match the current file' });
      const commitOid = store.deleteFile(repo, branch, path, message);
      if (commitOid === undefined) return notFound();
      return json(200, { commit: { sha: commitOid } });
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{repo}/labels
  if (rest.length >= 1 && rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      return json(200, [...repo.labels.values()].map((label) => labelJson(label)));
    }
    if (method === 'POST' && rest.length === 1) {
      const parsed = parseBody(body);
      if (!parsed.ok) return badRequest('Problems parsing JSON');
      const record = asRecord(parsed.value);
      const name = asString(record.name);
      if (name === '') return json(422, { message: 'Validation Failed: name is required' });
      if (repo.labels.has(name)) return json(422, { message: 'Validation Failed: label already exists' });
      const label: Label = {
        name,
        color: asString(record.color, 'ededed').replace(/^#/, ''),
        description: asString(record.description),
      };
      repo.labels.set(name, label);
      return json(201, labelJson(label));
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{repo}/issues[/{number}[/comments]]
  if (rest.length >= 1 && rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let issues = [...repo.issues.values()];
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        const key = sort === 'updated' ? (issue: Issue): string => issue.updatedAt : (issue: Issue): number => issue.number;
        issues.sort((a, b) => {
          const ka = key(a);
          const kb = key(b);
          const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
          return direction === 'asc' ? cmp : -cmp;
        });
        const { page } = pageOf(issues, query);
        return json(200, page.map((issue) => issueJson(store, repo, issue)));
      }
      if (method === 'POST') {
        const parsed = parseBody(body);
        if (!parsed.ok) return badRequest('Problems parsing JSON');
        const record = asRecord(parsed.value);
        const title = asString(record.title);
        if (title === '') return json(422, { message: 'Validation Failed: title is required' });
        const labels = asStringArray(record.labels);
        for (const label of labels) {
          if (!repo.labels.has(label)) return json(422, { message: `Validation Failed: label ${JSON.stringify(label)} does not exist` });
        }
        const issue = store.createIssue(repo, title, asString(record.body), labels);
        return json(201, issueJson(store, repo, issue));
      }
      return notFound();
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number)) return notFound();
    const issue = repo.issues.get(number);
    if (issue === undefined) return notFound('Issue not found');
    if (rest.length === 2) {
      if (method === 'GET') return json(200, issueJson(store, repo, issue));
      if (method === 'PATCH') {
        const parsed = parseBody(body);
        if (!parsed.ok) return badRequest('Problems parsing JSON');
        const record = asRecord(parsed.value);
        if (typeof record.title === 'string') issue.title = record.title;
        if (typeof record.body === 'string') issue.body = record.body;
        if (typeof record.state === 'string' && (record.state === 'open' || record.state === 'closed')) issue.state = record.state;
        if (Array.isArray(record.labels)) {
          const labels = asStringArray(record.labels);
          for (const label of labels) {
            if (!repo.labels.has(label)) return json(422, { message: `Validation Failed: label ${JSON.stringify(label)} does not exist` });
          }
          issue.labels = labels;
        }
        issue.updatedAt = store.nowIso;
        return json(200, issueJson(store, repo, issue));
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (method === 'GET') {
        return json(200, issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: store.viewer.login, id: store.viewer.id },
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
        })));
      }
      if (method === 'POST') {
        const parsed = parseBody(body);
        if (!parsed.ok) return badRequest('Problems parsing JSON');
        const record = asRecord(parsed.value);
        const commentBody = asString(record.body);
        if (commentBody === '') return json(422, { message: 'Validation Failed: body is required' });
        const comment = store.addComment(repo, issue, commentBody);
        return json(201, {
          id: comment.id,
          body: comment.body,
          user: { login: store.viewer.login, id: store.viewer.id },
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
        });
      }
      return notFound();
    }
    return notFound();
  }

  // /api/v3/repos/{owner}/{repo}/pulls[/{number}[/files|/merge]]
  if (rest.length >= 1 && rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => b.number - a.number);
        const { page } = pageOf(pulls, query);
        return json(200, page.map((pull) => pullJson(store, repo, pull)));
      }
      if (method === 'POST') {
        const parsed = parseBody(body);
        if (!parsed.ok) return badRequest('Problems parsing JSON');
        const record = asRecord(parsed.value);
        const head = asString(record.head);
        const base = asString(record.base);
        const title = asString(record.title);
        if (head === '' || base === '' || title === '') {
          return json(422, { message: 'Validation Failed: head, base and title are required' });
        }
        const headTip = repo.refs.get(`refs/heads/${head}`);
        const baseTip = repo.refs.get(`refs/heads/${base}`);
        if (headTip === undefined || baseTip === undefined) {
          return json(422, { message: 'Validation Failed: head or base branch does not exist' });
        }
        const pull = store.createPull(repo, title, asString(record.body), head, base, headTip, baseTip);
        return json(201, pullJson(store, repo, pull));
      }
      return notFound();
    }
    const number = Number.parseInt(rest[1] as string, 10);
    if (!Number.isInteger(number)) return notFound();
    const pull = repo.pulls.get(number);
    if (pull === undefined) return notFound('Pull request not found');
    if (rest.length === 2 && method === 'GET') return json(200, pullJson(store, repo, pull));
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
      if (baseTip === undefined || headTip === undefined) return json(200, []);
      const mergeBase = store.mergeBase(repo, headTip, baseTip);
      const baseTree = mergeBase !== undefined ? store.treeOf(repo, mergeBase) : store.treeOf(repo, baseTip);
      const headTree = store.treeOf(repo, headTip);
      if (baseTree === undefined || headTree === undefined) return json(200, []);
      const files = store.diffTrees(repo, baseTree, headTree).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        sha: '',
      }));
      return json(200, files);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull.merged) return json(405, { message: 'Pull Request is already merged' });
      if (pull.state === 'closed') return json(405, { message: 'Pull Request is closed' });
      const sha = store.mergePull(repo, pull);
      if (sha === null) return json(405, { message: 'Merge conflict' });
      return json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
    }
    return notFound();
  }

  return null;
}
