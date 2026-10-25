#!/usr/bin/env node
/**
 * Port the server changes of a paused JSDoc-conversion branch onto the working tree.
 *
 * The branch (ts/server-jsdoc) was cut from an older main and changed ~3,700 server
 * files (JSDoc types, `// @typecheck` markers). Cherry-picking drowns in conflicts, so
 * this ports per FILE with a 3-way `git merge-file`:
 *   ours   = the working tree, base = the commit the branch work started from,
 *   theirs = the branch tip.
 * The `// @typecheck` marker line is stripped from all three first (it is the one line
 * every file differs in) and put back afterwards: the highest level of ours and theirs,
 * next to the line it followed in the source it came from.
 *
 * Outcomes per file: clean (written), same (nothing to do), partial (written, but in some
 * hunk main changed the code and the branch only its type comments: main wins there, so the
 * file also goes on the re-convert list), conflict (code changed on both sides: the
 * working-tree content is kept, re-convert list), gone (the working tree deleted it),
 * added (new on the branch, absent here: copied).
 *
 * Usage: node scripts/port-jsdoc-branch.mjs --branch <rev> --base <rev> [--dry-run]
 *          [--paths server] [--list-out <file>] [--report-out <file>]
 *   --dry-run     decide everything, write nothing
 *   --list-out    the re-convert list (one path per line)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER_LINE = /^[ \t]*\/\/[ \t]*@typecheck\b.*$/;
const HEADER_LINES = 30;
const RANK = { none: 0, base: 1, noImplicitAny: 2, strict: 3 };

/** The level a marker line stands for. */
export function markerLevel(line) {
    if (!line) return 'none';
    if (/@typecheck[ \t]+strict\b/.test(line)) return 'strict';
    if (/@typecheck[ \t]+noImplicitAny\b/.test(line)) return 'noImplicitAny';
    return 'base';
}

/**
 * Split off the marker line within the header window.
 * Returns the text without it, the line, and the line that preceded it (an anchor to
 * put it back after; null when it was the first line).
 */
export function stripMarker(text) {
    const lines = text.split('\n');
    const limit = Math.min(lines.length, HEADER_LINES);
    for (let i = 0; i < limit; i++) {
        if (MARKER_LINE.test(lines[i])) {
            const marker = lines[i].trim();
            const anchor = i > 0 ? lines[i - 1] : null;
            lines.splice(i, 1);
            return { text: lines.join('\n'), marker, anchor };
        }
    }
    return { text, marker: null, anchor: null };
}

/** Put `marker` back: after the first header line equal to `anchor`, else after the shebang, else first. */
export function insertMarker(text, marker, anchor) {
    if (!marker) return text;
    const lines = text.split('\n');
    let at = -1;
    if (anchor !== null) {
        for (let i = 0; i < Math.min(lines.length, HEADER_LINES); i++) {
            if (lines[i] === anchor) { at = i + 1; break; }
        }
    }
    if (at === -1) at = lines[0] && lines[0].startsWith('#!') ? 1 : 0;
    lines.splice(at, 0, marker);
    return lines.join('\n');
}

// Lines that are only comment: they start with two slashes, a slash-star or a star.
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
const blockComments = /\/\*[\s\S]*?\*\//g;

/** The code of some lines with every comment and all whitespace removed (a comparison key). */
export function codeKey(lines) {
    return lines
        .join('\n')
        .replace(blockComments, '')
        .split('\n')
        .filter((l) => !COMMENT_LINE.test(l))
        .join('')
        .replace(/\s+/g, '');
}

/**
 * Resolve one conflict hunk (ours O, base B, theirs T, all arrays of lines), or null.
 *  - insertion: T is B plus comment lines in front of it or behind it (a JSDoc block, more
 *    tags): keep ours and add those lines at the same end;
 *  - comment-only: T differs from B in comments and whitespace only, so what main did to the
 *    code wins and the branch's type comments for it are dropped (the file is "partial").
 * Anything else changes code on both sides: a real conflict.
 */
export function resolveHunk(O, B, T) {
    if (T.length > B.length) {
        const extra = T.length - B.length;
        const head = T.slice(0, extra);
        const tail = T.slice(B.length);
        const comment = (ls) => ls.length > 0 && ls.every((l) => COMMENT_LINE.test(l));
        if (comment(head) && T.slice(extra).join('\n') === B.join('\n')) return { lines: [...head, ...O], dropped: false };
        if (comment(tail) && T.slice(0, B.length).join('\n') === B.join('\n')) return { lines: [...O, ...tail], dropped: false };
    }
    if (codeKey(T) === codeKey(B)) return { lines: O, dropped: true };
    return null;
}

/**
 * Merge three texts. Returns { text, conflicts, partial }: `conflicts` counts the hunks that
 * could not be resolved (the text then holds conflict markers); `partial` says a hunk was
 * resolved in favour of ours and the branch's type comments there were dropped.
 */
export function mergeTexts(ours, base, theirs) {
    const raw = mergeRaw(ours, base, theirs);
    if (raw.conflicts === 0) return { text: raw.text, conflicts: 0, partial: false };
    const out = [];
    let conflicts = 0;
    let partial = false;
    const lines = raw.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('<<<<<<< ')) { out.push(lines[i]); continue; }
        const O = [], B = [], T = [];
        let side = O;
        const start = i;
        for (i++; i < lines.length && !lines[i].startsWith('>>>>>>> '); i++) {
            if (lines[i].startsWith('||||||| ')) side = B;
            else if (lines[i] === '=======') side = T;
            else side.push(lines[i]);
        }
        const r = resolveHunk(O, B, T);
        if (r) { out.push(...r.lines); partial = partial || r.dropped; } else { conflicts++; out.push(...lines.slice(start, i + 1)); }
    }
    return { text: out.join('\n'), conflicts, partial };
}

