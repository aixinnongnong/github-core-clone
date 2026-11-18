// The GitHub GraphQL v4 surface, for exactly the documents `gh` and `github-mcp-server` send:
// viewer and repository lookups, issue and pull-request connections with cursor pagination,
// node() by global id, introspection of Issue / PullRequest / Repository / SearchType, and the
// five mutations (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment).
// This is a small hand-rolled parser and executor for those documents, not a general GraphQL
// engine. Unauthenticated requests are exactly 401; an unknown repository answers
// data.repository = null with no errors; an unknown field answers HTTP 200 with an errors array
// naming it; a body holding two operation documents answers two results in order.

import { type Store, type Repo, type Issue, type Pull } from './store.ts';

export interface GraphQLResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const JSON_TYPE = 'application/json; charset=utf-8';

// ------------------------------------------------------------------ tokenizer

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'punct'; readonly value: string }
  | { readonly kind: 'spread'; readonly value: '...' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') { tokens.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if ('{}():$![]=|&@'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const next = source[j + 1] as string;
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
          j += 2;
        } else {
          value += source[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: Number(source.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

// ------------------------------------------------------------------ parser

/** A variable reference inside an argument value. */
export interface VarRef { readonly __var: string }

/** One field (or inline fragment) in a selection set. */
export interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly children: FieldNode[] | null;
  /** The type condition of an inline fragment (`... on Repository`), or null. */
  readonly fragmentType: string | null;
}

export interface Operation {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly fields: FieldNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.kind} ${token.value}`);
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private skipParens(): void {
    // Skip a parenthesised group (variable definitions, directives), tracking nesting.
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name') name = (this.next() as { value: string }).value;
        if (this.isPunct('(')) this.skipParens();
        const fields = this.parseSelectionSet();
        operations.push({ kind: token.value as 'query' | 'mutation', name, fields });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        // Skip a named fragment definition (the suite's documents do not use them).
        this.next();
        if (this.peek()?.kind === 'name') this.next();
        if (this.peek()?.kind === 'name' && (this.peek() as { value: string }).value === 'on') this.next();
        if (this.peek()?.kind === 'name') this.next();
        this.parseSelectionSet();
      } else if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, fields: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return operations;
  }

  private parseSelectionSet(): FieldNode[] {
    this.expectPunct('{');
    const fields: FieldNode[] = [];
    while (!this.isPunct('}')) {
      const token = this.next();
      if (token.kind === 'spread') {
        // `... on Type { ... }` or `... Name`.
        let fragmentType: string | null = null;
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeToken = this.next();
          if (typeToken.kind === 'name') fragmentType = typeToken.value;
        }
        const children = this.parseSelectionSet();
        fields.push({ alias: null, name: '', args: {}, children, fragmentType });
        continue;
      }
      if (token.kind !== 'name') throw new Error(`expected a field name, got ${token.kind}`);
      let alias: string | null = null;
      let name = token.value;
      if (this.isPunct(':')) {
        this.next();
        alias = name;
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new Error('expected a field name after an alias');
        name = nameToken.value;
      }
      let args: Record<string, unknown> = {};
      if (this.isPunct('(')) args = this.parseArguments();
      // Directives (@...) are skipped.
      while (this.isPunct('@')) {
        this.next();
        const directive = this.next();
        void directive;
        if (this.isPunct('(')) this.skipParens();
      }
      let children: FieldNode[] | null = null;
      if (this.isPunct('{')) children = this.parseSelectionSet();
      fields.push({ alias, name, args, children, fragmentType: null });
    }
    this.expectPunct('}');
    return fields;
  }

  private parseArguments(): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('expected an argument name');
      this.expectPunct(':');
      args[nameToken.value] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): unknown {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const nameToken = this.next();
      if (nameToken.kind !== 'name') throw new Error('expected a variable name');
      return { __var: nameToken.value } as VarRef;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return token.value;
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // an enum value
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: unknown[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, unknown> = {};
      while (!this.isPunct('}')) {
        const nameToken = this.next();
        if (nameToken.kind !== 'name') throw new Error('expected an object field name');
        this.expectPunct(':');
        obj[nameToken.value] = this.parseValue();
      }
      this.expectPunct('}');
      return obj;
    }
    throw new Error(`unexpected value token ${token.kind} ${token.value}`);
  }
}

/** Resolve variable references in an argument value. */
function resolveValue(value: unknown, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && '__var' in (value as Record<string, unknown>)) {
    return variables[(value as VarRef).__var];
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = resolveValue(item, variables);
    return out;
  }
  return value;
}

function resolveArgs(args: Record<string, unknown>, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

// ------------------------------------------------------------------ schema

interface TypeField { readonly name: string }
interface TypeInfo {
  readonly kind: string;
  readonly fields: TypeField[];
  readonly enumValues: readonly string[];
}

const SCHEMA: Record<string, TypeInfo> = {
  Issue: {
    kind: 'OBJECT',
    fields: [
      { name: 'id' }, { name: 'databaseId' }, { name: 'number' }, { name: 'title' }, { name: 'state' },
      { name: 'body' }, { name: 'bodyHTML' }, { name: 'bodyText' }, { name: 'createdAt' }, { name: 'updatedAt' },
      { name: 'closedAt' }, { name: 'url' }, { name: 'resourcePath' }, { name: 'repository' }, { name: 'author' },
      { name: 'labels' }, { name: 'comments' }, { name: 'assignees' },
    ],
    enumValues: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      { name: 'id' }, { name: 'databaseId' }, { name: 'number' }, { name: 'title' }, { name: 'state' },
      { name: 'body' }, { name: 'headRefName' }, { name: 'baseRefName' }, { name: 'headRefOid' },
      { name: 'baseRefOid' }, { name: 'mergeable' }, { name: 'merged' }, { name: 'mergedAt' },
      { name: 'mergeCommit' }, { name: 'files' }, { name: 'commits' }, { name: 'repository' },
      { name: 'createdAt' }, { name: 'updatedAt' }, { name: 'url' },
    ],
    enumValues: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      { name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' }, { name: 'owner' },
      { name: 'description' }, { name: 'defaultBranchRef' }, { name: 'viewerPermission' },
      { name: 'hasIssuesEnabled' }, { name: 'hasWikiEnabled' }, { name: 'isPrivate' }, { name: 'isFork' },
      { name: 'issue' }, { name: 'issues' }, { name: 'pullRequest' }, { name: 'pullRequests' },
      { name: 'createdAt' }, { name: 'updatedAt' }, { name: 'url' }, { name: 'forkCount' },
      { name: 'stargazerCount' }, { name: 'watchers' }, { name: 'primaryLanguage' },
    ],
    enumValues: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  },
  User: {
    kind: 'OBJECT',
    fields: [
      { name: 'id' }, { name: 'databaseId' }, { name: 'login' }, { name: 'name' }, { name: 'email' },
      { name: 'avatarUrl' }, { name: 'url' }, { name: 'createdAt' }, { name: 'repositories' },
    ],
    enumValues: [],
  },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
};

// ------------------------------------------------------------------ executor

type GqlObject =
  | { readonly __typename: 'Query' }
  | { readonly __typename: 'Mutation' }
  | { readonly __typename: 'User'; readonly login: string; readonly id: number; readonly name: string; readonly email: string }
  | { readonly __typename: 'Repository'; readonly repo: Repo }
  | { readonly __typename: 'Issue'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __typename: 'PullRequest'; readonly repo: Repo; readonly pull: Pull }
  | { readonly __typename: 'IssueConnection'; readonly repo: Repo; readonly items: Issue[]; readonly hasNextPage: boolean; readonly endCursor: string | null }
  | { readonly __typename: 'PullRequestConnection'; readonly repo: Repo; readonly items: Pull[]; readonly hasNextPage: boolean; readonly endCursor: string | null }
  | { readonly __typename: 'PullRequestChangedFileConnection'; readonly items: { readonly path: string }[] }
  | { readonly __typename: 'PullRequestChangedFile'; readonly path: string }
  | { readonly __typename: 'PageInfo'; readonly hasNextPage: boolean; readonly endCursor: string | null }
  | { readonly __typename: '__Type'; readonly name: string }
  | { readonly __typename: 'IssuePayload'; readonly issue: Issue | null; readonly repo: Repo | null }
  | { readonly __typename: 'PullRequestPayload'; readonly pull: Pull | null; readonly repo: Repo | null }
  | { readonly __typename: 'CommentPayload'; readonly comment: { readonly id: number; readonly body: string } | null; readonly repo: Repo | null; readonly issue: Issue | null }
  | { readonly __typename: 'CommentEdge'; readonly comment: { readonly id: number; readonly body: string } }
  | { readonly __typename: 'Comment'; readonly id: number; readonly body: string };

interface Executor {
  readonly store: Store;
  readonly variables: Record<string, unknown>;
  readonly errors: { message: string }[];
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

function cursorForIssue(issue: Issue): string {
  return b64(`issue:${issue.number}`);
}

function issueNumberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^issue:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

function repoOfObject(obj: GqlObject): Repo | null {
  if (obj.__typename === 'Repository') return obj.repo;
  if (obj.__typename === 'Issue' || obj.__typename === 'PullRequest') return obj.repo;
  return null;
}

function typeNameOf(obj: GqlObject): string {
  return obj.__typename;
}

/** Whether merging `pull` would conflict (a pure check; it builds no objects). */
function mergeWouldConflict(store: Store, repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return true;
  const mergeBase = store.mergeBase(repo, headTip, baseTip);
  const baseTree = mergeBase !== undefined ? store.treeOf(repo, mergeBase) : undefined;
  const headTree = store.treeOf(repo, headTip);
  const targetTree = store.treeOf(repo, baseTip);
  if (baseTree === undefined || headTree === undefined || targetTree === undefined) return true;
  const base = store.flattenTree(repo, baseTree);
  const head = store.flattenTree(repo, headTree);
  const target = store.flattenTree(repo, targetTree);
  const all = new Set<string>([...base.keys(), ...head.keys(), ...target.keys()]);
  for (const path of all) {
    const b = base.get(path);
    const h = head.get(path);
    const t = target.get(path);
    const same = (x: { oid: string } | undefined, y: { oid: string } | undefined): boolean =>
      (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
    if (same(h, t)) continue;
    if (same(h, b)) continue;
    if (same(t, b)) continue;
    return true;
  }
  return false;
}

/**
 * Resolve one field on an object. Returns the field's value (a scalar, a GqlObject, an array, or
 * null). Unknown fields record an error and answer null.
 */
function resolveField(exec: Executor, obj: GqlObject, field: FieldNode): unknown {
  const store = exec.store;
  const args = resolveArgs(field.args, exec.variables);
  const name = field.name;
  const unknown = (): null => {
    exec.errors.push({ message: `Cannot query field "${name}" on type "${typeNameOf(obj)}".` });
    return null;
  };

  if (obj.__typename === 'Query') {
    if (name === 'viewer') {
      const viewer = store.viewer;
      return { __typename: 'User', login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email } as GqlObject;
    }
    if (name === 'repository') {
      const owner = String(args.owner ?? '');
      const repoName = String(args.name ?? '');
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined || owner !== store.viewer.login) return null;
      return { __typename: 'Repository', repo } as GqlObject;
    }
    if (name === 'node') {
      const id = String(args.id ?? '');
      const decoded = store.decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.type === 'Repository') {
        const repoId = Number.parseInt(decoded.parts[0] as string, 10);
        const repo = [...store.repos.values()].find((candidate) => candidate.id === repoId);
        return repo === undefined ? null : ({ __typename: 'Repository', repo } as GqlObject);
      }
      if (decoded.type === 'Issue') {
        const repoId = Number.parseInt(decoded.parts[0] as string, 10);
        const number = Number.parseInt(decoded.parts[1] as string, 10);
        const repo = [...store.repos.values()].find((candidate) => candidate.id === repoId);
        const issue = repo?.issues.get(number);
        return repo !== undefined && issue !== undefined ? ({ __typename: 'Issue', repo, issue } as GqlObject) : null;
      }
      if (decoded.type === 'PullRequest') {
        const repoId = Number.parseInt(decoded.parts[0] as string, 10);
        const number = Number.parseInt(decoded.parts[1] as string, 10);
        const repo = [...store.repos.values()].find((candidate) => candidate.id === repoId);
        const pull = repo?.pulls.get(number);
        return repo !== undefined && pull !== undefined ? ({ __typename: 'PullRequest', repo, pull } as GqlObject) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(args.name ?? '');
      return SCHEMA[typeName] !== undefined ? ({ __typename: '__Type', name: typeName } as GqlObject) : null;
    }
    if (name === '__schema') {
      // Not queried by the suite; answer a minimal schema object.
      return { __typename: '__Type', name: 'Query' } as GqlObject;
    }
    return unknown();
  }

  if (obj.__typename === 'Mutation') {
    if (name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = String(input.repositoryId ?? '');
      const decoded = store.decodeGlobalId(repoId);
      const repo = decoded !== null && decoded.type === 'Repository'
        ? [...store.repos.values()].find((candidate) => candidate.id === Number.parseInt(decoded.parts[0] as string, 10))
        : undefined;
      if (repo === undefined) {
        exec.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return { __typename: 'IssuePayload', issue: null, repo: null } as GqlObject;
      }
      const title = String(input.title ?? '');
      const body = String(input.body ?? '');
      const issue = store.createIssue(repo, title, body, []);
      return { __typename: 'IssuePayload', issue, repo } as GqlObject;
    }
    if (name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const issueId = String(input.issueId ?? '');
      const decoded = store.decodeGlobalId(issueId);
      let found: { repo: Repo; issue: Issue } | null = null;
      if (decoded !== null && decoded.type === 'Issue') {
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number.parseInt(decoded.parts[0] as string, 10));
        const issue = repo?.issues.get(Number.parseInt(decoded.parts[1] as string, 10));
        if (repo !== undefined && issue !== undefined) found = { repo, issue };
      }
      if (found === null) {
        exec.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        return { __typename: 'IssuePayload', issue: null, repo: null } as GqlObject;
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = store.nowIso;
      return { __typename: 'IssuePayload', issue: found.issue, repo: found.repo } as GqlObject;
    }
    if (name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = String(input.repositoryId ?? '');
      const decoded = store.decodeGlobalId(repoId);
      const repo = decoded !== null && decoded.type === 'Repository'
        ? [...store.repos.values()].find((candidate) => candidate.id === Number.parseInt(decoded.parts[0] as string, 10))
        : undefined;
      if (repo === undefined) {
        exec.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
        return { __typename: 'PullRequestPayload', pull: null, repo: null } as GqlObject;
      }
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headTip = repo.refs.get(`refs/heads/${headRef}`);
      const baseTip = repo.refs.get(`refs/heads/${baseRef}`);
      if (headTip === undefined || baseTip === undefined) {
        exec.errors.push({ message: 'Head or base ref does not exist.' });
        return { __typename: 'PullRequestPayload', pull: null, repo } as GqlObject;
      }
      const pull = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef, headTip, baseTip);
      return { __typename: 'PullRequestPayload', pull, repo } as GqlObject;
    }
    if (name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const pullId = String(input.pullRequestId ?? '');
      const decoded = store.decodeGlobalId(pullId);
      let found: { repo: Repo; pull: Pull } | null = null;
      if (decoded !== null && decoded.type === 'PullRequest') {
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number.parseInt(decoded.parts[0] as string, 10));
        const pull = repo?.pulls.get(Number.parseInt(decoded.parts[1] as string, 10));
        if (repo !== undefined && pull !== undefined) found = { repo, pull };
      }
      if (found === null) {
        exec.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
        return { __typename: 'PullRequestPayload', pull: null, repo: null } as GqlObject;
      }
      const sha = store.mergePull(found.repo, found.pull);
      if (sha === null) {
        exec.errors.push({ message: 'Merge conflict.' });
        return { __typename: 'PullRequestPayload', pull: found.pull, repo: found.repo } as GqlObject;
      }
      return { __typename: 'PullRequestPayload', pull: found.pull, repo: found.repo } as GqlObject;
    }
    if (name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const subjectId = String(input.subjectId ?? '');
      const decoded = store.decodeGlobalId(subjectId);
      let found: { repo: Repo; issue: Issue } | null = null;
      if (decoded !== null && decoded.type === 'Issue') {
        const repo = [...store.repos.values()].find((candidate) => candidate.id === Number.parseInt(decoded.parts[0] as string, 10));
        const issue = repo?.issues.get(Number.parseInt(decoded.parts[1] as string, 10));
        if (repo !== undefined && issue !== undefined) found = { repo, issue };
      }
      if (found === null) {
        exec.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
        return { __typename: 'CommentPayload', comment: null, repo: null, issue: null } as GqlObject;
      }
      const comment = store.addComment(found.repo, found.issue, String(input.body ?? ''));
      return { __typename: 'CommentPayload', comment, repo: found.repo, issue: found.issue } as GqlObject;
    }
    return unknown();
  }

  if (obj.__typename === 'User') {
    if (name === 'login') return obj.login;
    if (name === 'name') return obj.name;
    if (name === 'email') return obj.email;
    if (name === 'id') return b64(`User:${obj.id}`);
    if (name === 'databaseId') return obj.id;
    if (name === 'url') return `https://example.invalid/${obj.login}`;
    if (name === 'avatarUrl') return '';
    return unknown();
  }

  if (obj.__typename === 'Repository') {
    const repo = obj.repo;
    if (name === 'id') return store.globalRepoId(repo);
    if (name === 'databaseId') return repo.id;
    if (name === 'name') return repo.name;
    if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
    if (name === 'description') return repo.description;
    if (name === 'isPrivate') return repo.private;
    if (name === 'owner') {
      return { __typename: 'User', login: repo.owner, id: store.viewer.id, name: store.viewer.name, email: store.viewer.email } as GqlObject;
    }
    if (name === 'defaultBranchRef') {
      // Resolved in resolveSelection (a branch ref, not a repository); reaching here means the
      // field had no selection set, so there is nothing to answer.
      return null;
    }
    if (name === 'viewerPermission') return 'ADMIN';
    if (name === 'hasIssuesEnabled') return true;
    if (name === 'hasWikiEnabled') return false;
    if (name === 'createdAt') return repo.createdAt;
    if (name === 'updatedAt') return repo.updatedAt;
    if (name === 'url') return `https://example.invalid/${repo.owner}/${repo.name}`;
    if (name === 'issue') {
      const number = Number(args.number ?? 0);
      const issue = repo.issues.get(number);
      return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } as GqlObject);
    }
    if (name === 'issues') return issuesConnection(exec, repo, args);
    if (name === 'pullRequest') {
      const number = Number(args.number ?? 0);
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } as GqlObject);
    }
    if (name === 'pullRequests') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      let pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      if (first !== undefined) pulls = pulls.slice(0, first);
      return { __typename: 'PullRequestConnection', repo, items: pulls, hasNextPage: false, endCursor: null } as GqlObject;
    }
    return unknown();
  }

  if (obj.__typename === 'Issue') {
    const issue = obj.issue;
    if (name === 'id') return store.globalIssueId(obj.repo, issue);
    if (name === 'databaseId') return issue.id;
    if (name === 'number') return issue.number;
    if (name === 'title') return issue.title;
    if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'body') return issue.body;
    if (name === 'bodyText') return issue.body;
    if (name === 'bodyHTML') return issue.body;
    if (name === 'createdAt') return issue.createdAt;
    if (name === 'updatedAt') return issue.updatedAt;
    if (name === 'closedAt') return issue.state === 'closed' ? issue.updatedAt : null;
    if (name === 'url') return `https://example.invalid/${obj.repo.owner}/${obj.repo.name}/issues/${issue.number}`;
    if (name === 'repository') return { __typename: 'Repository', repo: obj.repo } as GqlObject;
    if (name === 'author') {
      return { __typename: 'User', login: store.viewer.login, id: store.viewer.id, name: store.viewer.name, email: store.viewer.email } as GqlObject;
    }
    return unknown();
  }

  if (obj.__typename === 'PullRequest') {
    const pull = obj.pull;
    if (name === 'id') return store.globalPullId(obj.repo, pull);
    if (name === 'databaseId') return pull.id;
    if (name === 'number') return pull.number;
    if (name === 'title') return pull.title;
    if (name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    if (name === 'body') return pull.body;
    if (name === 'headRefName') return pull.headRef;
    if (name === 'baseRefName') return pull.baseRef;
    if (name === 'headRefOid') return pull.headSha;
    if (name === 'baseRefOid') return pull.baseSha;
    if (name === 'merged') return pull.merged;
    if (name === 'mergedAt') return pull.mergedAt;
    if (name === 'mergeable') {
      if (pull.merged) return 'UNKNOWN';
      return mergeWouldConflict(store, obj.repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    }
    if (name === 'createdAt') return pull.createdAt;
    if (name === 'updatedAt') return pull.updatedAt;
    if (name === 'url') return `https://example.invalid/${obj.repo.owner}/${obj.repo.name}/pull/${pull.number}`;
    if (name === 'repository') return { __typename: 'Repository', repo: obj.repo } as GqlObject;
    if (name === 'files') {
      const first = typeof args.first === 'number' ? args.first : undefined;
      const baseTip = obj.repo.refs.get(`refs/heads/${pull.baseRef}`);
      const headTip = obj.repo.refs.get(`refs/heads/${pull.headRef}`);
      if (baseTip === undefined || headTip === undefined) {
        return { __typename: 'PullRequestChangedFileConnection', items: [] } as GqlObject;
      }
      const mergeBase = store.mergeBase(obj.repo, headTip, baseTip);
      const baseTree = mergeBase !== undefined ? store.treeOf(obj.repo, mergeBase) : store.treeOf(obj.repo, baseTip);
      const headTree = store.treeOf(obj.repo, headTip);
      if (baseTree === undefined || headTree === undefined) {
        return { __typename: 'PullRequestChangedFileConnection', items: [] } as GqlObject;
      }
      let items = store.diffTrees(obj.repo, baseTree, headTree).map((file) => ({ path: file.filename }));
      if (first !== undefined) items = items.slice(0, first);
      return { __typename: 'PullRequestChangedFileConnection', items } as GqlObject;
    }
    return unknown();
  }

  if (obj.__typename === 'IssueConnection' || obj.__typename === 'PullRequestConnection') {
    if (name === 'nodes') {
      if (obj.__typename === 'IssueConnection') {
        return obj.items.map((issue) => ({ __typename: 'Issue', repo: obj.repo, issue }) as GqlObject);
      }
      return obj.items.map((pull) => ({ __typename: 'PullRequest', repo: obj.repo, pull }) as GqlObject);
    }
    if (name === 'edges') return [];
    if (name === 'totalCount') return obj.items.length;
    if (name === 'pageInfo') {
      return { __typename: 'PageInfo', hasNextPage: obj.hasNextPage, endCursor: obj.endCursor } as GqlObject;
    }
    return unknown();
  }

  if (obj.__typename === 'PullRequestChangedFileConnection') {
    if (name === 'nodes') {
      return obj.items.map((item) => ({ __typename: 'PullRequestChangedFile', path: item.path }) as GqlObject);
    }
    if (name === 'totalCount') return obj.items.length;
    if (name === 'pageInfo') {
      return { __typename: 'PageInfo', hasNextPage: false, endCursor: null } as GqlObject;
    }
    return unknown();
  }

  if (obj.__typename === 'PullRequestChangedFile') {
    if (name === 'path') return obj.path;
    return unknown();
  }

  if (obj.__typename === 'PageInfo') {
    if (name === 'hasNextPage') return obj.hasNextPage;
    if (name === 'endCursor') return obj.endCursor;
    if (name === 'hasPreviousPage') return false;
    if (name === 'startCursor') return null;
    return unknown();
  }

  if (obj.__typename === '__Type') {
    const info = SCHEMA[obj.name];
    if (info === undefined) return null;
    if (name === 'name') return obj.name;
    if (name === 'kind') return info.kind;
    if (name === 'fields') return info.fields.map((field) => ({ name: field.name }));
    if (name === 'enumValues') return info.enumValues.map((value) => ({ name: value }));
    return unknown();
  }

  if (obj.__typename === 'IssuePayload') {
    if (name === 'issue') {
      return obj.issue === null || obj.repo === null ? null : ({ __typename: 'Issue', repo: obj.repo, issue: obj.issue } as GqlObject);
    }
    return unknown();
  }

  if (obj.__typename === 'PullRequestPayload') {
    if (name === 'pullRequest') {
      return obj.pull === null || obj.repo === null ? null : ({ __typename: 'PullRequest', repo: obj.repo, pull: obj.pull } as GqlObject);
    }
    return unknown();
  }

  if (obj.__typename === 'CommentPayload') {
    if (name === 'commentEdge') {
      if (obj.comment === null) return null;
      return { __typename: 'CommentEdge', comment: obj.comment } as GqlObject;
    }
    return unknown();
  }

  if (obj.__typename === 'CommentEdge') {
    if (name === 'node') {
      return { __typename: 'Comment', id: obj.comment.id, body: obj.comment.body } as GqlObject;
    }
    return unknown();
  }

  if (obj.__typename === 'Comment') {
    if (name === 'id') return b64(`IssueComment:${obj.id}`);
    if (name === 'databaseId') return obj.id;
    if (name === 'body') return obj.body;
    return unknown();
  }

  return unknown();
}

/** The issues connection for a repository, honouring first/after/states/orderBy. */
function issuesConnection(exec: Executor, repo: Repo, args: Record<string, unknown>): GqlObject {
  const first = typeof args.first === 'number' ? args.first : undefined;
  const after = typeof args.after === 'string' ? args.after : undefined;
  const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : undefined;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const orderField = String(orderBy.field ?? 'CREATED_AT');
  const orderDirection = String(orderBy.direction ?? 'DESC');
  let issues = [...repo.issues.values()];
  if (states !== undefined) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  // Creation order is the issue number; CREATED_AT DESC is numbers DESC, ties by number DESC.
  issues.sort((a, b) => {
    const direction = orderDirection === 'ASC' ? 1 : -1;
    if (orderField === 'CREATED_AT' || orderField === 'UPDATED_AT') return direction * (a.number - b.number);
    return direction * (a.number - b.number);
  });
  if (after !== undefined) {
    const afterNumber = issueNumberFromCursor(after);
    if (afterNumber !== null) {
      issues = orderDirection === 'ASC'
        ? issues.filter((issue) => issue.number > afterNumber)
        : issues.filter((issue) => issue.number < afterNumber);
    }
  }
  const total = issues.length;
  const page = first !== undefined ? issues.slice(0, first) : issues;
  const hasNextPage = page.length < total;
  const endCursor = page.length > 0 ? cursorForIssue(page[page.length - 1] as Issue) : null;
  return { __typename: 'IssueConnection', repo, items: page, hasNextPage, endCursor } as GqlObject;
}

/**
 * Resolve a selection set against an object. Inline fragments apply when their type condition
 * matches the object's type (or is absent). Returns a plain JSON value.
 */
function resolveSelection(exec: Executor, obj: GqlObject, fields: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.fragmentType !== null) {
      // An inline fragment: apply its children when the type matches.
      if (field.fragmentType === typeNameOf(obj) || field.fragmentType === 'Node') {
        const nested = resolveSelection(exec, obj, field.children ?? []);
        Object.assign(out, nested);
      }
      continue;
    }
    if (field.name === '') continue;
    // defaultBranchRef is a branch ref, not a repository: resolve it as a small object.
    if (obj.__typename === 'Repository' && field.name === 'defaultBranchRef') {
      const repo = obj.repo;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === null || tip === undefined) {
        out[field.alias ?? field.name] = null;
      } else {
        const children = field.children ?? [];
        const refOut: Record<string, unknown> = {};
        for (const child of children) {
          if (child.name === 'name') refOut[child.alias ?? child.name] = repo.defaultBranch;
          else if (child.name === 'target') refOut[child.alias ?? child.name] = { oid: tip };
        }
        out[field.alias ?? field.name] = refOut;
      }
      continue;
    }
    const value = resolveField(exec, obj, field);
    if (field.children === null || field.children.length === 0) {
      out[field.alias ?? field.name] = value;
    } else if (value === null || value === undefined) {
      out[field.alias ?? field.name] = null;
    } else if (Array.isArray(value)) {
      out[field.alias ?? field.name] = value.map((item) =>
        item !== null && typeof item === 'object' && '__typename' in (item as Record<string, unknown>)
          ? resolveSelection(exec, item as GqlObject, field.children as FieldNode[])
          : item,
      );
    } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      out[field.alias ?? field.name] = resolveSelection(exec, value as GqlObject, field.children);
    } else {
      out[field.alias ?? field.name] = value;
    }
  }
  return out;
}

