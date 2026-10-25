#!/usr/bin/env node
/**
 * Make a mechanical round clean again by undoing what broke it.
 *
 * A codemod or a port edits hundreds of server files; a few of those edits type a value that
 * another file then misuses, and `npm run typecheck` reports the error in THAT file. This reads
 * a typecheck output and goes back to HEAD for the edited files that cause the errors, round by
 * round, until the output has no error left:
 *   - an error in an edited file: that file goes back to HEAD;
 *   - an error in a file nobody edited: the edited files it takes its types from go back. First the
 *     ones it names on the failing line(s) (through its `require`s), else the nearest edited file
 *     in its require graph, breadth first.
 * Nothing is fixed by hand and nothing is silenced: what is undone is simply not done yet.
 *
 *   node scripts/typecheck-settle.mjs <typecheck-output.txt> [--dry-run]
 * Prints what it reverted; exit 0 when it reverted something (run the typecheck again), 3 when no
 * edited file is to blame and errors remain.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');
const REQUIRE = /(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
const MAX_DEPTH = 6;

/** `file(line,col): error TSn: ...` lines of a typecheck output -> [{ file, line }]. */
export function parseErrors(output) {
    const out = [];
    for (const l of output.split('\n')) {
        const m = /^(.+?)\((\d+),\d+\): error TS\d+/.exec(l);
        if (m) out.push({ file: m[1], line: Number(m[2]) });
    }
    return out;
}

/** Local requires of a source text: name bound -> specifier, plus every specifier. */
export function requiresOf(text) {
    const names = new Map();
    const specs = new Set();
    for (const m of text.matchAll(REQUIRE)) {
        specs.add(m[2]);
        const bound = m[1].startsWith('{') ? m[1].slice(1, -1).split(',').map((s) => s.split(':').pop().trim().split('=')[0].trim()).filter(Boolean) : [m[1]];
        for (const n of bound) names.set(n, m[2]);
    }
    // A lazy `require('../x').y(...)` inside a function counts as a dependency too.
    for (const m of text.matchAll(/\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g)) specs.add(m[1]);
    return { names, specs: [...specs] };
}

const resolveSpec = (dir, from, spec) => {
    const base = path.resolve(path.dirname(path.join(dir, from)), spec);
    for (const c of [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.mts`, path.join(base, 'index.js')]) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.relative(dir, c);
    }
    return null;
};

/**
 * Which edited files to undo for the errors of file `f` (server-relative).
 * @param {string} f
 * @param {{ line: number }[]} errors
 * @param {Set<string>} edited server-relative paths with uncommitted edits
 * @param {string} dir
 */
export function culpritsFor(f, errors, edited, dir = SERVER) {
    if (edited.has(f)) return [f];
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const lines = text.split('\n');
    const { names, specs } = requiresOf(text);
    const direct = new Set();
    for (const e of errors) {
        const context = lines.slice(Math.max(0, e.line - 4), e.line).join(' ');
        for (const tok of context.match(/[A-Za-z_$][\w$]*/g) || []) {
            const spec = names.get(tok);
            const target = spec && resolveSpec(dir, f, spec);
            if (target && edited.has(target)) direct.add(target);
        }
    }
    if (direct.size) return [...direct];
    const seen = new Set([f]);
    let frontier = specs.map((s) => resolveSpec(dir, f, s)).filter(Boolean);
    frontier.forEach((x) => seen.add(x));
    for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
        const hit = frontier.filter((x) => edited.has(x));
        if (hit.length) return hit;
        const next = [];
        for (const g of frontier) {
            let r;
            try { r = requiresOf(fs.readFileSync(path.join(dir, g), 'utf8')); } catch { continue; }
            for (const s of r.specs) {
                const h = resolveSpec(dir, g, s);
                if (h && !seen.has(h)) { seen.add(h); next.push(h); }
            }
        }
        frontier = next;
    }
    return [];
}

export function editedFiles(root = ROOT) {
    const out = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', 'server'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });
    return new Set(out.split('\n').filter((l) => l.startsWith('server/')).map((l) => l.slice('server/'.length)));
}

export function settle(output, { root = ROOT, dryRun = false } = {}) {
    const dir = path.join(root, 'server');
    const edited = editedFiles(root);
    const byFile = new Map();
    for (const e of parseErrors(output)) (byFile.get(e.file) || byFile.set(e.file, []).get(e.file)).push(e);
    const revert = new Set();
    const blameless = [];
    for (const [f, errs] of byFile) {
        const c = culpritsFor(f, errs, edited, dir);
        if (c.length === 0) blameless.push(f);
        c.forEach((x) => revert.add(x));
    }
    if (!dryRun) for (const f of revert) execFileSync('git', ['checkout', 'HEAD', '--', `server/${f}`], { cwd: root });
    return { reverted: [...revert].sort(), blameless: blameless.sort(), errorFiles: byFile.size };
}

if (isEntryPoint(import.meta.url)) {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith('--'));
    if (!file) {
        console.error('typecheck-settle: usage: node scripts/typecheck-settle.mjs <typecheck-output.txt> [--dry-run]');
        process.exit(2);
    }
    const r = settle(fs.readFileSync(file, 'utf8'), { dryRun: args.includes('--dry-run') });
    console.log(JSON.stringify({ errorFiles: r.errorFiles, reverted: r.reverted.length, blameless: r.blameless }, null, 1));
    process.exit(r.reverted.length ? 0 : r.errorFiles ? 3 : 0);
}
