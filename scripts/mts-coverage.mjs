#!/usr/bin/env node
/**
 * `.mts` coverage ratchet — the floor under the line coverage of a package's
 * TypeScript sources, which may only rise.
 *
 * The server's coverage floor (scripts/coverage-ratchet.mjs) is one number
 * over the whole tree, and the old JavaScript carries it: the `.mts` files,
 * where the new code goes, can sit far under it without the total moving.
 * This reads the same istanbul json-summary the suite already writes
 * (`coverage/coverage-summary.json`, one entry per file), adds up the lines of
 * the `.mts` files only and holds that share against its own floor.
 *
 * The floor sits one point under the measurement it was taken from, for the
 * reason coverage-ratchet.mjs gives: a few hundredths of run-to-run noise must
 * not turn into a red build.
 *
 * Floor: <package>/.mts-coverage-ratchet.json  { lines }
 *
 * Usage:
 *   node scripts/mts-coverage.mjs <package> [--summary <file>]            gate, with the totals per folder
 *   node scripts/mts-coverage.mjs <package> [--summary <file>] --update   raise the floor (never lowers it)
 *   node scripts/mts-coverage.mjs <package> [--summary <file>] --list     the 20 files with the most uncovered lines
 *
 * `--summary` defaults to <package>/coverage/coverage-summary.json. It needs a
 * coverage run, so check:fast leaves it out; ci.yml's server-coverage job runs
 * it on the merged report.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Folders whose files are grouped one level deeper: they hold most of the tree. */
const DEEP = new Set(['core', 'routes', 'stores', 'services', 'integrations']);

/** The folder a package-relative file is reported under. */
export function folderOf(file) {
    const parts = file.split('/');
    if (parts.length === 1) return '(root)';
    return DEEP.has(parts[0]) && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
}

/**
 * The `.mts` files of an istanbul json-summary, package-relative.
 * @param {Record<string, { lines?: { total: number, covered: number } }>} summary
 * @param {string} pkgDir
 * @returns {{ file: string, total: number, covered: number }[]}
 */