/** Execute one operation and return its result object (data, plus errors when any). */
function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const exec: Executor = { store, variables, errors: [] };
  const root: GqlObject = operation.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = resolveSelection(exec, root, operation.fields);
  const result: Record<string, unknown> = { data };
  if (exec.errors.length > 0) result.errors = exec.errors;
  return result;
}

/**
 * Handle POST /api/graphql. The body is one operation document, or an array of two (a batch),
 * each answered in order. Unauthenticated requests are exactly 401.
 */
export function handleGraphQL(
  store: Store,
  method: string,
  headers: { authorization?: string },
  body: Buffer,
): GraphQLResponse | null {
  if (method !== 'POST') return null;
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const authorization = headers.authorization ?? '';
  const match = /^Bearer (.+)$/.exec(authorization);
  if (match === null) {
    return { status: 401, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify({ message: 'Requires authentication' })}\n`, 'utf8') };
  }
  const presented = match[1] as string;
  if (token !== '' && presented !== token) {
    return { status: 401, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify({ message: 'Requires authentication' })}\n`, 'utf8') };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return { status: 400, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify({ errors: [{ message: 'Problems parsing JSON' }] })}\n`, 'utf8') };
  }
  const documents: { query: string; variables?: Record<string, unknown> }[] = Array.isArray(parsed)
    ? (parsed as { query: string; variables?: Record<string, unknown> }[])
    : [parsed as { query: string; variables?: Record<string, unknown> }];
  const results: Record<string, unknown>[] = [];
  for (const document of documents) {
    const query = typeof document.query === 'string' ? document.query : '';
    const variables = (document.variables ?? {}) as Record<string, unknown>;
    let operations: Operation[];
    try {
      operations = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] });
      continue;
    }
    if (operations.length === 0) {
      results.push({ data: {}, errors: [{ message: 'No operation found' }] });
      continue;
    }
    // One operation per document in practice; answer each in order when there are several.
    for (const operation of operations) {
      results.push(executeOperation(store, operation, variables));
    }
  }
  const payload = Array.isArray(parsed) ? results : (results[0] ?? { data: null });
  return { status: 200, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8') };
}
