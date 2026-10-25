#!/usr/bin/env node
// split-big: bring a server source file under the file-budget limit by moving a cohesive
// group of top-level declarations (roots plus everything they reference, transitively) into
// a same-directory sibling. Built on ts-outline (the declaration graph) and ts-split (the move).
//
//   node scripts/split-big.mjs <file...> [--limit 400] [--max-sibling 380] [--dry] [--rounds 3]
//
// For each file over the limit:
//   1. read the declaration graph (ts-outline --json);
//   2. choose roots greedily until their closure fills a sibling (<= --max-sibling lines);
//      the closure may include shared helpers: the old file then imports them back from the
//      sibling, so the sibling never imports the old file;
//   3. ts-split moves the closure to `<base><FirstRoot>.js`; the sibling gets the old file's
//      `// @typecheck` marker (the new-code rule wants `strict`; the caller runs the server
//      typecheck and reverts what it cannot satisfy);
//   4. repeat (up to --rounds) while the old file is still over the limit.
// A file with a test that couples to its PATH (resolve-by-parent stubs, readFileSync of the
// file) is skipped: the split would break that test silently. Behaviour never changes: only
// where declarations live.
//
// Prints one JSON line per file: { file, status, siblings, before, after }.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The names a set of roots needs, transitively (the roots included).
 * @param {Map<string, { refs: string[] }>} byName
 * @param {string[]} roots
 */
export function closureOf(byName, roots) {
    const out = new Set();
    const stack = [...roots];
    while (stack.length) {
        const n = /** @type {string} */ (stack.pop());
        if (out.has(n) || !byName.has(n)) continue;
        out.add(n);
        for (const r of /** @type {{ refs: string[] }} */ (byName.get(n)).refs) stack.push(r);
    }
    return out;
}

/**
 * Choose what to move. Roots are tried in source order, then largest first; a root joins when the
 * closure of the chosen roots still fits `maxSibling` lines. The result must take at least `need`
 * lines out of the file, or null.
 * @param {Array<{ kind: string, name: string, size: number, refs: string[] }>} decls
 * @param {{ need: number, maxSibling: number, skip?: Set<string> }} opts
 * @returns {{ names: string[], lines: number, roots: string[] } | null}
 */
export function plan(decls, { need, maxSibling, skip = new Set() }) {
    // Aim for a balanced split: take what the file must give up plus some slack, not the largest
    // closure that fits (that would leave a stub behind).
    const wanted = Math.min(maxSibling, Math.max(need + 40, Math.round(need * 1.5)));
    const byName = new Map(decls.map((d) => [d.name, d]));
    const sizeOf = (/** @type {Set<string>} */ set) => [...set].reduce((s, n) => s + (byName.get(n)?.size ?? 0), 0);
    const movable = decls.filter((d) => d.kind !== 'stmt' && !skip.has(d.name));
    const orders = [movable, [...movable].sort((a, b) => b.size - a.size)];
    for (const order of orders) {
        const roots = [];
        let closure = new Set();
        for (const d of order) {
            const next = closureOf(byName, [...roots, d.name]);
            if ([...next].some((n) => skip.has(n))) continue;
            const grown = sizeOf(next);
            if (grown > wanted && !(sizeOf(closure) < need && grown <= maxSibling)) continue;
            roots.push(d.name);
            closure = next;
        }
        const lines = sizeOf(closure);
        if (lines >= need) return { names: [...closure], lines, roots };
    }
    return null;
}

const cap = (/** @type {string} */ s) => s.charAt(0).toUpperCase() + s.slice(1);
/** CONSTANT_CASE names read badly inside a file name: UpperCamel them. */
const camel = (/** @type {string} */ s) => (/^[A-Z0-9_]+$/.test(s) ? s.toLowerCase().replace(/_+([a-z0-9])/g, (_m, c) => c.toUpperCase()) : s);

/** Sibling file name for a split of `file`, named after its first root. */
export function siblingName(file, firstRoot, taken = (/** @type {string} */ _t) => false) {
    const dir = path.dirname(file);
    const base = path.basename(file).replace(/\.[cm]?js$/, '');
    const word = cap(camel(firstRoot.replace(/^_+/, '')).replace(/[^A-Za-z0-9]/g, '')).slice(0, 32) || 'Part';
    let name = `${base}${word}`;
    for (let i = 2; taken(path.join(dir, `${name}.js`)); i += 1) name = `${base}${word}${i}`;
    return path.join(dir, `${name}.js`);
}

