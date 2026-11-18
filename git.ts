// The git object model, packfile read/write and pkt-line codec. This is the forge's git core:
// everything the smart-HTTP handlers and the REST contents API build on. It uses only Node's
// standard library (crypto for SHA-1, zlib for pack compression) and mirrors the wire format the
// suite's client speaks (pack v2, OFS_DELTA / REF_DELTA, pkt-lines, v0/v2 advertisements).
//
// One Node quirk shapes readPack: `zlib.inflateSync` does not say how many input bytes a zlib
// stream consumed, so a pack entry's end cannot be found from it. The streaming `createInflate`
// does report it — its `bytesWritten` is exactly the consumed input length (verified on this
// machine) — so pack reading is async and inflates one entry per stream.

import { createHash } from 'node:crypto';
import { deflateSync, createInflate } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

/** SHA-1 of `<type> <size>\0` + data, as a lowercase hex string. */
export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

/** A git object: its type and raw bytes (without the `<type> <size>\0` header). */
export interface GitObject {
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  readonly data: Buffer;
}

/** A parsed commit: the fields the forge and the suite both read. */
export interface Commit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** A parsed tree entry: mode, name and the object id it points at. */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** A parsed tag: the fields the forge needs to peel it. */
export interface Tag {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a commit's raw bytes into its fields. */
export function parseCommit(data: Buffer): Commit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit's raw bytes from its fields. */
export function buildCommit(commit: Commit): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

/** Parse a tree's raw bytes into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree's raw bytes from its entries (kept in the order given). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tag's raw bytes into its fields. */
export function parseTag(data: Buffer): Tag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build a tag's raw bytes from its fields. */
export function buildTag(tag: Tag): Buffer {
  const lines = [`object ${tag.object}`, `type ${tag.type}`, `tag ${tag.tag}`, `tagger ${tag.tagger}`];
  return Buffer.from(`${lines.join('\n')}\n\n${tag.message}`, 'utf8');
}

/**
 * The objects reachable from `roots`, following commits (tree + parents), trees (entries) and
 * tags (their object), in the order a walk from the roots meets them. `lookup` answers an object
 * by id, or undefined when it is not stored.
 */
export function collectReachable(
  roots: readonly string[],
  lookup: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack = [...roots];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = lookup(oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

/** Apply a git delta to `base` and return the reconstructed bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      out |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return out;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base size ${sourceSize} does not match ${base.length}`);
  const parts: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      if ((op & 0x01) !== 0) { copyOffset = delta[offset] as number; offset += 1; }
      if ((op & 0x02) !== 0) { copyOffset |= (delta[offset] as number) << 8; offset += 1; }
      if ((op & 0x04) !== 0) { copyOffset |= (delta[offset] as number) << 16; offset += 1; }
      if ((op & 0x08) !== 0) { copyOffset |= (delta[offset] as number) << 24; offset += 1; }
      if ((op & 0x10) !== 0) { copySize = delta[offset] as number; offset += 1; }
      if ((op & 0x20) !== 0) { copySize |= (delta[offset] as number) << 8; offset += 1; }
      if ((op & 0x40) !== 0) { copySize |= (delta[offset] as number) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta op 0 is invalid');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error(`delta target size ${targetSize} does not match ${out.length}`);
  return out;
}

/**
 * Inflate one zlib stream that starts at the front of `input`. Returns the inflated bytes and how
 * many input bytes the stream consumed, so the caller knows where the next entry starts. The
 * inflated length must match `expectedSize`.
 */
function inflateOne(input: Buffer, expectedSize: number): Promise<{ data: Buffer; consumed: number }> {
  return new Promise((resolve, reject) => {
    const inflater = createInflate();
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (err: Error | null, result?: { data: Buffer; consumed: number }): void => {
      if (settled) return;
      settled = true;
      inflater.destroy();
      if (err !== null) reject(err);
      else if (result !== undefined) resolve(result);
    };
    inflater.on('data', (chunk: Buffer) => chunks.push(chunk));
    inflater.on('error', (err: Error) => done(err));
    inflater.on('end', () => {
      const data = Buffer.concat(chunks);
      if (data.length !== expectedSize) {
        done(new Error(`inflated size ${data.length} does not match declared ${expectedSize}`));
        return;
      }
      done(null, { data, consumed: inflater.bytesWritten });
    });
    inflater.write(input);
    inflater.end();
  });
}

/** One parsed pack entry, before delta resolution. */
interface PackEntry {
  type: 'commit' | 'tree' | 'blob' | 'tag' | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a packfile (v2 or v3) into its objects, resolving OFS_DELTA and REF_DELTA entries. `lookup`
 * answers an object already in the store by id (used to resolve REF_DELTA bases that are not in
 * this pack); objects in the pack itself are resolved from the pack. The returned map is keyed by
 * the SHA-1 each object's bytes hash to, and every object is verified against its hash.
 */
export async function readPack(
  pack: Buffer,
  lookup: (oid: string) => GitObject | undefined,
): Promise<Map<string, GitObject>> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile: missing PACK magic');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const bodyHash = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!bodyHash.equals(trailer)) throw new Error('pack trailer checksum mismatch');
  const typeNames: Record<number, PackEntry['type']> = {
    1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs-delta', 7: 'ref-delta',
  };
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryStart = offset;
    let byte = pack[offset] as number;
    offset += 1;
    const typeId = (byte >> 4) & 0x7;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const typeName = typeNames[typeId];
    if (typeName === undefined) throw new Error(`unknown pack object type ${typeId}`);
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeName === 'ofs-delta') {
      const first = pack[offset] as number;
      offset += 1;
      let base = first & 0x7f;
      let current = first;
      while ((current & 0x80) !== 0) {
        current = pack[offset] as number;
        offset += 1;
        base = ((base + 1) << 7) | (current & 0x7f);
      }
      baseOffset = entryStart - base;
    } else if (typeName === 'ref-delta') {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, consumed } = await inflateOne(pack.subarray(offset), size);
    offset += consumed;
    const entry: PackEntry = { type: typeName, data, baseOffset, baseOid };
    entries.push(entry);
    byOffset.set(entryStart, entry);
  }
  const out = new Map<string, GitObject>();
  const resolve = (entry: PackEntry): GitObject => {
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: GitObject | undefined;
      if (entry.type === 'ofs-delta') {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} not in pack`);
        base = resolve(baseEntry);
      } else {
        base = lookup(entry.baseOid as string);
        if (base === undefined) {
          // The base may itself be a delta in this pack; find it by resolving its oid.
          for (const candidate of entries) {
            if (candidate.type === 'ofs-delta' || candidate.type === 'ref-delta') continue;
            const candidateOid = hashObject(candidate.type, candidate.data);
            if (candidateOid === entry.baseOid) { base = { type: candidate.type, data: candidate.data }; break; }
          }
        }
        if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} not found`);
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    }
    return { type: entry.type, data: entry.data };
  };
  for (const entry of entries) {
    const obj = resolve(entry);
    const oid = hashObject(obj.type, obj.data);
    out.set(oid, obj);
  }
  return out;
}

