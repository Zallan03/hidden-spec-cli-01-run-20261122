// main.ts is mend, the CLI SPEC.md specifies: one patch tool for every AI edit format. It reads a patch in one of
// four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first
// of three matching tiers, and writes every change or none. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file split into lines at its own line break, remembering whether it ends with one. */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** One line of the file against one line of the patch, at a matching tier. */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every position where O occurs in the file's lines at the given tier, from `from` on. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; with strict, only 0) at which O occurs at least once. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

function reindentLine(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

interface NewLine {
  text: string;
  ctx: boolean;
  oIndex: number;
}

/** The lines N writes over a match at position `pos`: context lines are the file's own matched lines, and at
 * tier 2 every other line is re-indented from O's first line to the file's first matched line. */
function buildReplacement(lines: string[], pos: number, o: string[], n: NewLine[], tier: number): string[] {
  if (tier !== 2) return n.map((e) => (e.ctx ? lines[pos + e.oIndex]! : e.text));
  const f = leadWs(lines[pos] ?? '');
  const p = leadWs(o[0] ?? '');
  return n.map((e) => (e.ctx ? lines[pos + e.oIndex]! : reindentLine(e.text, p, f)));
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ section 6: unified diffs */

interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  noEol: boolean;
  plusNoEol: boolean;
}

interface Section {
  oldP: string | null | undefined;
  newP: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  gitA: string | null;
  gitB: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path named by a `--- ` or `+++ ` header line: after the four characters, up to the first tab. */
function headerPath(line: string): string {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  return s.trim();
}

const pathOrNull = (p: string): string | null => (p === '/dev/null' ? null : p);
const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** `diff --git a/<X> b/<Y>`, or null when the line is not of that form. Paths may hold spaces, so the split
 * is at the last ` b/`: the first group is greedy and both sides must be non-empty. */
function parseGit(line: string): [string, string] | null {
  const m = /^a\/(.+) b\/(.+)$/.exec(line.slice('diff --git '.length).trimEnd());
  return m ? [m[1]!, m[2]!] : null;
}

/** A hunk body: the lines after the header that start with ` `, `-`, `+` or `\`, or are empty. The body ends
 * at the first other line, at a `diff --git ` line, at a `--- ` line followed by a `+++ ` line, or at the end
 * of the patch; empty lines at the end of a body are not part of it. */
function collectBody(lines: string[], from: number): { body: string[]; next: number } {
  const body: string[] = [];
  let j = from;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push(l);
      j++;
      continue;
    }
    break;
  }
  while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
  return { body, next: j };
}

function buildHunk(a: number, body: string[]): Hunk {
  const o: string[] = [];
  const n: NewLine[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  body.forEach((l, idx) => {
    if (l === '') {
      o.push('');
      n.push({ text: '', ctx: true, oIndex: o.length - 1 });
      lastCtxPlus = idx;
    } else if (l.startsWith(' ')) {
      o.push(l.slice(1));
      n.push({ text: l.slice(1), ctx: true, oIndex: o.length - 1 });
      lastCtxPlus = idx;
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: false, oIndex: -1 });
      lastCtxPlus = idx;
      lastPlus = idx;
    }
  });
  const follows = (idx: number): boolean => idx >= 0 && body[idx + 1] !== undefined && body[idx + 1]!.startsWith('\\');
  return { a, o, n, noEol: follows(lastCtxPlus), plusNoEol: follows(lastPlus) };
}

