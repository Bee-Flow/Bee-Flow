#!/usr/bin/env node
/**
 * tsc error ratchet: the number of errors `tsc -p <package>/tsconfig.strict.json`
 * reports may only go DOWN.
 *
 * A package that checks its plain JS loosely (`npm run typecheck`, clean) can
 * still have a strict config next to it: every `noImplicitAny` and null error
 * it would raise is counted here, the budget lives in
 * `<package>/.tsc-strict-ratchet.json`, and `--update` only lowers it. Fixing a
 * file (JSDoc types) shows up as a smaller number; adding untyped code fails.
 *
 * Usage:
 *   node scripts/tsc-error-ratchet.mjs <package>            gate
 *   node scripts/tsc-error-ratchet.mjs <package> --update   lower the budget (or write the first one)
 *   options: --tsc <path-to-tsc.js>   default <package>/node_modules/typescript/bin/tsc (or lib/tsc.js)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Count of `error TSxxxx` diagnostics in tsc's output (continuation lines are indented and not counted). */
export function countErrors(output) {
    return output.split('\n').filter((l) => /^\S.*: error TS\d+:/.test(l)).length;
}

/** Errors per TS code, for the report. */
export function byCode(output) {
    const out = {};
    for (const l of output.split('\n')) {
        const m = /: error (TS\d+):/.exec(l);
        if (m && /^\S/.test(l)) out[m[1]] = (out[m[1]] || 0) + 1;
    }
    return out;
}

function findTsc(dir) {
    for (const rel of ['node_modules/typescript/bin/tsc', 'node_modules/typescript/lib/tsc.js']) {
        const p = path.join(dir, rel);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function main() {
    const args = process.argv.slice(2);
    const update = args.includes('--update');
    const tscAt = args.indexOf('--tsc');
    const pkg = args.find((a, i) => !a.startsWith('--') && (tscAt < 0 || i !== tscAt + 1));
    if (!pkg) {
        console.error('tsc-error-ratchet: usage: node scripts/tsc-error-ratchet.mjs <package> [--update] [--tsc <path>]');
        process.exit(2);
    }
    const dir = path.resolve(ROOT, pkg);
    const config = path.join(dir, 'tsconfig.strict.json');
    const budgetFile = path.join(dir, '.tsc-strict-ratchet.json');
    if (!fs.existsSync(config)) {
        console.error(`tsc-error-ratchet: ${path.relative(ROOT, config)} not found`);
        process.exit(2);
    }
    const tsc = tscAt >= 0 ? path.resolve(args[tscAt + 1]) : findTsc(dir);
    if (!tsc) {
        console.error(`tsc-error-ratchet: typescript is not installed in ${pkg}; run npm ci there first. A missing compiler is not a pass.`);
        process.exit(2);
    }
    const res = spawnSync(process.execPath, [tsc, '-p', config, '--noEmit', '--pretty', 'false'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const count = countErrors(output);
    if (res.status !== 0 && count === 0) {
        console.error(`tsc-error-ratchet: tsc failed without reporting errors:\n${output.slice(0, 2000)}`);
        process.exit(2);
    }
    const existing = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : null;
    const codes = Object.entries(byCode(output)).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, n]) => `${c} ${n}`).join(', ');

    if (update || !existing) {
        const budget = existing ? Math.min(existing.errors, count) : count;
        fs.writeFileSync(budgetFile, `${JSON.stringify({
            _comment: `Most errors \`tsc -p ${pkg}/tsconfig.strict.json\` may report. Lower it with \`node scripts/tsc-error-ratchet.mjs ${pkg} --update\` after typing code; raising it is a deliberate edit that belongs in a commit message with a reason.`,
            _generated: new Date().toISOString().slice(0, 10),
            errors: budget,
        }, null, 2)}\n`);
        console.log(`Budget written to ${path.relative(ROOT, budgetFile)}: ${budget} (measured ${count}${codes ? `; ${codes}` : ''})`);
        return;
    }
    if (count > existing.errors) {
        console.error(`❌ ${pkg}: ${count} strict type errors, budget ${existing.errors}${codes ? ` (${codes})` : ''}. Type the new code instead of raising the budget.`);
        process.exit(1);
    }
    if (count < existing.errors) {
        console.log(`✅ ${pkg}: ${count} strict type errors, budget ${existing.errors}. Run \`node scripts/tsc-error-ratchet.mjs ${pkg} --update\` to lower it.`);
    } else {
        console.log(`➖ ${pkg}: ${count} strict type errors, at budget`);
    }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
