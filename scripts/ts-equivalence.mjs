#!/usr/bin/env node
// Proves a JavaScript -> TypeScript conversion changed nothing at runtime.
//
// For every rename of a .js/.jsx file to .ts/.tsx between BASE and HEAD, both
// versions are compiled with esbuild (types stripped, JSX preserved) and the
// JavaScript that comes out is compared. Identical output means the browser
// runs the same program: the conversion only added types. Two differences
// are ignored because they cannot change behaviour: an unused
// `import React from 'react'` (the automatic JSX runtime does not need it)
// and the extension in a relative import specifier (the bundler resolves it).
//
//   node scripts/ts-equivalence.mjs <base> [head]        exit 1 on any difference
//   node scripts/ts-equivalence.mjs <base> [head] --diff  also print each difference
//
// The esbuild is the one server/ locks (the same one that builds the editor
// bundles), so the comparison does not depend on agent-hub's toolchain.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = createRequire(path.join(ROOT, 'server', 'package.json'))('esbuild');

const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

/** The lines of the compiled program, without what cannot change behaviour. */
export function normalise(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1')
        .replace(/^\s*import\s+React\s+from\s+['"]react['"];?\s*$/gm, '')
        .replace(/(from\s+|import\(\s*)(['"])(\.{1,2}\/[^'"]+?)\.(?:jsx|js|tsx|ts)\2/g, '$1$2$3$2')
        .split('\n').map((l) => l.trim()).filter(Boolean);
}

export async function compile(source) {
    const { code } = await esbuild.transform(source, { loader: 'tsx', jsx: 'preserve', legalComments: 'none', format: 'esm', target: 'esnext' });
    return normalise(code);
}

/** The renames to check: [oldPath, newPath] for every .js/.jsx that became .ts/.tsx. */
export function renames(base, head) {
    // -l: without a rename limit git gives up on rename detection past ~1000
    // candidates (a stderr warning only), and every pair it skips goes unchecked.
    return git('diff', '--name-status', '-M40%', '-l100000', `${base}...${head}`, '--', 'agent-hub/src')
        .split('\n')
        .map((l) => l.match(/^R\d*\t(\S+\.jsx?)\t(\S+\.tsx?)$/))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]);
}

function unifiedDiff(a, b) {
    const sa = new Set(a), sb = new Set(b);
    return [...a.filter((l) => !sb.has(l)).map((l) => `- ${l}`), ...b.filter((l) => !sa.has(l)).map((l) => `+ ${l}`)].join('\n');
}

export async function check(base, head, { diff = false } = {}) {
    const results = [];
    for (const [oldPath, newPath] of renames(base, head)) {
        const a = await compile(git('show', `${base}:${oldPath}`));
        const b = await compile(git('show', `${head}:${newPath}`));
        const same = a.length === b.length && a.every((l, i) => l === b[i]);
        results.push({ oldPath, newPath, same, diff: same || !diff ? '' : unifiedDiff(a, b) });
    }
    return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const diff = args.includes('--diff');
    const [base, head = 'HEAD'] = args.filter((a) => !a.startsWith('--'));
    if (!base) { console.error('usage: node scripts/ts-equivalence.mjs <base> [head] [--diff]'); process.exit(2); }
    const results = await check(base, head, { diff });
    const bad = results.filter((r) => !r.same);
    for (const r of bad) console.log(`DIFFERENT ${r.newPath}${r.diff ? `\n${r.diff}\n` : ''}`);
    console.log(`${results.length - bad.length} identical, ${bad.length} different of ${results.length} converted files`);
    process.exit(bad.length ? 1 : 0);
}