/** The hunks of a section, applied in order to the file's lines. */
function applyUnifiedHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length > 0) {
      const found = findTier(f.lines, h.o, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const o of found.occ) {
        const dist = Math.abs(o - target);
        if (dist < bestDist) {
          best = o;
          bestDist = dist;
        }
      }
      const runsToEnd = best + h.o.length === f.lines.length;
      const repl = buildReplacement(f.lines, best, h.o, h.n, found.tier);
      f.lines.splice(best, h.o.length, ...repl);
      if (runsToEnd) f.final = !h.noEol;
      d += h.n.length - h.o.length;
    } else {
      const at = Math.max(0, Math.min(h.a + d, f.lines.length));
      const ins = h.n.map((e) => e.text);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...ins);
      if (atEnd && ins.length > 0) f.final = !h.noEol;
      d += h.n.length;
    }
  }
  return joinFile(f);
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const startSection = (gitA: string | null, gitB: string | null): void => {
    cur = { oldP: undefined, newP: undefined, renameFrom: undefined, renameTo: undefined, gitA, gitB, newFile: false, deletedFile: false, hunks: [] };
    sections.push(cur);
  };
  let state: 'out' | 'head' | 'after' = 'out';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (state === 'out') {
      if (line.startsWith('diff --git ')) {
        const g = parseGit(line);
        if (!g) throw new Exit2(`error: parse ${lineNo}`);
        startSection(g[0], g[1]);
        state = 'head';
        i++;
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(null, null);
        cur!.oldP = pathOrNull(headerPath(line));
        cur!.newP = pathOrNull(headerPath(lines[i + 1]!));
        state = 'head';
        i += 2;
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${lineNo}`);
      i++;
      continue;
    }
    if (state === 'head') {
      if (line.startsWith('diff --git ')) {
        const g = parseGit(line);
        if (!g) throw new Exit2(`error: parse ${lineNo}`);
        startSection(g[0], g[1]);
        i++;
        continue;
      }
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur!.oldP = pathOrNull(headerPath(line));
          cur!.newP = pathOrNull(headerPath(lines[i + 1]!));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${lineNo + 1}`);
      }
      if (line.startsWith('@@')) {
        const m = HUNK_RE.exec(line);
        if (!m) throw new Exit2(`error: parse ${lineNo}`);
        const { body, next } = collectBody(lines, i + 1);
        cur!.hunks.push(buildHunk(Number(m[1]), body));
        state = 'after';
        i = next;
        continue;
      }
      if (line === 'rename from' || line.startsWith('rename from ')) {
        cur!.renameFrom = line.slice('rename from'.length).trim();
        i++;
        continue;
      }
      if (line === 'rename to' || line.startsWith('rename to ')) {
        cur!.renameTo = line.slice('rename to'.length).trim();
        i++;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur!.newFile = true;
        i++;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur!.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const g = parseGit(line);
      if (!g) throw new Exit2(`error: parse ${lineNo}`);
      startSection(g[0], g[1]);
      state = 'head';
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection(null, null);
      cur!.oldP = pathOrNull(headerPath(line));
      cur!.newP = pathOrNull(headerPath(lines[i + 1]!));
      state = 'head';
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${lineNo}`);
      const { body, next } = collectBody(lines, i + 1);
      cur!.hunks.push(buildHunk(Number(m[1]), body));
      i = next;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  return (tree) => {
    const oldRaw = s.oldP !== undefined ? s.oldP : s.renameFrom !== undefined ? s.renameFrom : s.gitA;
    const newRaw = s.newP !== undefined ? s.newP : s.renameTo !== undefined ? s.renameTo : s.gitB;
    const old = oldRaw === null || oldRaw === undefined ? null : stripAB(oldRaw);
    const nw = newRaw === null || newRaw === undefined ? null : stripAB(newRaw);
    if (old === null && nw === null) return;
    if (old === null || s.newFile) {
      const p = nw!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const e of h.n) if (!e.ctx) plus.push(e.text);
      let plusNoEol = false;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        const h = s.hunks[k]!;
        if (h.n.some((e) => !e.ctx)) {
          plusNoEol = h.plusNoEol;
          break;
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (plusNoEol ? '' : '\n'));
      return;
    }
    if (nw === null || s.deletedFile) {
      const p = old!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (old !== nw) {
      if (!safe(old)) throw new Fail('unsafe', old);
      if (!safe(nw)) throw new Fail('unsafe', nw);
      const text = tree.get(old);
      if (text === null) throw new Fail('missing', old);
      if (tree.get(nw) !== null) throw new Fail('exists', nw);
      tree.now.set(old, null);
      tree.now.set(nw, applyUnifiedHunks(text, s.hunks, strict, old));
      tree.moves.push([old, nw]);
      return;
    }
    const p = old;
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    tree.now.set(p, applyUnifiedHunks(text, s.hunks, strict, p));
  };
}

/* ----------------------------------------------------------- section 7: SEARCH/REPLACE blocks */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j--) {
      const t = lines[j]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH' || lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevReplace = rep;
    prevPath = path;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, o: string[], n: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (o.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, n.length === 0 ? '' : n.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitFile(text);
    const found = findTier(f.lines, o, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const repl = buildReplacement(f.lines, found.occ[0]!, o, n.map((t) => ({ text: t, ctx: false, oIndex: -1 })), found.tier);
    f.lines.splice(found.occ[0]!, o.length, ...repl);
    tree.now.set(path, joinFile(f));
  };
}

/* ------------------------------------------------------------------ section 8: V4A patches */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: NewLine[];
}

function applyV4aChunks(text: string, chunks: V4aChunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  const maxTier = strict ? 0 : 2;
  let cursor = 0;
  for (const ch of chunks) {
    if (ch.anchor !== null) {
      let at: number | null = null;
      for (let t = 0; t <= maxTier && at === null; t++) {
        for (let k = cursor; k < f.lines.length; k++) {
          if (lineEq(f.lines[k]!, ch.anchor, t)) {
            at = k;
            break;
          }
        }
      }
      if (at === null) throw new Fail('no-match', path);
      cursor = at + 1;
    }
    if (ch.o.length === 0) {
      const pos = ch.eof ? f.lines.length : cursor;
      const ins = ch.n.map((e) => e.text);
      f.lines.splice(pos, 0, ...ins);
      cursor = pos + ins.length;
    } else {
      let found: { tier: number; pos: number } | null = null;
      for (let t = 0; t <= maxTier && !found; t++) {
        for (const o of occurrences(f.lines, ch.o, t, cursor)) {
          if (ch.eof && o + ch.o.length !== f.lines.length) continue;
          found = { tier: t, pos: o };
          break;
        }
      }
      if (!found) throw new Fail('no-match', path);
      const repl = buildReplacement(f.lines, found.pos, ch.o, ch.n, found.tier);
      f.lines.splice(found.pos, ch.o.length, ...repl);
      cursor = found.pos + repl.length;
    }
  }
  return joinFile(f);
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File:')) {
      kind = 'add';
      path = line.slice('*** Add File:'.length).trim();
    } else if (line.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = line.slice('*** Delete File:'.length).trim();
    } else if (line.startsWith('*** Update File:')) {
      kind = 'update';
      path = line.slice('*** Update File:'.length).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    let j = i + 1;
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) break;
      j++;
    }
    const content: { text: string; no: number }[] = [];
    for (let k = i + 1; k < j; k++) content.push({ text: lines[k]!, no: k + 1 });
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const c of content) {
        if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
        else if (c.text === '') fileLines.push('');
        else throw new Exit2(`error: parse ${c.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      edits.push(v4aUpdateEdit(path, content, i + 1, strict));
    }
    i = j;
  }
  return edits;
}

