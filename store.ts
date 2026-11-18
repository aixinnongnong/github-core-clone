// The forge's store: every repository, object, ref, issue, pull request, label and comment, held
// in memory for one trial. There is no persistence and no wall clock anywhere in here — every
// timestamp is either the trial's fixed "now" or a counter-derived commit time, so a replay of the
// same requests leaves the same state. The store also owns the git-level operations the REST and
// GraphQL surfaces need: flattening and rebuilding trees, committing a file change, finding a
// merge base, and the three-way merge a squash merge performs.

import {
  type GitObject, type TreeEntry, type Commit,
  hashObject, parseCommit, parseTree, buildTree, buildCommit, collectReachable,
} from './git.ts';
import { viewerUser, type ScenarioUser } from './scenario.ts';

export const ZERO_OID = '0'.repeat(40);

/** A fixed "now" for created/updated timestamps: the trial's opening time when the env sets it. */
export function fixedNowIso(): string {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = raw === '' ? NaN : Date.parse(raw);
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return '2025-01-01T00:00:00.000Z';
}

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  readonly createdAt: string;
  updatedAt: string;
}

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  readonly labels: Map<string, Label>;
  readonly pulls: Map<number, Pull>;
  nextNumber: number;
}

/** A file in a flattened tree: its mode and the blob oid it points at. */
export interface FlatFile {
  readonly mode: string;
  readonly oid: string;
}

/** One changed file between two trees, for the pull-request files endpoint. */
export interface ChangedFile {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export class Store {
  readonly viewer: ScenarioUser;
  readonly nowIso: string;
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private nextRequestId = 1;
  private commitCounter = 0;

  constructor() {
    this.viewer = viewerUser();
    this.nowIso = fixedNowIso();
  }

  /** A non-empty, deterministic request id for the X-GitHub-Request-Id header. */
  nextRequestIdValue(): string {
    return `req-${this.nextRequestId++}`;
  }