export function mtsFiles(summary, pkgDir) {
    const out = [];
    for (const [key, entry] of Object.entries(summary)) {
        if (key === 'total' || !key.endsWith('.mts') || !entry?.lines) continue;
        const file = (path.isAbsolute(key) ? path.relative(pkgDir, key) : key).split(path.sep).join('/');
        out.push({ file, total: entry.lines.total, covered: entry.lines.covered });
    }
    return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** Covered and total lines, and the share in percent (null when there are no lines). */
export function totals(files) {
    const total = files.reduce((n, f) => n + f.total, 0);
    const covered = files.reduce((n, f) => n + f.covered, 0);
    return { files: files.length, covered, total, pct: total === 0 ? null : (covered / total) * 100 };
}

/** Totals per folder, the folder with the most uncovered lines first. */
export function byFolder(files) {
    /** @type {Map<string, { file: string, total: number, covered: number }[]>} */
    const groups = new Map();
    for (const f of files) groups.set(folderOf(f.file), [...(groups.get(folderOf(f.file)) ?? []), f]);
    return [...groups].map(([folder, list]) => ({ folder, ...totals(list) })).sort((a, b) => (b.total - b.covered) - (a.total - a.covered) || a.folder.localeCompare(b.folder));
}

/** The floor a measurement supports: one point under it, whole percent. */
export const floorFor = (pct) => Math.max(0, Math.floor(pct) - 1);

/**
 * The verdict for a measured share against the floor file's content.
 * @param {number} pct
 * @param {{ lines: number } | null} floor
 * @param {boolean} update
 * @returns {{ status: 'write' | 'fail' | 'raise' | 'at', next?: number }}
 */
export function verdict(pct, floor, update) {
    const candidate = floorFor(pct);
    if (update || !floor) return { status: 'write', next: floor ? Math.max(floor.lines, candidate) : candidate };
    if (pct < floor.lines) return { status: 'fail' };
    return candidate > floor.lines ? { status: 'raise', next: candidate } : { status: 'at' };
}

function main(args) {
    const summaryAt = args.indexOf('--summary');
    const pkg = args.find((a, i) => !a.startsWith('--') && (summaryAt < 0 || i !== summaryAt + 1));
    if (!pkg || (summaryAt >= 0 && !args[summaryAt + 1])) {
        console.error('usage: node scripts/mts-coverage.mjs <package> [--summary <file>] [--update | --list]');
        process.exit(2);
    }
    const pkgDir = path.join(ROOT, pkg);
    const summaryFile = summaryAt >= 0 ? path.resolve(ROOT, args[summaryAt + 1]) : path.join(pkgDir, 'coverage', 'coverage-summary.json');
    if (!fs.existsSync(summaryFile)) {
        console.error(`mts-coverage: ${path.relative(ROOT, summaryFile)} not found — run the suite with coverage first. A missing report is not a pass.`);
        process.exit(2);
    }
    const files = mtsFiles(JSON.parse(fs.readFileSync(summaryFile, 'utf8')), pkgDir);
    const all = totals(files);
    if (all.pct === null) {
        console.error(`mts-coverage: ${path.relative(ROOT, summaryFile)} holds no .mts file with lines. A report without them is not a pass.`);
        process.exit(2);
    }
    const line = (label, t) => `${label.padEnd(34)} ${String(t.files).padStart(4)}  ${String(t.covered).padStart(6)} / ${String(t.total).padStart(6)}  ${(t.pct ?? 0).toFixed(1).padStart(5)}%  ${String(t.total - t.covered).padStart(6)} uncovered`;
    if (args.includes('--list')) {
        for (const f of [...files].sort((a, b) => (b.total - b.covered) - (a.total - a.covered)).slice(0, 20)) {
            console.log(`${String(f.total - f.covered).padStart(5)} uncovered  ${(f.total === 0 ? 0 : (f.covered / f.total) * 100).toFixed(1).padStart(5)}%  ${f.file}`);
        }
        console.log('');
    }
    for (const f of byFolder(files)) console.log(line(f.folder, f));
    console.log(line('total', all));
    console.log('');

    const update = args.includes('--update');
    if (args.includes('--list') && !update) return;
    const floorFile = path.join(pkgDir, '.mts-coverage-ratchet.json');
    const floor = fs.existsSync(floorFile) ? JSON.parse(fs.readFileSync(floorFile, 'utf8')) : null;
    const v = verdict(all.pct, floor, update);
    const shown = all.pct.toFixed(2);
    if (v.status === 'write') {
        const next = {
            _comment: `Lowest line coverage (percent) the .mts files of ${pkg} may report. Raise it with \`node scripts/mts-coverage.mjs ${pkg} --update\` after adding tests; lowering it is a deliberate edit that belongs in a commit message with a reason.`,
            _generated: new Date().toISOString().slice(0, 10),
            lines: v.next,
        };
        fs.writeFileSync(floorFile, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Floor written to ${path.relative(ROOT, floorFile)}: ${v.next}% (measured ${shown}%)`);
    } else if (v.status === 'fail') {
        console.error(`❌ ${pkg}: .mts line coverage ${shown}% is under the floor of ${floor.lines}% — add tests for the TypeScript this change brought in, rather than lowering the floor (\`--list\` shows the least covered files)`);
        process.exit(1);
    } else if (v.status === 'raise') {
        console.log(`✅ ${pkg}: .mts line coverage ${shown}%, floor ${floor.lines}%. Run \`node scripts/mts-coverage.mjs ${pkg} --update\` to raise it to ${v.next}%.`);
    } else {
        console.log(`➖ ${pkg}: .mts line coverage ${shown}%, floor ${floor.lines}%`);
    }
}

if (isEntryPoint(import.meta.url)) main(process.argv.slice(2));
