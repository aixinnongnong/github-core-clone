// The forge's HTTP server: one process, one store, four surfaces on one base URL.
//   GET  /healthz                       the env's boot probe: 200 {"ok":true}
//   /{owner}/{repo}.git/...            git smart HTTP (upload-pack v2/v0, receive-pack v0)
//   /api/v3/...                        GitHub REST v3
//   POST /api/graphql                  GitHub GraphQL v4
//   POST /mcp                          Model Context Protocol over streamable HTTP
//   anything else                      404 {"message":"Not Found"}
// Every JSON reply carries a non-empty X-GitHub-Request-Id. A request handler never throws out
// of the server: an unexpected error is a 500 JSON body, never an HTML page and never a dropped
// connection.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleGit } from './gitproto.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Read a request body fully, as a buffer (empty when there is none). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Answer with a body and headers; `extra` go beside the JSON ones. */
function send(res: ServerResponse, status: number, contentType: string, body: Buffer, extra: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...extra });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  send(res, status, JSON_TYPE, Buffer.from(text, 'utf8'), extra);
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);
      const requestId = store.nextRequestIdValue();
      const jsonHeaders = { 'x-github-request-id': requestId };
      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, jsonHeaders);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs, /git-upload-pack, /git-receive-pack.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const sub = gitMatch[3] ?? '/';
          const body = await readBody(req);
          const result = await handleGit(store, method, owner, repoName, sub, query, req.headers, body);
          if (result !== null) {
            const extra = result.contentType.startsWith('application/json') ? jsonHeaders : {};
            send(res, result.status, result.contentType, result.body, extra);
            return;
          }
        }

        // GitHub GraphQL v4.
        if (path === '/api/graphql') {
          const body = await readBody(req);
          const result = handleGraphQL(store, method, req.headers, body);
          if (result !== null) {
            send(res, result.status, result.contentType, result.body, jsonHeaders);
            return;
          }
        }

        // Model Context Protocol.
        if (path === '/mcp') {
          const body = await readBody(req);
          const result = handleMcp(store, method, req.headers, body);
          if (result !== null) {
            send(res, result.status, result.contentType, result.body, jsonHeaders);
            return;
          }
        }

        // GitHub REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path === '/api/v3' ? [] : path.slice('/api/v3/'.length).split('/').filter((part) => part !== '');
          const body = await readBody(req);
          const result = handleRest(store, method, segments, query, req.headers, body);
          if (result !== null) {
            send(res, result.status, result.contentType, result.body, { ...jsonHeaders, ...(result.headers ?? {}) });
            return;
          }
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, jsonHeaders);
      } catch (err) {
        process.stderr.write(`[entry] request ${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, jsonHeaders);
        else res.end();
      }
    })();
  });
}