  /** The key a repository lives under: `owner/name`. */
  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.repoKey(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].filter((repo) => repo.owner === this.viewer.login);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: this.viewer.login,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      issues: new Map<number, Issue>(),
      labels: new Map<string, Label>(),
      pulls: new Map<number, Pull>(),
      nextNumber: 1,
    };
    this.repos.set(Store.repoKey(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(Store.repoKey(repo.owner, repo.name));
  }

  /** Store an object, returning its id. */
  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The tip of a branch, or undefined when the branch has no commits yet. */
  refTip(repo: Repo, refName: string): string | undefined {
    return repo.refs.get(refName);
  }

  /** All branch names (refs/heads/*), sorted. */
  branchNames(repo: Repo): string[] {
    return [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .map((ref) => ref.slice('refs/heads/'.length))
      .sort();
  }

  /** The commit object at a ref's tip, or undefined when the ref is unborn. */
  commitAt(repo: Repo, refName: string): { oid: string; commit: Commit } | undefined {
    const oid = repo.refs.get(refName);
    if (oid === undefined) return undefined;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return { oid, commit: parseCommit(obj.data) };
  }

  /** The tree oid a commit points at. */
  treeOf(repo: Repo, commitOid: string): string | undefined {
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') return undefined;
    return parseCommit(obj.data).tree;
  }

  /**
   * Flatten a tree into path -> {mode, oid}, following subtrees. `prefix` is the path the tree
   * sits at ('' for the root). Returns an empty map for a missing tree.
   */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, FlatFile> {
    const out = new Map<string, FlatFile>();
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return out;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        for (const [sub, file] of this.flattenTree(repo, entry.oid, path)) out.set(sub, file);
      } else {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
    return out;
  }

  /**
   * Build the nested trees for a flat file map, storing each tree object, and return the root
   * tree's id. Entries are ordered the way git orders them (directories compare as name + '/').
   */
  buildTreeFromFiles(repo: Repo, files: Map<string, FlatFile>): string {
    const byDir = new Map<string, { mode: string; name: string; oid: string }[]>();
    for (const [path, file] of files) {
      const slash = path.lastIndexOf('/');
      const dir = slash === -1 ? '' : path.slice(0, slash);
      const name = slash === -1 ? path : path.slice(slash + 1);
      const list = byDir.get(dir) ?? [];
      list.push({ mode: file.mode, name, oid: file.oid });
      byDir.set(dir, list);
    }
    const buildDir = (dir: string): string => {
      const entries: TreeEntry[] = [];
      for (const entry of byDir.get(dir) ?? []) entries.push(entry);
      // Subdirectories of this directory become tree entries.
      for (const [childDir] of byDir) {
        if (childDir === dir) continue;
        const slashIdx = childDir.lastIndexOf('/');
        const parent = slashIdx === -1 ? '' : childDir.slice(0, slashIdx);
        if (parent === dir) {
          const name = slashIdx === -1 ? childDir : childDir.slice(slashIdx + 1);
          entries.push({ mode: '40000', name, oid: buildDir(childDir) });
        }
      }
      entries.sort((a, b) => {
        const ka = a.name + (a.mode === '40000' ? '/' : '');
        const kb = b.name + (b.mode === '40000' ? '/' : '');
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    // Directories that exist only as a parent of a deeper path still need a tree entry; the loop
    // above only visits directories that hold files. Ensure every intermediate directory is in
    // byDir so buildDir can find it.
    for (const path of files.keys()) {
      let dir = path.slice(0, path.lastIndexOf('/'));
      while (dir !== '' && !byDir.has(dir)) {
        byDir.set(dir, []);
        const slashIdx = dir.lastIndexOf('/');
        dir = slashIdx === -1 ? '' : dir.slice(0, slashIdx);
      }
    }
    return buildDir('');
  }

  /** A deterministic, strictly increasing commit time (seconds since the scenario epoch). */
  private nextCommitEpoch(): number {
    return 1_735_689_600 + this.commitCounter++;
  }

  /** The author/committer line for a commit made by the forge itself. */
  private identityLine(epochSec: number): string {
    return `${this.viewer.name} <${this.viewer.email}> ${epochSec} +0000`;
  }

  /**
   * Create a commit on `branch` (creating the branch from the default tip when it does not exist
   * yet) whose tree is `treeOid`, with `parents` (default: the branch tip, or none when unborn),
   * and move the branch to it. Returns the new commit's id.
   */
  makeCommit(repo: Repo, branch: string, treeOid: string, message: string, parents?: readonly string[]): string {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    const parentList = parents !== undefined ? [...parents] : tip !== undefined ? [tip] : [];
    const epochSec = this.nextCommitEpoch();
    const line = this.identityLine(epochSec);
    const commit: Commit = { tree: treeOid, parents: parentList, author: line, committer: line, message };
    const oid = this.putObject(repo, 'commit', buildCommit(commit));
    repo.refs.set(refName, oid);
    return oid;
  }

  /**
   * Write `content` to `path` on `branch` (creating the branch from the default tip when needed),
   * as one commit. Returns the blob id and the commit id.
   */
  writeFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { blobOid: string; commitOid: string } {
    const refName = `refs/heads/${branch}`;
    let tip = repo.refs.get(refName);
    if (tip === undefined && branch !== repo.defaultBranch) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) {
        repo.refs.set(refName, defaultTip);
        tip = defaultTip;
      }
    }
    const files = tip !== undefined ? this.flattenTree(repo, this.treeOf(repo, tip) as string) : new Map<string, FlatFile>();
    const blobOid = this.putObject(repo, 'blob', content);
    files.set(path, { mode: '100644', oid: blobOid });
    const treeOid = this.buildTreeFromFiles(repo, files);
    const commitOid = this.makeCommit(repo, branch, treeOid, message);
    return { blobOid, commitOid };
  }

  /** Delete `path` from `branch` as one commit. Returns the commit id, or undefined when absent. */
  deleteFile(repo: Repo, branch: string, path: string, message: string): string | undefined {
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName);
    if (tip === undefined) return undefined;
    const files = this.flattenTree(repo, this.treeOf(repo, tip) as string);
    if (!files.has(path)) return undefined;
    files.delete(path);
    const treeOid = this.buildTreeFromFiles(repo, files);
    return this.makeCommit(repo, branch, treeOid, message);
  }

  /** The blob id and bytes for `path` at a ref's tip, or undefined when the path is absent. */
  fileAt(repo: Repo, refName: string, path: string): { oid: string; data: Buffer } | undefined {
    const tip = repo.refs.get(refName);
    if (tip === undefined) return undefined;
    const treeOid = this.treeOf(repo, tip);
    if (treeOid === undefined) return undefined;
    const files = this.flattenTree(repo, treeOid);
    const file = files.get(path);
    if (file === undefined) return undefined;
    const obj = repo.objects.get(file.oid);
    if (obj === undefined || obj.type !== 'blob') return undefined;
    return { oid: file.oid, data: obj.data };
  }

  /** The entries (files and directories) at `dir` in a ref's tip tree. */
  dirAt(repo: Repo, refName: string, dir: string): { name: string; path: string; type: 'file' | 'dir'; oid: string }[] {
    const tip = repo.refs.get(refName);
    if (tip === undefined) return [];
    const treeOid = this.treeOf(repo, tip);
    if (treeOid === undefined) return [];
    const files = this.flattenTree(repo, treeOid);
    const prefix = dir === '' ? '' : `${dir}/`;
    const out = new Map<string, { name: string; path: string; type: 'file' | 'dir'; oid: string }>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        out.set(rest, { name: rest, path, type: 'file', oid: file.oid });
      } else {
        const name = rest.slice(0, slash);
        if (!out.has(name)) {
          // The directory's tree id is found by walking the tree; fall back to the empty tree id.
          out.set(name, { name, path: `${prefix}${name}`, type: 'dir', oid: this.emptyTreeOid(repo) });
        }
      }
    }
    return [...out.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  private emptyTreeOid(repo: Repo): string {
    return this.putObject(repo, 'tree', buildTree([]));
  }

  /** All commit ids reachable from `tip`, newest first (a depth-first walk from the tip). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.push(oid);
      const commit = parseCommit(obj.data);
      // Push parents in reverse so the first parent is visited first.
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return out;
  }

  /** The merge base of two tips: the common ancestor closest to both (smallest distance sum). */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const distA = new Map<string, number>();
    const queueA: [string, number][] = [[a, 0]];
    while (queueA.length > 0) {
      const [oid, dist] = queueA.shift() as [string, number];
      if (distA.has(oid)) continue;
      distA.set(oid, dist);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queueA.push([parent, dist + 1]);
    }
    const distB = new Map<string, number>();
    const queueB: [string, number][] = [[b, 0]];
    let best: string | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    while (queueB.length > 0) {
      const [oid, dist] = queueB.shift() as [string, number];
      if (distB.has(oid)) continue;
      distB.set(oid, dist);
      const scoreA = distA.get(oid);
      if (scoreA !== undefined && scoreA + dist < bestScore) {
        bestScore = scoreA + dist;
        best = oid;
      }
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queueB.push([parent, dist + 1]);
    }
    return best;
  }

  /** The files changed between two trees (base -> head), with a line count for each. */
  diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): ChangedFile[] {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const out: ChangedFile[] = [];
    const countLines = (data: Buffer): number => {
      const text = data.toString('utf8');
      if (text === '') return 0;
      return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    };
    const lineCounts = (oid: string): Map<string, number> => {
      const obj = repo.objects.get(oid);
      const counts = new Map<string, number>();
      if (obj === undefined || obj.type !== 'blob') return counts;
      for (const line of obj.data.toString('utf8').split('\n')) {
        counts.set(line, (counts.get(line) ?? 0) + 1);
      }
      return counts;
    };
    for (const [path, headFile] of head) {
      const baseFile = base.get(path);
      if (baseFile === undefined) {
        const additions = countLines(repo.objects.get(headFile.oid)?.data ?? Buffer.alloc(0));
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (baseFile.oid !== headFile.oid) {
        const baseCounts = lineCounts(baseFile.oid);
        const headCounts = lineCounts(headFile.oid);
        let additions = 0;
        let deletions = 0;
        for (const [line, n] of headCounts) additions += Math.max(0, n - (baseCounts.get(line) ?? 0));
        for (const [line, n] of baseCounts) deletions += Math.max(0, n - (headCounts.get(line) ?? 0));
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    for (const [path, baseFile] of base) {
      if (!head.has(path)) {
        const deletions = countLines(repo.objects.get(baseFile.oid)?.data ?? Buffer.alloc(0));
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      }
    }
    return out.sort((a, b) => (a.filename < b.filename ? -1 : 1));
  }

  /**
   * The three-way merge a squash merge performs: merge-base tree, head tree, base-tip tree.
   * Returns the merged tree's id, or null when the two sides changed the same file differently.
   */
  threeWayMerge(repo: Repo, baseTreeOid: string, headTreeOid: string, targetTreeOid: string): string | null {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const target = this.flattenTree(repo, targetTreeOid);
    const merged = new Map<string, FlatFile>(target);
    const all = new Set<string>([...base.keys(), ...head.keys(), ...target.keys()]);
    for (const path of all) {
      const b = base.get(path);
      const h = head.get(path);
      const t = target.get(path);
      const same = (x: FlatFile | undefined, y: FlatFile | undefined): boolean =>
        (x === undefined && y === undefined) || (x !== undefined && y !== undefined && x.oid === y.oid);
      if (same(h, t)) continue; // Both sides agree (or both deleted): keep the target's value.
      if (same(h, b)) continue; // Head unchanged: keep the target's value.
      if (same(t, b)) {
        // Target unchanged: take the head's value (or delete when the head deleted it).
        if (h === undefined) merged.delete(path);
        else merged.set(path, h);
        continue;
      }
      return null; // Both changed the same path differently: a conflict.
    }
    return this.buildTreeFromFiles(repo, merged);
  }

  // ------------------------------------------------------------ issues / pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const issue: Issue = {
      id: this.nextIssueId++,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: this.nextCommentId++, body, createdAt: this.nowIso };
    issue.comments.push(comment);
    issue.updatedAt = this.nowIso;
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    const number = repo.nextNumber++;
    const pull: Pull = {
      id: this.nextPullId++,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /**
   * Merge a pull request as one squash commit on the base branch. Returns the merge commit's id,
   * or null when the merge conflicts. The PR is marked merged and closed on success.
   */
  mergePull(repo: Repo, pull: Pull): string | null {
    const baseRefName = `refs/heads/${pull.baseRef}`;
    const headRefName = `refs/heads/${pull.headRef}`;
    const baseTip = repo.refs.get(baseRefName);
    const headTip = repo.refs.get(headRefName);
    if (baseTip === undefined || headTip === undefined) return null;
    const baseCommitOid = this.mergeBase(repo, headTip, baseTip);
    const baseTreeOid = baseCommitOid !== undefined ? this.treeOf(repo, baseCommitOid) : undefined;
    const headTreeOid = this.treeOf(repo, headTip);
    const targetTreeOid = this.treeOf(repo, baseTip);
    if (baseTreeOid === undefined || headTreeOid === undefined || targetTreeOid === undefined) return null;
    const mergedTreeOid = this.threeWayMerge(repo, baseTreeOid, headTreeOid, targetTreeOid);
    if (mergedTreeOid === null) return null;
    const commitOid = this.makeCommit(repo, pull.baseRef, mergedTreeOid, pull.title, [baseTip]);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso;
    pull.mergeCommitSha = commitOid;
    pull.baseSha = commitOid;
    pull.updatedAt = this.nowIso;
    return commitOid;
  }

  /** The objects reachable from a set of roots, for a fetch. */
  reachable(repo: Repo, roots: readonly string[]): Map<string, GitObject> {
    return collectReachable(roots, (oid) => repo.objects.get(oid));
  }

  /** A global id for a repository (opaque, stable across reads, never the plain database id). */
  globalRepoId(repo: Repo): string {
    return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64');
  }

  /** A global id for an issue. */
  globalIssueId(repo: Repo, issue: Issue): string {
    return Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64');
  }

  /** A global id for a pull request. */
  globalPullId(repo: Repo, pull: Pull): string {
    return Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64');
  }

  /** A global id for a comment. */
  globalCommentId(repo: Repo, issue: Issue, comment: IssueComment): string {
    return Buffer.from(`IssueComment:${repo.id}:${issue.number}:${comment.id}`, 'utf8').toString('base64');
  }

  /** Decode a global id into its type and parts, or null when it is not one of ours. */
  decodeGlobalId(id: string): { type: string; parts: string[] } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const [type, ...parts] = text.split(':');
      if (type === undefined || !['Repository', 'Issue', 'PullRequest', 'IssueComment'].includes(type)) return null;
      return { type, parts };
    } catch {
      return null;
    }
  }
}
