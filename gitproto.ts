// The git smart-HTTP surface: info/refs advertisements (v0 and v2), upload-pack (v0 and v2,
// ls-refs and fetch) and receive-pack (push). This is the wire contract the suite's client
// speaks, so every byte here follows the client's parser: v0 advertisements open with
// `# service=...`, v2 with `version 2`, ls-refs answers `<oid> <ref>` lines, fetch answers its
// sections in order, and a push is answered with a report-status stream. A missing repository is
// a 404 on GET /info/refs.

import type { IncomingHttpHeaders } from 'node:http';
import {
  type GitObject, ZERO_OID,
  parseCommit, parseTag, parseTree, readPack, writePack, collectReachable,
  pktLine, pktText, PKT_FLUSH, parsePktLines,
} from './git.ts';
import { type Store, type Repo } from './store.ts';

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const AGENT = 'github-core-clone/1.0.0';
const UPLOAD_PACK_V0_CAPS = `side-band-64k ofs-delta thin-pack multi_ack shallow agent=${AGENT} symref=HEAD:refs/heads/main object-format=sha1`;
const RECEIVE_PACK_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main object-format=sha1`;

function jsonResponse(status: number, body: unknown): GitResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8') };
}

/** The refs a repository advertises, in git's order: HEAD first, then heads, then tags. */
function advertisedRefs(repo: Repo): { ref: string; oid: string; peeled?: string }[] {
  const out: { ref: string; oid: string; peeled?: string }[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTip !== undefined) out.push({ ref: 'HEAD', oid: headTip });
  const heads = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
  for (const ref of heads) {
    const oid = repo.refs.get(ref) as string;
    out.push({ ref, oid });
  }
  for (const ref of tags) {
    const oid = repo.refs.get(ref) as string;
    const obj = repo.objects.get(oid);
    let peeled: string | undefined;
    if (obj !== undefined && obj.type === 'tag') peeled = parseTag(obj.data).object;
    out.push({ ref, oid, peeled });
  }
  return out;
}

/** The v0 advertisement for upload-pack or receive-pack. */
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_PACK_V0_CAPS : RECEIVE_PACK_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((entry, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${entry.oid} ${entry.ref}${suffix}\n`));
      if (entry.peeled !== undefined) parts.push(pktLine(`${entry.peeled} ${entry.ref}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 advertisement for upload-pack (the suite requests v2 for upload-pack). */
function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

/** Wrap `data` in sideband band-1 packets, each no larger than a pkt-line allows. */
function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(offset + CHUNK, data.length));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

/**
 * The objects a fetch sends, from the roots the walk selected. A commit contributes its tree
 * (and everything under it) always; its parents are followed only when they are themselves
 * selected (a depth boundary stops the walk); a tag contributes its target. This is what makes a
 * depth-1 fetch carry three objects instead of the whole history.
 */
function fetchObjects(repo: Repo, roots: ReadonlySet<string>, held: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack = [...roots];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (!held.has(oid)) out.set(oid, obj);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) {
        if (roots.has(parent)) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/**
 * The fetch object selection. Returns the objects to send and the shallow-info lines. `wants`
 * are the oids the client asked for, `haves` the oids it already holds, `shallowList` the commits
 * it already considers shallow, and `depth` the deepen limit (undefined for a full fetch).
 */
function computeFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowList: readonly string[],
  depth: number | undefined,
): { sendSet: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const haveSet = new Set(haves);
  const shallowSet = new Set(shallowList);
  // What the client already holds: everything reachable from its haves. A shallow have only
  // contributes the commit itself, its tree and that tree's blobs — never its parents.
  const held = new Set<string>();
  for (const have of haves) {
    const obj = repo.objects.get(have);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (shallowSet.has(have)) {
      const commit = parseCommit(obj.data);
      held.add(have);
      const treeReach = collectReachable([commit.tree], (oid) => repo.objects.get(oid));
      for (const oid of treeReach.keys()) held.add(oid);
    } else {
      const reach = collectReachable([have], (oid) => repo.objects.get(oid));
      for (const oid of reach.keys()) held.add(oid);
    }
  }
  // Walk from the wants. A tag want is sent and its target is walked at the same depth. A have
  // that is not shallow stops the walk; a shallow have is not sent but is walked into (so a deepen
  // can fetch its parents); a commit at or past the depth cutoff is a boundary and is neither sent
  // nor walked.
  const sent = new Set<string>();
  const queue: [string, number][] = wants.map((want) => [want, 0] as [string, number]);
  const visited = new Set<string>();
  while (queue.length > 0) {
    const [oid, gen] = queue.shift() as [string, number];
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      sent.add(oid);
      queue.push([parseTag(obj.data).object, gen]);
      continue;
    }
    if (obj.type !== 'commit') continue;
    const commit = parseCommit(obj.data);
    if (haveSet.has(oid) && !shallowSet.has(oid)) continue;
    if (haveSet.has(oid) && shallowSet.has(oid)) {
      for (const parent of commit.parents) queue.push([parent, gen + 1]);
      continue;
    }
    if (depth !== undefined && gen >= depth) continue;
    sent.add(oid);
    for (const parent of commit.parents) queue.push([parent, gen + 1]);
  }
  // The objects to send: the selected roots' trees and blobs, minus what is held.
  const sendSet = fetchObjects(repo, sent, held);
  // Shallow-info: a sent commit whose parent is not in (haves ∪ sent) is a new boundary; an old
  // shallow commit whose parents are all in (haves ∪ sent) is no longer shallow.
  const inHaveOrSent = new Set<string>([...haveSet, ...sent]);
  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of sent) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((parent) => !inHaveOrSent.has(parent)) && !shallow.includes(oid)) shallow.push(oid);
  }
  for (const oid of shallowList) {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((parent) => inHaveOrSent.has(parent))) unshallow.push(oid);
    else if (!shallow.includes(oid)) shallow.push(oid);
  }
  return { sendSet, shallow, unshallow };
}

/** Answer a v2 ls-refs command. */
function handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') { /* never advertised; nothing to send */ }
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const refs = advertisedRefs(repo);
  for (const entry of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => entry.ref.startsWith(prefix))) continue;
    let line = `${entry.oid} ${entry.ref}`;
    if (symrefs && entry.ref === 'HEAD') line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    if (peel && entry.peeled !== undefined) line += ` peeled:${entry.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Answer a v2 fetch command. */
function handleFetchV2(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowList: string[] = [];
  let depth: number | undefined;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallowList.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  const { sendSet, shallow, unshallow } = computeFetch(repo, wants, haves, shallowList, depth);
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(pktLine('acknowledgments\n'));
  if (haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const have of haves) {
      if (repo.objects.has(have)) parts.push(pktLine(`ACK ${have}\n`));
    }
    parts.push(pktLine('ready\n'));
  }
  parts.push(PKT_FLUSH);
  // shallow-info, only when there is something to say
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  // packfile
  parts.push(pktLine('packfile\n'));
  const pack = writePack(sendSet);
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Answer a v0 upload-pack (fetch) request. */
function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const { lines } = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowList: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    if (line === null) continue;
    const text = line.toString('utf8');
    if (text.startsWith('want ')) {
      const rest = text.slice(5);
      const nul = rest.indexOf('\0');
      wants.push((nul === -1 ? rest : rest.slice(0, nul)).trim());
    } else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallowList.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  const { sendSet, shallow, unshallow } = computeFetch(repo, wants, haves, shallowList, depth);
  const parts: Buffer[] = [];
  if (haves.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const have of haves) {
      if (repo.objects.has(have)) parts.push(pktLine(`ACK ${have}\n`));
    }
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = writePack(sendSet);
  for (const packet of sidebandPackets(pack)) parts.push(packet);
  return Buffer.concat(parts);
}

/** Whether `descendant` is a descendant of `ancestor` (or the same commit). */
function isDescendant(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Answer a receive-pack (push) request. */
async function handleReceivePack(repo: Repo, body: Buffer, headers: IncomingHttpHeaders): Promise<Buffer> {
  const parsed = parsePktLines(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const line of parsed.lines) {
    if (line === null) continue;
    const text = line.toString('utf8');
    const nul = text.indexOf('\0');
    const head = nul === -1 ? text : text.slice(0, nul);
    if (nul !== -1) {
      const caps = text.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\s*$/.exec(head);
    if (match === null) continue;
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  }
  // The pack follows the command flush, raw (not pkt-lined).
  const packBytes = body.subarray(parsed.offset);
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  if (updatesRef && packBytes.length > 0) {
    try {
      const objects = await readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch {
      unpackOk = false;
    }
  } else if (updatesRef && packBytes.length === 0) {
    // A create/update command with no pack at all is an unpacker error in real git.
    unpackOk = false;
  }
  // Apply the ref updates, fast-forward only, one report line per command in order.
  const reportLines: string[] = [unpackOk ? 'unpack ok' : 'unpack error: pack could not be read'];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    let ok = true;
    let reason = '';
    if (!unpackOk) {
      ok = false;
      reason = 'unpack failed';
    } else if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        ok = false;
        reason = 'non-fast-forward';
      }
    } else if (command.oldOid !== current) {
      ok = false;
      reason = 'non-fast-forward';
    } else if (command.newOid === ZERO_OID) {
      // Delete.
    } else if (!isDescendant(repo, current, command.newOid)) {
      ok = false;
      reason = 'non-fast-forward';
    }
    if (ok) {
      if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
      else repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    } else {
      reportLines.push(`ng ${command.ref} ${reason}`);
    }
  }
  const report = Buffer.concat([...reportLines.map((line) => pktText(line)), PKT_FLUSH]);
  if (sideband) return Buffer.concat(sidebandPackets(report));
  return report;
}

/**
 * Route one git request. Returns a response, or null when the path is not a git route at all.
 * `sub` is the path after `/{owner}/{repo}.git`, and `query` the request's query string.
 */
export async function handleGit(
  store: Store,
  method: string,
  owner: string,
  repoName: string,
  sub: string,
  query: URLSearchParams,
  headers: IncomingHttpHeaders,
  body: Buffer,
): Promise<GitResponse | null> {
  const repo = store.getRepo(owner, repoName);
  const gitProtocol = (headers['git-protocol'] as string | undefined) ?? '';
  if (method === 'GET' && sub === '/info/refs') {
    const service = query.get('service') ?? '';
    if (repo === undefined) return jsonResponse(404, { message: 'Not Found' });
    if (service === 'git-upload-pack') {
      if (gitProtocol.includes('version=2')) {
        return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2() };
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV0(repo, 'git-upload-pack') };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertiseV0(repo, 'git-receive-pack') };
    }
    return jsonResponse(400, { message: 'Missing service parameter' });
  }
  if (method === 'POST' && sub === '/git-upload-pack') {
    if (repo === undefined) return jsonResponse(404, { message: 'Not Found' });
    if (gitProtocol.includes('version=2')) {
      // v2: the first pkt-line names the command; the arguments follow a delimiter.
      const { lines } = parsePktLines(body);
      let command = '';
      const args: string[] = [];
      let afterDelim = false;
      for (const line of lines) {
        if (line === null) { afterDelim = true; continue; }
        const text = line.toString('utf8').replace(/\n$/, '');
        if (!afterDelim && text.startsWith('command=')) command = text.slice('command='.length);
        else if (afterDelim) args.push(text);
      }
      if (command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, args) };
      }
      if (command === 'fetch') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV2(repo, args) };
      }
      return jsonResponse(400, { message: `Unknown git protocol v2 command ${JSON.stringify(command)}` });
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetchV0(repo, body) };
  }
  if (method === 'POST' && sub === '/git-receive-pack') {
    if (repo === undefined) return jsonResponse(404, { message: 'Not Found' });
    const responseBody = await handleReceivePack(repo, body, headers);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
  }
  return null;
}
