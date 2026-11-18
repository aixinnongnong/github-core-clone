// The Model Context Protocol endpoint (JSON-RPC 2.0 over streamable HTTP) at /mcp. The modern
// revision 2026-07-28 is served: `server/discover` answers supportedVersions, `tools/list` offers
// the six tools the suite requires (plus two convenience tools), and `tools/call` executes them
// against the same store the REST surface reads. A legacy `initialize` + `notifications/initialized`
// handshake is answered as a fallback. No Authorization header is a 401; a non-JSON body is an
// HTTP 400 carrying JSON-RPC -32700; an unknown tool is -32601 or -32602, never an HTTP 500; a
// missing required argument is isError:true (or -32602). Two tools/list calls answer the same list
// byte-for-byte, and two concurrent tools/call keep their own JSON-RPC ids.

import { type Store, type Repo } from './store.ts';

export interface McpResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const JSON_TYPE = 'application/json; charset=utf-8';
const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { readonly type: string; readonly description: string }>;
    readonly required: readonly string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        full_name: { type: 'string', description: 'The full name of the repository, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request as one squash commit on its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by its repository and number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner (login) of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        issue_number: { type: 'number', description: 'The number of the issue.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
];

function jsonRpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, 'utf8') };
}

function jsonRpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`, 'utf8') };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function toolOkResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

/** Normalize an argument name the way the suite does: lowercase, non-alphanumerics removed. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Map the arguments the suite passed onto a tool's canonical property names. The suite fills the
 * nearest property by normalized name and synonym; a full_name of "owner/repo" is split into
 * owner and repo when those are missing.
 */
function mapArguments(tool: ToolDef, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const synonyms: Record<string, string[]> = {
    owner: ['owner', 'ownerlogin', 'org', 'organization', 'login'],
    repo: ['repo', 'repository', 'repositoryname', 'name'],
    name: ['name', 'repo', 'repository', 'repositoryname'],
    title: ['title'],
    body: ['body', 'description'],
    description: ['description', 'body'],
    private: ['private'],
    state: ['state'],
    head: ['head', 'headref', 'headbranch', 'headrefname'],
    base: ['base', 'baseref', 'basebranch', 'baserefname'],
    pull_number: ['pullnumber', 'prnumber', 'number', 'pullrequestnumber', 'pr'],
    issue_number: ['issuenumber', 'number', 'issue'],
    full_name: ['fullname', 'full_name'],
  };
  const byNormalized = new Map<string, unknown>();
  for (const [key, value] of Object.entries(raw)) byNormalized.set(normalizeName(key), value);
  for (const property of Object.keys(tool.inputSchema.properties)) {
    const candidates = synonyms[property] ?? [property];
    for (const candidate of candidates) {
      const value = byNormalized.get(normalizeName(candidate));
      if (value !== undefined) {
        out[property] = value;
        break;
      }
    }
  }
  // A full_name of "owner/repo" fills owner and repo when they are missing.
  if ((out.owner === undefined || out.repo === undefined) && typeof out.full_name === 'string') {
    const parts = (out.full_name as string).split('/');
    if (parts.length === 2) {
      if (out.owner === undefined) out.owner = parts[0];
      if (out.repo === undefined) out.repo = parts[1];
    }
  }
  return out;
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: store.viewer.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

/** Execute one tool call. Returns the result object for the tools/call reply. */
function callTool(store: Store, name: string, rawArguments: unknown): Record<string, unknown> {
  const normalized = normalizeName(name);
  const tool = TOOLS.find((candidate) => normalizeName(candidate.name) === normalized || normalized.endsWith(normalizeName(candidate.name)));
  if (tool === undefined) {
    return { __jsonRpcError: { code: -32601, message: `Method not found: ${name}` } } as unknown as Record<string, unknown>;
  }
  const args = mapArguments(tool, (rawArguments ?? {}) as Record<string, unknown>);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolErrorResult(`Missing required argument: ${required}`);
    }
  }
  const owner = String(args.owner ?? store.viewer.login);
  const repoName = String(args.repo ?? '');
  const repo = repoName !== '' ? store.getRepo(owner, repoName) : undefined;

  if (tool.name === 'create_repo') {
    const repoNameArg = String(args.name ?? '');
    if (store.getRepo(store.viewer.login, repoNameArg) !== undefined) {
      return toolErrorResult(`Repository ${store.viewer.login}/${repoNameArg} already exists`);
    }
    const created = store.createRepo(repoNameArg, String(args.description ?? ''), args.private === true);
    return toolOkResult(repoJson(store, created));
  }
  if (tool.name === 'list_repos') {
    return toolOkResult(store.viewerRepos().map((candidate) => repoJson(store, candidate)));
  }
  if (repo === undefined) {
    return toolErrorResult(`Repository ${owner}/${repoName} not found`);
  }
  if (tool.name === 'get_repo') return toolOkResult(repoJson(store, repo));
  if (tool.name === 'create_issue') {
    const issue = store.createIssue(repo, String(args.title ?? ''), String(args.body ?? ''), []);
    return toolOkResult({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: [],
      repository: `${repo.owner}/${repo.name}`,
      full_name: `${repo.owner}/${repo.name}`,
    });
  }
  if (tool.name === 'list_issues') {
    const state = String(args.state ?? 'open');
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    return toolOkResult({
      issues: issues.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((label) => ({ name: label })),
      })),
    });
  }
  if (tool.name === 'get_issue') {
    const number = Number(args.issue_number ?? 0);
    const issue = repo.issues.get(number);
    if (issue === undefined) return toolErrorResult(`Issue ${number} not found`);
    return toolOkResult({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((label) => ({ name: label })),
    });
  }
  if (tool.name === 'create_pull_request') {
    const head = String(args.head ?? '');
    const base = String(args.base ?? '');
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (headTip === undefined || baseTip === undefined) {
      return toolErrorResult('Head or base branch does not exist');
    }
    const pull = store.createPull(repo, String(args.title ?? ''), String(args.body ?? ''), head, base, headTip, baseTip);
    return toolOkResult({
      id: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.state,
      head: { ref: pull.headRef, sha: pull.headSha },
      base: { ref: pull.baseRef, sha: pull.baseSha },
      repository: `${repo.owner}/${repo.name}`,
      full_name: `${repo.owner}/${repo.name}`,
    });
  }
  if (tool.name === 'merge_pull_request') {
    const number = Number(args.pull_number ?? 0);
    const pull = repo.pulls.get(number);
    if (pull === undefined) return toolErrorResult(`Pull request ${number} not found`);
    if (pull.merged) return toolErrorResult(`Pull request ${number} is already merged`);
    const sha = store.mergePull(repo, pull);
    if (sha === null) return toolErrorResult('Merge conflict');
    return toolOkResult({ merged: true, sha, message: 'Pull Request successfully merged', number: pull.number });
  }
  return toolErrorResult(`Tool ${tool.name} is not implemented`);
}

/**
 * Handle POST /mcp. Returns a response, or null when the path is not the MCP route at all.
 * `method` must be POST; other methods are a 405 JSON-RPC error.
 */
export function handleMcp(
  store: Store,
  method: string,
  headers: { authorization?: string },
  body: Buffer,
): McpResponse | null {
  if (method !== 'POST') {
    return jsonRpcError(null, -32600, 'Invalid Request: MCP requires POST', 405);
  }
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
    return jsonRpcError(null, -32700, 'Parse error', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const methodName = String(request.method ?? '');

  // A notification (no id) is answered with 202 and no body.
  if (id === null && (methodName === 'notifications/initialized' || methodName.startsWith('notifications/'))) {
    return { status: 202, contentType: JSON_TYPE, body: Buffer.alloc(0) };
  }

  if (methodName === 'server/discover') {
    return jsonRpcResult(id, {
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: SUPPORTED_VERSIONS,
    });
  }
  if (methodName === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const offered = String(params.protocolVersion ?? '');
    const protocolVersion = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return jsonRpcResult(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (methodName === 'notifications/initialized') {
    return { status: 202, contentType: JSON_TYPE, body: Buffer.alloc(0) };
  }
  if (methodName === 'tools/list') {
    // The same list every time, byte-for-byte: the frozen TOOLS array, serialized the same way.
    return jsonRpcResult(id, { tools: TOOLS });
  }
  if (methodName === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const toolName = String(params.name ?? '');
    const args = params.arguments ?? {};
    const result = callTool(store, toolName, args);
    const rpcError = (result as { __jsonRpcError?: { code: number; message: string } }).__jsonRpcError;
    if (rpcError !== undefined) return jsonRpcError(id, rpcError.code, rpcError.message);
    return jsonRpcResult(id, result);
  }
  return jsonRpcError(id, -32601, `Method not found: ${methodName}`);
}