function mergeRaw(ours, base, theirs) {
    const dir = mkdtempSync(path.join(tmpdir(), 'port-jsdoc-'));
    try {
        const o = path.join(dir, 'ours');
        const b = path.join(dir, 'base');
        const t = path.join(dir, 'theirs');
        writeFileSync(o, ours);
        writeFileSync(b, base);
        writeFileSync(t, theirs);
        const r = spawnSync('git', ['merge-file', '-p', '--diff3', o, b, t], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
        if (r.status === null || r.status < 0 || r.status > 127) throw new Error(`git merge-file failed: ${r.stderr}`);
        return { text: r.stdout, conflicts: r.status };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const DOC_BLOCK = /\/\*\*(?:(?!\*\/)[\s\S])*\*\//g;
const TYPEDEF_NAME = /@(?:typedef|callback)\s+(?:\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}\s+)?([A-Za-z_$][\w$]*)/g;

/** The names a JSDoc block declares with @typedef or @callback. */
export function typedefNames(block) {
    return [...block.matchAll(TYPEDEF_NAME)].map((m) => m[1]);
}

/**
 * Typedef blocks of the branch's version that the working-tree version lacks. A file kept as
 * ours (conflict) or resolved towards ours (partial) would otherwise miss the named types the
 * rest of the ported tree imports from it. Types only: a block is comment text and sits
 * anywhere in the file. Appended at the end; a block that declares a name ours already has is skipped.
 */
export function transplantTypedefs(ours, theirs) {
    const have = new Set(typedefNames(ours));
    const add = [];
    for (const block of theirs.match(DOC_BLOCK) || []) {
        const names = typedefNames(block);
        if (names.length === 0 || /@(?:param|returns?)\b/.test(block)) continue;
        if (names.some((n) => have.has(n))) continue;
        names.forEach((n) => have.add(n));
        add.push(block);
    }
    if (add.length === 0) return ours;
    return `${ours.replace(/\n*$/, '\n')}\n${add.join('\n\n')}\n`;
}

/**
 * Decide one file. `ours`/`base`/`theirs` are texts or null (absent).
 * Returns { outcome, text } with outcome clean | same | conflict | gone | added.
 */
const withTypedefs = (text, theirs) => transplantTypedefs(text, stripMarker(theirs).text);

export function portOne({ ours, base, theirs }) {
    if (theirs === null) return { outcome: 'same', text: ours };
    if (ours === null) return base === null ? { outcome: 'added', text: theirs } : { outcome: 'gone', text: null };
    if (base === null) return { outcome: ours === theirs ? 'same' : 'conflict', text: ours };
    const o = stripMarker(ours);
    const b = stripMarker(base);
    const t = stripMarker(theirs);
    const { text, conflicts, partial } = mergeTexts(o.text, b.text, t.text);
    if (conflicts > 0) return { outcome: 'conflict', text: withTypedefs(ours, theirs) };
    const winner = RANK[markerLevel(t.marker)] >= RANK[markerLevel(o.marker)] ? t : o;
    const merged = insertMarker(text, winner.marker, winner.anchor);
    if (partial) return { outcome: 'partial', text: withTypedefs(merged, theirs) };
    return { outcome: merged === ours ? 'same' : 'clean', text: merged };
}

function git(cwd, args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function show(cwd, rev, file) {
    const r = spawnSync('git', ['show', `${rev}:${file}`], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
}

const SOURCE = /\.[cm]?js$/;

/** Port every changed source file under `paths`. Returns the per-file results. */
export function portBranch({ cwd, branch, base, paths = ['server'], write = true }) {
    const names = git(cwd, ['diff', '--name-only', base, branch, '--', ...paths]).split('\n').filter(Boolean);
    const results = [];
    for (const file of names) {
        if (!SOURCE.test(file)) continue;
        const abs = path.join(cwd, file);
        const ours = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
        const res = portOne({ ours, base: show(cwd, base, file), theirs: show(cwd, branch, file) });
        results.push({ file, outcome: res.outcome });
        if (write && res.text !== ours && res.text !== null) {
            mkdirSync(path.dirname(abs), { recursive: true });
            writeFileSync(abs, res.text);
        }
    }
    return results;
}

export function summarise(results) {
    const counts = {};
    for (const r of results) counts[r.outcome] = (counts[r.outcome] || 0) + 1;
    return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2);
    const val = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
    const branch = val('--branch');
    const base = val('--base');
    if (!branch || !base) {
        console.error('port-jsdoc-branch: usage: --branch <rev> --base <rev> [--dry-run] [--paths server] [--list-out f] [--report-out f]');
        process.exit(2);
    }
    const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const results = portBranch({ cwd, branch, base, paths: (val('--paths') || 'server').split(','), write: !args.includes('--dry-run') });
    const summary = summarise(results);
    const listOut = val('--list-out');
    if (listOut) writeFileSync(listOut, `${results.filter((r) => r.outcome === 'conflict' || r.outcome === 'partial').map((r) => r.file).join('\n')}\n`);
    const reportOut = val('--report-out');
    if (reportOut) writeFileSync(reportOut, `${JSON.stringify({ summary, results }, null, 2)}\n`);
    console.log(`port-jsdoc-branch${args.includes('--dry-run') ? ' (dry run)' : ''}: ${JSON.stringify(summary)}`);
}
