// ===== SECTION A: preserved starter (CLI, detect, JSON, Tree, run skeleton) =====
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

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

// ===== SECTION B: line matching (§5) =====
type BEnt = { k: string; t: string; s: boolean };
type NEnt = { t: string; c: boolean };

function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}
function joinFile(lines: string[], br: string, final: boolean): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function matchLines(fileLines: string[], oldLines: string[], strict: boolean, from = 0, eof = false): { tier: number; positions: number[] } | null {
  if (oldLines.length === 0) return null;
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const oldN = oldLines.map((s) => normLine(s, tier));
    const positions: number[] = [];
    for (let i = Math.max(0, from); i + oldLines.length <= fileLines.length; i++) {
      if (eof && i + oldLines.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < oldLines.length; j++) {
        if (normLine(fileLines[i + j]!, tier) !== oldN[j]) { ok = false; break; }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}
const leadWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';
function buildLines(fl: string[], pos: number, o: BEnt[], n: NEnt[], tier: number): string[] {
  const ctxOff: number[] = [];
  o.forEach((e, idx) => { if (e.k === ' ') ctxOff.push(idx); });
  let ci = 0;
  return n.map((e) => {
    if (e.c) {
      const off = ctxOff[ci++];
      return off === undefined ? e.t : (fl[pos + off] ?? e.t);
    }
    if (tier === 2 && e.t.trim() !== '' && o.length > 0) {
      const F = leadWs(fl[pos] ?? '');
      const P = leadWs(o[0]!.t);
      if (e.t.startsWith(P)) return F + e.t.slice(P.length);
    }
    return e.t;
  });
}
const oldEnts = (ts: string[]): BEnt[] => ts.map((t) => ({ k: '-', t, s: false }));
const newEnts = (ts: string[]): NEnt[] => ts.map((t) => ({ t, c: false }));

// ===== SECTION C: unified diffs (§6) =====
type Hunk = { a: number; o: BEnt[]; n: NEnt[]; slash: boolean; hasCP: boolean; plus: string[]; plusSlash: boolean };
type USec = { diffO?: string; diffN?: string; pairO?: string; pairN?: string; pair: boolean; renO?: string; renN?: string; create: boolean; del: boolean; seen: boolean; hunks: Hunk[] };

const stripPref = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
function headPath(s: string): string {
  let t = s.slice(4);
  const tb = t.indexOf('\t');
  if (tb >= 0) t = t.slice(0, tb);
  t = t.trim();
  return t === '/dev/null' ? t : stripPref(t);
}
function applyUnified(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  const fl = f.lines;
  let fin = f.final;
  let d = 0;
  for (const h of hunks) {
    const O = h.o.map((e) => e.t);
    if (O.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), fl.length);
      const atEnd = at === fl.length;
      fl.splice(at, 0, ...h.n.map((e) => e.t));
      if (atEnd && h.hasCP) fin = !h.slash;
      d += h.n.length;
    } else {
      const m = matchLines(fl, O, strict);
      if (m === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = m.positions[0]!;
      let best = Math.abs(pos - target);
      for (const p of m.positions.slice(1)) {
        const dist = Math.abs(p - target);
        if (dist < best) { best = dist; pos = p; }
      }
      const written = buildLines(fl, pos, h.o, h.n, m.tier);
      const ends = pos + O.length === fl.length;
      fl.splice(pos, O.length, ...written);
      if (ends) fin = !h.slash;
      d += h.n.length - O.length;
    }
  }
  return joinFile(fl, f.br, fin);
}
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: USec[] = [];
  let cur: USec | null = null;
  const pushCur = (): void => { if (cur) { secs.push(cur); cur = null; } };
  const newSec = (): USec => ({ pair: false, create: false, del: false, seen: false, hunks: [] });
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    // A `diff --git` line is a line whose first words are `diff --git`. The form
    // in SPEC.md §6 is `diff --git a/<X> b/<Y>` with spaces, so a line whose
    // separator is a tab is not of that form and is a parse error, as is a
    // bare `diff --git` line.
    if (l === 'diff --git' || l.startsWith('diff --git ') || l.startsWith('diff --git\t')) {
      if (l.charCodeAt(10) === 9) throw new Exit2(`error: parse ${i + 1}`);
      const toks = l.slice(11).split(' ');
      if (toks.length !== 2 || !toks[0]!.startsWith('a/') || !toks[1]!.startsWith('b/')) throw new Exit2(`error: parse ${i + 1}`);
      pushCur();
      cur = newSec();
      cur.diffO = stripPref(toks[0]!);
      cur.diffN = stripPref(toks[1]!);
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@.*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      let j = i + 1;
      const raw: string[] = [];
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') { raw.push(bl); j++; } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const ents: BEnt[] = [];
      for (const r of raw) {
        if (r.startsWith('\\')) { if (ents.length > 0) ents[ents.length - 1]!.s = true; continue; }
        if (r === '') ents.push({ k: ' ', t: '', s: false });
        else ents.push({ k: r[0]!, t: r.slice(1), s: false });
      }
      const o = ents.filter((e) => e.k === ' ' || e.k === '-');
      const n: NEnt[] = ents.filter((e) => e.k === ' ' || e.k === '+').map((e) => ({ t: e.t, c: e.k === ' ' }));
      const plusEnts = ents.filter((e) => e.k === '+');
      const cpEnts = ents.filter((e) => e.k === ' ' || e.k === '+');
      const lastCP = cpEnts[cpEnts.length - 1];
      const lastPlus = plusEnts[plusEnts.length - 1];
      cur.hunks.push({ a: Number(m[1]), o, n, slash: lastCP?.s ?? false, hasCP: cpEnts.length > 0, plus: plusEnts.map((e) => e.t), plusSlash: lastPlus?.s ?? false });
      cur.seen = true;
      i = j;
      continue;
    }
    if (l.startsWith('--- ')) {
      const nextOk = (lines[i + 1] ?? '').startsWith('+++ ');
      if (cur !== null && !cur.seen) {
        if (!nextOk) throw new Exit2(`error: parse ${i + 2}`);
        if (!cur.pair) {
          cur.pair = true;
          cur.pairO = headPath(l);
          cur.pairN = headPath(lines[i + 1]!);
        }
        i += 2;
        continue;
      }
      if (nextOk) {
        pushCur();
        cur = newSec();
        cur.pair = true;
        cur.pairO = headPath(l);
        cur.pairN = headPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (cur !== null && !cur.seen) {
      if (l.startsWith('rename from ')) cur.renO = stripPref(l.slice(12).trim());
      else if (l.startsWith('rename to ')) cur.renN = stripPref(l.slice(10).trim());
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
    }
    i++;
  }
  pushCur();
  return secs.map((sec): Edit => {
    const rawO = sec.pair ? sec.pairO : (sec.renO ?? sec.diffO);
    const rawN = sec.pair ? sec.pairN : (sec.renN ?? sec.diffN);
    if (sec.create || rawO === '/dev/null') {
      const newP = rawN ?? '';
      const pls = sec.hunks.flatMap((h) => h.plus);
      const lastH = [...sec.hunks].reverse().find((h) => h.plus.length > 0);
      return (tree) => {
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        tree.now.set(newP, pls.length === 0 ? '' : pls.join('\n') + (lastH?.plusSlash ? '' : '\n'));
      };
    }
    if (sec.del || rawN === '/dev/null') {
      const oldP = rawO ?? '';
      return (tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
      };
    }
    if (rawO !== undefined && rawN !== undefined && rawO !== rawN) {
      const oldP = rawO;
      const newP = rawN;
      return (tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const src = tree.get(oldP);
        if (src === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const res = applyUnified(src, sec.hunks, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, res);
        tree.moves.push([oldP, newP]);
      };
    }
    const p = rawO ?? rawN ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const src = tree.get(p);
      if (src === null) throw new Fail('missing', p);
      tree.now.set(p, applyUnified(src, sec.hunks, strict, p));
    };
  });
}

// ===== SECTION D: SEARCH/REPLACE (§7) =====
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prev: string | null = null;
  let boundary = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let k = i - 1; k >= boundary; k--) {
      const t = lines[k]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) {
      if (prev === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prev;
    }
    let div = -1;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) if (lines[j]!.trimEnd() === '=======') { div = j; break; }
    if (div >= 0) for (let j = div + 1; j < lines.length; j++) if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
    if (div < 0 || end < 0) throw new Exit2(`error: parse ${searchLine}`);
    const blockPath = path;
    const oldL = lines.slice(i + 1, div);
    const newL = lines.slice(div + 1, end);
    edits.push((tree) => {
      if (!safe(blockPath)) throw new Fail('unsafe', blockPath);
      if (oldL.length === 0) {
        if (tree.get(blockPath) !== null) throw new Fail('exists', blockPath);
        tree.now.set(blockPath, newL.length === 0 ? '' : newL.join('\n') + '\n');
        return;
      }
      const src = tree.get(blockPath);
      if (src === null) throw new Fail('missing', blockPath);
      const f = splitFile(src);
      const m = matchLines(f.lines, oldL, strict);
      if (m === null) throw new Fail('no-match', blockPath);
      if (m.positions.length > 1) throw new Fail('ambiguous', blockPath);
      const pos = m.positions[0]!;
      const written = buildLines(f.lines, pos, oldEnts(oldL), newEnts(newL), m.tier);
      f.lines.splice(pos, oldL.length, ...written);
      tree.now.set(blockPath, joinFile(f.lines, f.br, f.final));
    });
    prev = path;
    boundary = end + 1;
    i = end + 1;
  }
  return edits;
}

