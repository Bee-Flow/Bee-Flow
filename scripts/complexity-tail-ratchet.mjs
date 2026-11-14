#!/usr/bin/env node
/**
 * Complexity tail ratchet — the number of functions above a cyclomatic
 * complexity of 40 may only go down.
 *
 * The eslint gate (scripts/eslint-budget.mjs) holds the `complexity` rule at
 * 15 and suppresses the old violations per file and rule. A suppression is a
 * COUNT of violations, not their size: a function at 20 can grow to 90 and
 * the file still carries one complexity violation. This gate counts the tail,
 * the functions far above the limit, with the package's own eslint and its
 * own config (so the files the config exempts, tests and run-once code, stay
 * exempt), and fails when there are more than the budget allows.
 *
 * Only the `complexity` rule runs (ESLint's ruleFilter); its message carries
 * the measured complexity. The suppressions file is not applied: every
 * function is counted, suppressed or not.
 *
 * Budget: <package>/.complexity-tail-ratchet.json  { threshold, count }
 *
 * Usage:
 *   node scripts/complexity-tail-ratchet.mjs <package>            gate
 *   node scripts/complexity-tail-ratchet.mjs <package> --update   lower the budget (never raises it)
 *   node scripts/complexity-tail-ratchet.mjs <package> --list     the functions above the threshold, largest first
 *
 * It loads the package's eslint (needs <package>/node_modules) and parses the
 * whole package (~40 s on server), so check:fast leaves it out and ci.yml's
 * server lint job runs it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Functions above this complexity are the tail. */
export const DEFAULT_THRESHOLD = 40;

/**
 * The functions an eslint result list reports above `threshold`.
 * @param {{ filePath: string, messages: { ruleId: string | null, message: string, line: number }[] }[]} results
 * @param {string} pkgDir
 * @param {number} threshold
 * @returns {{ file: string, line: number, complexity: number, name: string }[]}
 */
export function tailOf(results, pkgDir, threshold) {
    const out = [];
    for (const result of results) {
        for (const m of result.messages) {
            if (m.ruleId !== 'complexity') continue;
            const match = /^(.*?) has a complexity of (\d+)\./.exec(m.message);
            if (!match) continue;
            const complexity = Number(match[2]);
            if (complexity <= threshold) continue;
            const file = path.relative(pkgDir, result.filePath).split(path.sep).join('/');
            out.push({ file, line: m.line, complexity, name: match[1] });
        }
    }
    return out.sort((a, b) => b.complexity - a.complexity || a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * The verdict for a measured count against the budget file's content.
 * @param {number} count
 * @param {{ count: number } | null} budget
 * @param {boolean} update
 * @returns {{ status: 'write' | 'fail' | 'under' | 'at', next?: number }}
 */
export function verdict(count, budget, update) {
    if (update || !budget) return { status: 'write', next: budget ? Math.min(count, budget.count) : count };
    if (count > budget.count) return { status: 'fail' };
    return { status: count < budget.count ? 'under' : 'at' };
}

/** @param {string} pkgDir @param {number} threshold */
async function measure(pkgDir, threshold) {
    // The package's own eslint, resolved from its node_modules at run time
    // (the root has none, so the specifier is not a literal the type check resolves).
    const require = createRequire(path.join(pkgDir, 'package.json'));
    const eslintModule = 'eslint';
    const { ESLint } = require(eslintModule);
    const eslint = new ESLint({ cwd: pkgDir, ruleFilter: ({ ruleId }) => ruleId === 'complexity' });
    return tailOf(await eslint.lintFiles(['.']), pkgDir, threshold);
}

async function main(args) {
    const pkg = args.find((a) => !a.startsWith('--'));
    if (!pkg) {
        console.error('usage: node scripts/complexity-tail-ratchet.mjs <package> [--update | --list]');
        process.exit(2);
    }
    const pkgDir = path.join(ROOT, pkg);
    const budgetFile = path.join(pkgDir, '.complexity-tail-ratchet.json');
    const budget = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : null;
    const threshold = budget?.threshold ?? DEFAULT_THRESHOLD;
    const update = args.includes('--update');
    const tail = await measure(pkgDir, threshold);

    if (args.includes('--list')) {
        for (const f of tail) console.log(`${String(f.complexity).padStart(4)}  ${f.file}:${f.line}  ${f.name}`);
        console.log('');
        if (!update) process.exit(0);
    }
    const v = verdict(tail.length, budget, update);
    const what = `functions above complexity ${threshold}`;
    if (v.status === 'write') {
        const next = {
            _comment: `Highest number of ${what} ${pkg} may still carry (eslint's complexity rule, the package's own config). Lower it with \`node scripts/complexity-tail-ratchet.mjs ${pkg} --update\` after a refactor; raising it is a deliberate edit that belongs in a commit message with a reason.`,
            _generated: new Date().toISOString().slice(0, 10),
            threshold,
            count: v.next,
        };
        fs.writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Budget written to ${path.relative(ROOT, budgetFile)}: ${v.next} ${what} (measured ${tail.length})`);
    } else if (v.status === 'fail') {
        console.error(`❌ ${pkg}: ${tail.length} ${what}, budget is ${budget.count} — split the new or grown function (a handler per case, a helper per step) rather than raising the budget (\`--list\` shows them)`);
        process.exit(1);
    } else if (v.status === 'under') {
        console.log(`✅ ${pkg}: ${tail.length} ${what}, under the budget of ${budget.count}. Run \`node scripts/complexity-tail-ratchet.mjs ${pkg} --update\` to lower it.`);
    } else {
        console.log(`➖ ${pkg}: ${tail.length} ${what}, at budget`);
    }
}

if (isEntryPoint(import.meta.url)) await main(process.argv.slice(2));