/**
 * Build a packfile (v2) holding `objects` as plain (undelted) entries, in map order, with the
 * SHA-1 trailer over everything before it. The client only ever sends plain packs and accepts
 * plain packs, so deltas are never written.
 */
export function writePack(objects: Map<string, GitObject> | readonly GitObject[]): Buffer {
  const list = Array.isArray(objects) ? objects : [...objects.values()];
  const typeIds: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  parts.push(head);
  for (const obj of list) {
    const typeId = typeIds[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let first = (typeId << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-line

/** A pkt-line flush packet: `0000`. */
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
/** A pkt-line delimiter packet: `0001`. */
export const PKT_DELIM = Buffer.from('0001', 'ascii');
/** A pkt-line response-end packet: `0002`. */
export const PKT_END = Buffer.from('0002', 'ascii');

/** Encode `data` as one pkt-line (4 hex digits of the total length, then the data). */
export function pktLine(data: Buffer | string): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  if (length > 65520) throw new Error(`pkt-line of ${length} bytes exceeds the 65520 maximum`);
  const head = Buffer.alloc(4);
  head.write(length.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([head, payload]);
}

/** A pkt-line carrying a text line (a trailing newline is added when the text lacks one). */
export function pktText(text: string): Buffer {
  return pktLine(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * Parse the pkt-lines at the front of `buf`. Returns the decoded payloads (without their length
 * headers), whether a flush packet terminated them, and the offset just past the last packet
 * parsed. A delimiter packet (0001) is reported as a line with the payload `null`; a response-end
 * packet (0002) as `null` with `ended` set. Parsing stops at the first flush, end, or incomplete
 * packet.
 */
export function parsePktLines(buf: Buffer): {
  lines: (Buffer | null)[];
  flushed: boolean;
  ended: boolean;
  offset: number;
} {
  const lines: (Buffer | null)[] = [];
  let offset = 0;
  let flushed = false;
  let ended = false;
  while (offset + 4 <= buf.length) {
    const length = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      flushed = true;
      offset += 4;
      break;
    }
    if (length === 1) {
      lines.push(null);
      offset += 4;
      continue;
    }
    if (length === 2) {
      ended = true;
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > buf.length) break;
    lines.push(buf.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { lines, flushed, ended, offset };
}