// ===== SECTION E: V4A (§8) =====
type Chunk = { anchor: string | null; eof: boolean; done: boolean; o: BEnt[]; n: NEnt[] };
const isSecStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const head = lines[i]!;
    if (blank(head)) { i++; continue; }
    let kind: 'add' | 'del' | 'upd' | null = null;
    let path = '';
    if (head.startsWith('*** Add File: ')) { kind = 'add'; path = head.slice(14).trim(); }
    else if (head.startsWith('*** Delete File: ')) { kind = 'del'; path = head.slice(17).trim(); }
    else if (head.startsWith('*** Update File: ')) { kind = 'upd'; path = head.slice(17).trim(); }
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    let j = i + 1;
    while (j < last && !isSecStart(lines[j]!)) j++;
    const cl: string[] = [];
    const cn: number[] = [];
    for (let k = i + 1; k < j; k++) { cl.push(lines[k]!); cn.push(k + 1); }
    while (cl.length > 0 && blank(cl[cl.length - 1]!)) { cl.pop(); cn.pop(); }
    if (kind === 'add') {
      const fileLines: string[] = [];
      cl.forEach((l, idx) => {
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${cn[idx]}`);
      });
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (kind === 'del') {
      if (cl.length > 0) throw new Exit2(`error: parse ${cn[0]}`);
      const p = path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      const p = path;
      let move: string | null = null;
      let start = 0;
      if (cl.length > 0 && cl[0]!.startsWith('*** Move to: ')) { move = cl[0]!.slice(13).trim(); start = 1; }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      for (let k = start; k < cl.length; k++) {
        const l = cl[k]!;
        const num = cn[k]!;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim() || null, eof: false, done: false, o: [], n: [] };
          chunks.push(cur);
          continue;
        }
        if (l === '*** End of File') {
          if (cur === null) { cur = { anchor: null, eof: true, done: true, o: [], n: [] }; chunks.push(cur); }
          else { cur.eof = true; cur.done = true; }
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null || cur.done) { cur = { anchor: null, eof: false, done: false, o: [], n: [] }; chunks.push(cur); }
          const kk = l === '' ? ' ' : l[0]!;
          const txt = l === '' ? '' : l.slice(1);
          if (kk === ' ' || kk === '-') cur.o.push({ k: kk, t: txt, s: false });
          if (kk === ' ' || kk === '+') cur.n.push({ t: txt, c: kk === ' ' });
          continue;
        }
        throw new Exit2(`error: parse ${num}`);
      }
      if (chunks.length === 0 && move === null) throw new Exit2(`error: parse ${headLine}`);
      const moveTo = move;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const src = tree.get(p);
        if (src === null) throw new Fail('missing', p);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const f = splitFile(src);
        const fl = f.lines;
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const am = matchLines(fl, [ch.anchor], strict, cursor);
            if (am === null) throw new Fail('no-match', p);
            cursor = am.positions[0]! + 1;
          }
          const O = ch.o.map((e) => e.t);
          if (O.length === 0) {
            const at = ch.eof ? fl.length : Math.min(cursor, fl.length);
            fl.splice(at, 0, ...ch.n.map((e) => e.t));
            cursor = at + ch.n.length;
          } else {
            const m = matchLines(fl, O, strict, cursor, ch.eof);
            if (m === null) throw new Fail('no-match', p);
            const pos = m.positions[0]!;
            const written = buildLines(fl, pos, ch.o, ch.n, m.tier);
            fl.splice(pos, O.length, ...written);
            cursor = pos + written.length;
          }
        }
        const res = joinFile(fl, f.br, f.final);
        if (moveTo !== null) {
          tree.now.set(p, null);
          tree.now.set(moveTo, res);
          tree.moves.push([p, moveTo]);
        } else {
          tree.now.set(p, res);
        }
      });
    }
    i = j;
  }
  return edits;
}

// ===== SECTION F: exit-0 reporting incl. R lines (§2) + runner hand-over =====
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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const byteCmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const suppressed = new Set<string>();
  const rows: Array<{ k: string; t: string }> = [];
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null) {
      rows.push({ k: n, t: `R ${o} -> ${n}` });
      suppressed.add(o);
      suppressed.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ k: p, t: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteCmp(a.k, b.k));
  const outRows = rows.map((r) => r.t);
  for (const p of [...tree.now.keys()].sort(byteCmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
