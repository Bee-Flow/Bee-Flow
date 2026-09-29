#!/usr/bin/env node
/**
 * Count the tests that assert on SOURCE TEXT instead of on behaviour.
 *
 * Such a test reads a file with `readFileSync` and then matches a regex
 * against its contents. It pins the SHAPE of the code rather than what the
 * code does, which fails twice over: it goes red on a harmless rename, and it
 * stays green when the behaviour it was meant to protect breaks. Fase 2,
 * punt 8 is the work of replacing them; this script is how that work is
 * measured, so the number in the progress table can be re-run instead of
 * believed.
 *
 * The heuristic: a variable is "source text" if it is assigned from a
 * `readFileSync` call (directly, or via a `.toString()`/template hop), and an
 * assertion counts if it names such a variable. That deliberately UNDER-counts
 * — a file that hides the read behind its own helper slips through — so treat
 * the output as a floor, never as a ceiling.
 *
 * One exception: a variable assigned from `JSON.parse(readFileSync(...))`
 * (directly, or with a `.toString()`/template hop between the read and the
 * parse) holds PARSED DATA, not source text — the assertion is about a value,
 * the same as if it had come from any other API. That variable is excluded
 * from `held` even though the read is right there.
 *
 * With --gate it is also a ratchet, the same contract as
 * scripts/ts-ratchet.mjs: <dir>/.source-text-ratchet.json holds the number of
 * assertions the directory may still carry, the gate fails when a change
 * raises it, and --update lowers it after a conversion and never raises it.
 * Without the gate the number could slide back up unnoticed, and a count
 * that only moves when someone happens to re-run it is a statistic, not a
 * check.
 *
 * Usage:
 *   node scripts/source-text-tests.mjs server
 *   node scripts/source-text-tests.mjs server/routes server/core --list
 *   node scripts/source-text-tests.mjs server --gate      fail above the budget
 *   node scripts/source-text-tests.mjs server --update    lower the budget
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const list = args.includes('--list');
const gate = args.includes('--gate');
const update = args.includes('--update');
const roots = args.filter((a) => !a.startsWith('--'));
if (roots.length === 0) {
    console.error('usage: node scripts/source-text-tests.mjs <dir> [<dir>...] [--list] [--gate|--update]');
    process.exit(2);
}
if ((gate || update) && roots.length !== 1) {
    console.error('--gate and --update take exactly one directory: the budget file lives in it');
    process.exit(2);
}
// Zero is the goal state of this metric, so a mistyped path must never be
// able to report success. Refuse it instead.
for (const dir of roots) {
    if (!existsSync(dir)) {
        console.error(`no such directory: ${dir}`);
        process.exit(2);
    }
}

/** Every tracked *.test.js under the given roots — git, so node_modules is never in scope. */
function testFiles(dirs) {
    const out = execFileSync('git', ['ls-files', '--', ...dirs.map((d) => `${d}/**/*.test.js`), ...dirs.map((d) => `${d}/*.test.js`)], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
}

const READ = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*?)readFileSync\s*\(/g;
const ASSERT = /^\s*(?:assert\b|expect\s*\()/;
// The prefix right before `readFileSync(`, once trimmed, is exactly
// `JSON.parse(` — optionally through a namespace (`fs.`) and/or a template
// hop (`` `${ ``) — when the read feeds a parse rather than a text match.
const JSON_PARSE_WRAP = /^JSON\.parse\(\s*(?:`\$\{\s*)?(?:[A-Za-z_$][\w$]*\.)?$/;

function scan(file) {
    const src = readFileSync(file, 'utf8');
    const held = new Set();
    for (const m of src.matchAll(READ)) {
        if (JSON_PARSE_WRAP.test(m[2].trim())) continue;
        held.add(m[1]);
    }
    if (held.size === 0) return 0;

    // A multi-line assertion is one logical claim; count statements, not lines.
    const statements = src.split(/;\s*\n/);
    let hits = 0;
    for (const st of statements) {
        if (!ASSERT.test(st)) continue;
        if ([...held].some((v) => new RegExp(`\\b${v}\\b`).test(st))) hits += 1;
    }
    return hits;
}

let files = 0;
let assertions = 0;
const rows = [];
for (const file of testFiles(roots)) {
    const n = scan(file);
    if (n === 0) continue;
    files += 1;
    assertions += n;
    rows.push([n, file]);
}

if (list) {
    for (const [n, file] of rows.sort((a, b) => b[0] - a[0])) console.log(`${String(n).padStart(4)}  ${file}`);
    console.log('');
}
console.log(`${files} files, ${assertions} source-text assertions under ${roots.join(' ')}`);
console.log('(a floor: a file that reads through its own helper is not counted)');

if (gate || update) {
    const budgetFile = path.join(roots[0], '.source-text-ratchet.json');
    const existing = existsSync(budgetFile) ? JSON.parse(readFileSync(budgetFile, 'utf8')) : null;
    if (update || !existing) {
        const next = {
            _comment: `Highest number of source-text assertions ${roots[0]} may still carry. Lower it with \`node scripts/source-text-tests.mjs ${roots[0]} --update\` after a conversion; raising it is a deliberate edit that belongs in a commit message with a reason.`,
            _generated: new Date().toISOString().slice(0, 10),
            assertions: existing ? Math.min(assertions, existing.assertions) : assertions,
        };
        writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Budget written to ${budgetFile}: ${next.assertions} assertions (measured ${assertions})`);
    } else if (assertions > existing.assertions) {
        console.error(`❌ ${roots[0]}: ${assertions} source-text assertions, budget is ${existing.assertions} — assert on what the code does, not on what it says (\`--list\` shows where they are)`);
        process.exit(1);
    } else if (assertions < existing.assertions) {
        console.log(`✅ under the budget of ${existing.assertions}. Run \`node scripts/source-text-tests.mjs ${roots[0]} --update\` to lower it.`);
    } else {
        console.log('➖ at budget');
    }
}
