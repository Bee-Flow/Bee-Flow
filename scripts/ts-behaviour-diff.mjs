#!/usr/bin/env node
// The behaviour diff of a conversion round, over EVERY changed source file:
// not only the files a tool converted (scripts/ts-equivalence.mjs checks
// those renames), but every modified or renamed .js/.jsx/.ts/.tsx/.mjs/.cjs
// between BASE and the working tree (or HEAD), compiled with esbuild (types
// stripped) and compared line by line. A type-only edit is identical; a guard
// an agent added, a dropped prop, a changed argument shows up as `+`/`-`
// compiled lines.
//
//   node scripts/ts-behaviour-diff.mjs --base <rev> [--head <rev>] [--paths agent-hub/src,server]
//                                      [--report round.json] [--baseline previous.json] [--quiet]
//
// --report writes every difference ({ file, oldPath, removed, added }).
// --baseline is the report of the previous round: a difference already there
// is REVIEWED (printed as such), a line that is new since then is NEW. That is
// how a guard a reviewer restored cannot come back unnoticed in the next
// round: it reappears as a NEW `+` line. Exit 1 on any new difference (on any
// difference without a baseline), 0 otherwise. Needs server/'s esbuild
// (`cd server && npm ci`).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile, hasEsbuild, ESBUILD_HINT } from './ts-equivalence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

const SOURCE = /\.(?:[cm]?jsx?|tsx?)$/;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$|\/__tests__\//;

/** `git diff --name-status` lines -> [{ status, oldPath, path }] for source files (tests left out). */
export function changedFiles(nameStatus) {
    const out = [];
    for (const line of nameStatus.split('\n')) {
        const m = line.match(/^([AMDR])\d*\t(\S+)(?:\t(\S+))?$/);
        if (!m) continue;
        const [, status, a, b] = m;
        const p = status === 'R' ? b : a;
        if (!SOURCE.test(p) || TEST.test(p) || status === 'A' || status === 'D') continue;
        out.push({ status, oldPath: a, path: p });
    }
    return out;
}

/** The lines of `report` that `baseline` (an earlier report) did not already hold, per file. */
export function newSince(report, baseline) {
    const prev = new Map((baseline || []).map((r) => [r.path, r]));
    return report.map((r) => {
        const b = prev.get(r.path);
        const removed = r.removed.filter((l) => !b || !b.removed.includes(l));
        const added = r.added.filter((l) => !b || !b.added.includes(l));
        return { ...r, newRemoved: removed, newAdded: added, isNew: !b || removed.length > 0 || added.length > 0 };
    });
}

function arg(name, fallback) { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; }

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const base = arg('--base'); const head = arg('--head', null);
    if (!base) { console.error('usage: node scripts/ts-behaviour-diff.mjs --base <rev> [--head <rev>] [--paths a,b] [--report out.json] [--baseline prev.json]'); process.exit(2); }
    if (!hasEsbuild()) { console.error(ESBUILD_HINT); process.exit(2); }
    const paths = arg('--paths', 'agent-hub/src,server').split(',').filter(Boolean);
    const quiet = process.argv.includes('--quiet');
    const range = head ? [base, head] : [base];
    const files = changedFiles(git('diff', '--name-status', '-M40%', '-l100000', ...range, '--', ...paths));
    const report = [];
    for (const f of files) {
        let before; let after;
        try { before = git('show', `${base}:${f.oldPath}`); } catch { continue; }
        if (head) { try { after = git('show', `${head}:${f.path}`); } catch { continue; } } else {
            const abs = path.join(ROOT, f.path); if (!fs.existsSync(abs)) continue;
            after = fs.readFileSync(abs, 'utf8');
        }
        const a = await compile(before); const b = await compile(after);
        if (a.length === b.length && a.every((l, i) => l === b[i])) continue;
        const sa = new Set(a); const sb = new Set(b);
        report.push({ path: f.path, oldPath: f.oldPath, status: f.status, removed: a.filter((l) => !sb.has(l)), added: b.filter((l) => !sa.has(l)) });
    }
    const baseline = arg('--baseline') ? JSON.parse(fs.readFileSync(arg('--baseline'), 'utf8')) : null;
    const marked = newSince(report, baseline);
    if (arg('--report')) fs.writeFileSync(arg('--report'), JSON.stringify(report, null, 1));
    let fresh = 0;
    for (const r of marked) {
        if (!r.isNew) { if (!quiet) console.log(`REVIEWED  ${r.path}`); continue; }
        fresh++;
        console.log(`${baseline ? 'NEW       ' : 'DIFFERENT '}${r.path}${r.oldPath !== r.path ? ` (was ${r.oldPath})` : ''}`);
        if (!quiet) for (const l of r.newRemoved) console.log(`- ${l}`);
        if (!quiet) for (const l of r.newAdded) console.log(`+ ${l}`);
    }
    console.log(`${files.length} changed source file(s), ${report.length} with a different compiled program, ${fresh} ${baseline ? 'new since the baseline' : 'in all'}`);
    process.exit(fresh ? 1 : 0);
}