function v4aUpdateEdit(path: string, content: { text: string; no: number }[], updateLineNo: number, strict: boolean): Edit {
  let moveTo: string | null = null;
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const closeChunk = (eof: boolean): void => {
    if (cur !== null) {
      cur.eof = eof;
      chunks.push(cur);
      cur = null;
    }
  };
  let seenFirst = false;
  for (const c of content) {
    const l = c.text;
    if (!seenFirst && l.startsWith('*** Move to:')) {
      moveTo = l.slice('*** Move to:'.length).trim();
      seenFirst = true;
      continue;
    }
    seenFirst = true;
    if (l.startsWith('@@')) {
      closeChunk(false);
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [] };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${c.no}`);
      closeChunk(true);
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (cur === null) cur = { anchor: null, eof: false, o: [], n: [] };
      if (l === '') {
        cur.o.push('');
        cur.n.push({ text: '', ctx: true, oIndex: cur.o.length - 1 });
      } else if (l.startsWith(' ')) {
        cur.o.push(l.slice(1));
        cur.n.push({ text: l.slice(1), ctx: true, oIndex: cur.o.length - 1 });
      } else if (l.startsWith('-')) {
        cur.o.push(l.slice(1));
      } else {
        cur.n.push({ text: l.slice(1), ctx: false, oIndex: -1 });
      }
      continue;
    }
    throw new Exit2(`error: parse ${c.no}`);
  }
  closeChunk(false);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const out = applyV4aChunks(text, chunks, strict, path);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/* ------------------------------------------------------------ sections 1, 2 and 10: running it */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const paired = new Set<string>();
  for (const [old, nw] of tree.moves) {
    if (tree.original(old) !== null && tree.get(old) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      rows.push({ key: nw, line: `R ${old} -> ${nw}` });
      paired.add(old);
      paired.add(nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