function node(args) {
    return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 27 });
}

/** @param {string} abs */
function lineCount(abs) { return fs.readFileSync(abs, 'utf8').split('\n').length; }

/**
 * @param {string} file repo-relative path of a server source file
 * @param {{ limit: number, maxSibling: number, dry: boolean, rounds: number }} o
 */
export function splitFile(file, o) {
    const abs = path.join(ROOT, file);
    const before = lineCount(abs);
    const marker = (fs.readFileSync(abs, 'utf8').slice(0, 600).match(/^\/\/ @typecheck.*$/m) || [''])[0];
    const siblings = [];
    const skip = new Set();
    for (let round = 0; round < o.rounds && lineCount(abs) > o.limit; round += 1) {
        const r = node(['scripts/ts-outline.mjs', file, '--json']);
        let j;
        try { j = JSON.parse(r.stdout); } catch { return { file, status: 'outline-failed', siblings, before, after: lineCount(abs) }; }
        if (j.module !== 'cjs') return { file, status: 'not-cjs', siblings, before, after: before };
        if ((j.testCouplings || []).length) return { file, status: 'test-coupling', siblings, before, after: before };
        const need = lineCount(abs) - o.limit + 8;
        let moved = false;
        for (let attempt = 0; attempt < 6 && !moved; attempt += 1) {
            const p = plan(j.declarations, { need, maxSibling: o.maxSibling, skip });
            if (!p) break;
            const sizeByName = new Map(j.declarations.map((/** @type {any} */ x) => [x.name, x.kind === 'fn' || x.kind === 'class' ? x.size : 0]));
            const nameRoot = [...p.roots].sort((x, y) => (sizeByName.get(y) ?? 0) - (sizeByName.get(x) ?? 0))[0];
            const target = siblingName(abs, nameRoot, (t) => fs.existsSync(t));
            const args = ['scripts/ts-split.mjs', file, '--move', p.names.join(','), '--to', path.relative(ROOT, target)];
            if (o.dry) args.push('--dry');
            const s = node(args);
            let res;
            try { res = JSON.parse(s.stdout); } catch { res = { refused: [{ name: p.roots[0], reason: s.stderr.slice(0, 120) }] }; }
            if (res.refused && res.refused.length) {
                for (const x of res.refused) skip.add(x.name);
                for (const x of res.refused) for (const n of x.dependsOn || []) void n;
                continue;
            }
            moved = true;
            if (!o.dry) {
                siblings.push(path.relative(ROOT, target));
                if (marker) {
                    const text = fs.readFileSync(target, 'utf8');
                    // ts-split writes a plain `// @typecheck`; the sibling carries the level of the file it came from.
                    if (/^\/\/ @typecheck.*$/m.test(text.slice(0, 600))) fs.writeFileSync(target, text.replace(/^\/\/ @typecheck.*$/m, marker));
                    else fs.writeFileSync(target, `${marker}\n${text}`);
                }
            } else siblings.push(path.relative(ROOT, target));
        }
        if (!moved) break;
        if (o.dry) break;
    }
    return { file, status: siblings.length ? (lineCount(abs) > o.limit ? 'partial' : 'ok') : 'nothing-to-move', siblings, before, after: lineCount(abs) };
}

function main(argv) {
    const num = (/** @type {string} */ flag, /** @type {number} */ d) => { const i = argv.indexOf(flag); return i >= 0 ? Number(argv[i + 1]) : d; };
    const flagVals = new Set(['--limit', '--max-sibling', '--rounds']);
    const files = argv.filter((a, i) => !a.startsWith('--') && !flagVals.has(argv[i - 1]));
    if (!files.length) {
        console.error('usage: node scripts/split-big.mjs <file...> [--limit 400] [--max-sibling 380] [--rounds 3] [--dry]');
        return 2;
    }
    const o = { limit: num('--limit', 400), maxSibling: num('--max-sibling', 380), dry: argv.includes('--dry'), rounds: num('--rounds', 3) };
    for (const f of files) console.log(JSON.stringify(splitFile(f.replace(/^\.\//, ''), o)));
    return 0;
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
