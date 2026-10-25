#!/usr/bin/env node
/**
 * SCC ratchet — the largest import cycle may only shrink.
 *
 * A strongly connected component of the import graph is a set of files that
 * all reach each other: load any one of them and the rest come along, and the
 * evaluation order inside the set depends on who was required first. The
 * audit of 2026-10 measured the largest one at 603 files in server/ (auth,
 * stores, core, projects and support, tied together by lazy requires through
 * the auth barrel), 68 in agent-hub/src (the Studio registry) and 5 in
 * mobile/src. Splitting those up takes several changes; this gate is what
 * stops a new import from closing the next loop in the meantime.
 *
 * Same contract as scripts/count-ratchet.mjs: each package commits the size it
 * may still carry (<package>/.scc-ratchet.json), CI fails when a change makes
 * the largest cycle bigger, and `--update` lowers the budget after a split. It
 * never raises it.
 *
 * What is measured: the number of files in the largest strongly connected
 * component of the package's INTERNAL import graph (0 when there is no cycle).
 * An edge is any import whose specifier resolves to a scanned file: relative
 * paths and the tsconfig `paths` aliases (`@/…`, `@shared/…`). Counted:
 *   - static `import … from`, `export … from` and side-effect `import '…'`;
 *   - `require('…')` and `import('…')` ANYWHERE in the file, function bodies
 *     included. The lazy require is exactly how the server's big cycle hides,
 *     so it is not a way around the budget.
 * Not counted:
 *   - type-only imports where the syntax says so (`import type`, `export type`,
 *     `import { type A, type B }`, `typeof import(…)`): TypeScript erases them,
 *     so they load nothing;
 *   - anything inside a comment (a JSDoc line that says "import it from
 *     '@/x'" is not an edge; the audit's script counted those);
 *   - test files (`*.test.*`, `*.spec.*`, `*.testkit.*`, `__tests__/`,
 *     `__mocks__/`) and declaration files: nothing in the app imports them;
 *   - specifiers built at run time (`require(name)`, a template with `${}`).
 *
 * Usage:
 *   node scripts/scc-ratchet.mjs <package>...           gate
 *   node scripts/scc-ratchet.mjs <package> --update     lower the budget
 *   node scripts/scc-ratchet.mjs <package> --list       the files of every cycle, largest first
 *   node scripts/scc-ratchet.mjs <package> --update --with-cycles   also gate the NUMBER of cycles
 *
 * Every package scans <package>/src when it has one, and the package directory
 * itself when it does not (server/).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CODE = /\.(?:[cm]?js|jsx|ts|tsx)$/;
const NOT_SOURCE = /\.(?:test|spec|testkit)\.[cm]?[jt]sx?$|\.d\.[cm]?ts$/;
// Build output, vendored code and test scaffolding: not part of the app's graph.
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', '__tests__', '__mocks__']);
// Resolution order for an extensionless specifier, as the bundlers try them.
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/* ------------------------------------------------------------------ */
/* Comments out, everything else kept                                  */
/* ------------------------------------------------------------------ */

const WS = new Set([' ', '\t', '\n', '\r', '\f', '\v', ' ', '﻿']);
// After one of these a `/` starts a regular expression, not a division.
const BEFORE_REGEX = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
const IDENT = /[\w$]/;
const SPECIAL = /['"`/{}]/g;

function regexAllowed(src, idx) {
    if (idx < 0) return true;
    const c = src[idx];
    if (BEFORE_REGEX.has(c)) return true;
    if (!IDENT.test(c)) return false;
    let k = idx;
    while (k > 0 && IDENT.test(src[k - 1])) k--;
    return KEYWORDS_BEFORE_REGEX.has(src.slice(k, idx + 1));
}

/**
 * The source with every comment replaced by a space (its newlines kept).
 * Strings, template literals and regular expressions are skipped over so a
 * `//` or `/*` inside one is not taken for a comment. A quote that does not
 * close on its own line (an apostrophe in JSX text) ends at the newline, so a
 * misread can never swallow more than the rest of one line.
 */
export function stripComments(src) {
    const out = [];
    const n = src.length;
    let start = 0; // first char not yet copied to out
    let i = 0;
    let lastSig = -1; // index of the last significant (non-blank, non-comment) char
    let depth = 0; // brace depth, to find the `}` that closes a template `${`
    const templateDepths = [];

    const blank = (from, to) => {
        out.push(src.slice(start, from), src.slice(from, to).replace(/[^\n]+/g, ' '));
        start = to;
    };
    const scanString = (j, q) => {
        let k = j + 1;
        while (k < n) {
            const ch = src[k];
            if (ch === '\\') k += 2;
            else if (ch === q) return k + 1;
            else if (ch === '\n') return k;
            else k++;
        }
        return n;
    };
    const scanTemplate = (k) => {
        while (k < n) {
            const ch = src[k];
            if (ch === '\\') k += 2;
            else if (ch === '`') return k + 1;
            else if (ch === '$' && src[k + 1] === '{') {
                templateDepths.push(depth);
                return k + 2;
            } else k++;
        }
        return n;
    };
    const scanRegex = (j) => {
        let k = j + 1;
        let inClass = false;
        while (k < n) {
            const ch = src[k];
            if (ch === '\\') k += 2;
            else if (ch === '\n') return j + 1; // not a regex after all: read on as code
            else if (ch === '[') { inClass = true; k++; }
            else if (ch === ']') { inClass = false; k++; }
            else if (ch === '/' && !inClass) {
                k++;
                while (k < n && /[a-z]/i.test(src[k])) k++;
                return k;
            } else k++;
        }
        return n;
    };

    for (;;) {
        SPECIAL.lastIndex = i;
        const m = SPECIAL.exec(src);
        if (!m) break;
        const j = m.index;
        for (let k = j - 1; k >= i; k--) {
            if (!WS.has(src[k])) { lastSig = k; break; }
        }
        const c = src[j];
        if (c === '{') {
            depth++;
            i = j + 1;
        } else if (c === '}') {
            if (templateDepths.length && templateDepths[templateDepths.length - 1] === depth) {
                templateDepths.pop();
                i = scanTemplate(j + 1);
            } else {
                depth--;
                i = j + 1;
            }
        } else if (c === '"' || c === "'") {
            i = scanString(j, c);
        } else if (c === '`') {
            i = scanTemplate(j + 1);
        } else if (src[j + 1] === '/') {
            const e = src.indexOf('\n', j);
            i = e < 0 ? n : e;
            blank(j, i);
            continue;
        } else if (src[j + 1] === '*') {
            const e = src.indexOf('*/', j + 2);
            i = e < 0 ? n : e + 2;
            blank(j, i);
            continue;
        } else {
            i = regexAllowed(src, lastSig) ? scanRegex(j) : j + 1;
        }
        lastSig = i - 1;
    }
    out.push(src.slice(start));
    return out.join('');
}

/* ------------------------------------------------------------------ */
/* Import specifiers                                                   */
/* ------------------------------------------------------------------ */

// `import X from '…'`, `import { a, type B } from '…'`, `export * from '…'`, …
// The clause stops at a quote, a semicolon or a parenthesis, so it cannot run
// on into the next statement's string. The lookbehind refuses a member call
// (`x.require(…)`) but not a spread (`...require('./part')`).
const FROM = /(?<![\w$])(?<![^.]\.)(import|export)\s+([^'"`;()]*?)\s*from\s*(['"])([^'"\n]+)\3/g;
const SIDE_EFFECT = /(?<![\w$])(?<![^.]\.)import\s*(['"])([^'"\n]+)\1/g;
const CALL = /(?<![\w$])(?<![^.]\.)(require|import)\s*\(\s*(['"`])([^'"`\n]+)\2\s*\)/g;

/** Does an import/export clause load only types? */
export function typeOnlyClause(clause) {
    const c = clause.trim();
    if (/^type\s+\S/.test(c)) return true; // import type X / export type { … } / export type * from
    const braces = /^\{([^}]*)\}$/.exec(c);
    if (!braces) return false;
    const specs = braces[1].split(',').map((s) => s.trim()).filter(Boolean);
    return specs.length > 0 && specs.every((s) => /^type\s+\S/.test(s));
}

/** The module specifiers a file loads at run time, comments and type-only imports left out. */
export function importsOf(source) {
    const code = stripComments(source);
    const specs = [];
    for (const m of code.matchAll(FROM)) {
        if (!typeOnlyClause(m[2])) specs.push(m[4]);
    }
    for (const m of code.matchAll(SIDE_EFFECT)) specs.push(m[2]);
    for (const m of code.matchAll(CALL)) {
        if (m[2] === '`' && m[3].includes('${')) continue;
        if (m[1] === 'import' && /\btypeof\s*$/.test(code.slice(Math.max(0, m.index - 12), m.index))) continue;
        specs.push(m[3]);
    }
    return specs;
}

/* ------------------------------------------------------------------ */
/* Graph                                                               */
/* ------------------------------------------------------------------ */

function collect(from, into) {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(from, entry.name);
        if (entry.isDirectory()) {
            if (!SKIP_DIRS.has(entry.name)) collect(full, into);
        } else if (entry.isFile() && CODE.test(entry.name) && !NOT_SOURCE.test(entry.name)) {
            into.push(full);
        }
    }
    return into;
}

/**
 * The `paths` aliases of <dir>/tsconfig.json as [prefix, absolute target dir]
 * pairs (`"@/*": ["./src/*"]` -> ['@/', '<dir>/src/']). tsconfig is JSONC, so
 * comments and trailing commas are dropped before parsing; only the `x/*` ->
 * `y/*` form is supported, which is the only one the packages use.
 */
export function readAliases(dir) {
    const file = path.join(dir, 'tsconfig.json');
    if (!fs.existsSync(file)) return [];
    const text = stripComments(fs.readFileSync(file, 'utf8')).replace(/,(\s*[}\]])/g, '$1');
    const paths = JSON.parse(text).compilerOptions?.paths ?? {};
    const aliases = [];
    for (const [key, targets] of Object.entries(paths)) {
        if (!key.endsWith('/*') || !targets?.[0]?.endsWith('/*')) continue;
        aliases.push([key.slice(0, -1), path.resolve(dir, targets[0].slice(0, -1)) + path.sep]);
    }
    // Longest prefix first, so '@shared/' wins over a shorter overlapping one.
    return aliases.sort((a, b) => b[0].length - a[0].length);
}

function resolver(files, aliases) {
    return (from, rawSpec) => {
        const spec = rawSpec.replace(/[?#].*$/, '');
        let base;
        if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
        else {
            const alias = aliases.find(([prefix]) => spec.startsWith(prefix));
            if (!alias) return null;
            base = path.join(alias[1], spec.slice(alias[0].length));
        }
        const candidates = [base, ...EXTS.map((e) => base + e), ...EXTS.map((e) => path.join(base, `index${e}`))];
        // `./x.js` written for a TypeScript source (NodeNext style).
        if (/\.[cm]?jsx?$/.test(base)) {
            const stem = base.replace(/\.[cm]?jsx?$/, '');
            candidates.push(stem + '.ts', stem + '.tsx');
        }
        return candidates.find((c) => files.has(c)) ?? null;
    };
}

/** Strongly connected components (Tarjan, iterative: the server graph is deep). */
export function stronglyConnected(graph) {
    let next = 0;
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const sccs = [];
    for (const root of graph.keys()) {
        if (index.has(root)) continue;
        const work = [[root, [...(graph.get(root) ?? [])], 0]];
        index.set(root, next); low.set(root, next); next++;
        stack.push(root); onStack.add(root);
        while (work.length) {
            const frame = work[work.length - 1];
            const [v, out] = frame;
            if (frame[2] < out.length) {
                const w = out[frame[2]++];
                if (!index.has(w)) {
                    index.set(w, next); low.set(w, next); next++;
                    stack.push(w); onStack.add(w);
                    work.push([w, [...(graph.get(w) ?? [])], 0]);
                } else if (onStack.has(w)) {
                    low.set(v, Math.min(low.get(v), index.get(w)));
                }
                continue;
            }
            work.pop();
            if (work.length) {
                const parent = work[work.length - 1][0];
                low.set(parent, Math.min(low.get(parent), low.get(v)));
            }
            if (low.get(v) === index.get(v)) {
                const scc = [];
                let w;
                do {
                    w = stack.pop();
                    onStack.delete(w);
                    scc.push(w);
                } while (w !== v);
                sccs.push(scc);
            }
        }
    }
    return sccs;
}

/**
 * The import cycles of a package directory, largest first, as lists of
 * paths relative to that directory. A cycle is an SCC of two or more files.
 */
export function measure(dir) {
    const srcDir = fs.existsSync(path.join(dir, 'src')) ? path.join(dir, 'src') : dir;
    const list = collect(srcDir, []);
    const files = new Set(list);
    const resolve = resolver(files, readAliases(dir));
    const graph = new Map();
    for (const file of list) {
        const out = new Set();
        for (const spec of importsOf(fs.readFileSync(file, 'utf8'))) {
            const target = resolve(file, spec);
            if (target && target !== file) out.add(target);
        }
        graph.set(file, out);
    }
    const rel = (f) => path.relative(dir, f).split(path.sep).join('/');
    const cycles = stronglyConnected(graph)
        .filter((c) => c.length > 1)
        .map((c) => c.map(rel).sort())
        .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
    return { srcDir, files: list.length, cycles };
}

/* ------------------------------------------------------------------ */
/* Gate                                                                */
/* ------------------------------------------------------------------ */

function gate(pkg, opts) {
    const { update, list } = opts;
    const dir = path.resolve(ROOT, pkg);
    if (!fs.existsSync(dir)) {
        console.error(`scc-ratchet: ${pkg} not found — is "${pkg}" a package directory?`);
        return 2;
    }
    const { srcDir, files, cycles } = measure(dir);
    const size = cycles[0]?.length ?? 0;
    const scanned = path.relative(ROOT, srcDir).split(path.sep).join('/');
    const budgetFile = path.join(dir, '.scc-ratchet.json');

    if (list) {
        console.log(`${scanned}: ${files} files, ${cycles.length} import cycles, sizes ${cycles.map((c) => c.length).join(', ') || '-'}`);
        if (size) {
            console.log(`Largest cycle (${size} files):`);
            for (const file of cycles[0]) console.log(`  ${file}`);
            for (const c of cycles.slice(1)) console.log(`Cycle (${c.length} files): ${c.join(' <-> ')}`);
        }
        console.log('');
    }

    const existing = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : null;
    if (update || !existing) {
        const next = {
            _comment: `Number of files the largest import cycle (strongly connected component, lazy requires included, type-only imports excluded) under ${scanned} may still have. Lower it with \`node scripts/scc-ratchet.mjs ${pkg} --update\` after a split; raising it is a deliberate edit that belongs in a commit message with a reason.`,
            _generated: new Date().toISOString().slice(0, 10),
            size: existing ? Math.min(size, existing.size) : size,
            // The number of separate cycles (SCCs of 2+ files) may only fall too. A budget file
            // without it is not gated on the count until `--update --with-cycles` writes it.
            ...(!existing || existing.cycles !== undefined || opts.withCycles
                ? { cycles: existing && existing.cycles !== undefined ? Math.min(cycles.length, existing.cycles) : cycles.length }
                : {}),
        };
        fs.writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Budget written to ${path.relative(ROOT, budgetFile)}: ${next.size} (measured ${size}, ${cycles.length} cycles)`);
        return 0;
    }

    if (size > existing.size) {
        console.error(`❌ ${pkg}: the largest import cycle under ${scanned} has ${size} files, budget is ${existing.size}. An import closed a loop: move the shared piece down into a module both sides can import (or inject it) rather than raising the budget (\`--list\` shows the files in the cycle).`);
        return 1;
    }
    if (existing.cycles !== undefined && cycles.length > existing.cycles) {
        console.error(`❌ ${pkg}: ${cycles.length} import cycles under ${scanned}, budget is ${existing.cycles}. An import closed a new loop: move the shared piece down into a module both sides can import (or inject it) rather than raising the budget (\`--list\` shows the cycles).`);
        return 1;
    }
    if (size < existing.size) {
        console.log(`✅ ${pkg}: largest import cycle ${size} files, under the budget of ${existing.size}. Run \`node scripts/scc-ratchet.mjs ${pkg} --update\` to lower it.`);
    } else {
        console.log(`➖ ${pkg}: largest import cycle ${size} files, at budget`);
    }
    return 0;
}

function main(argv) {
    const pkgs = argv.filter((a) => !a.startsWith('--'));
    if (!pkgs.length) {
        console.error('scc-ratchet: usage: node scripts/scc-ratchet.mjs <package>... [--update] [--list] [--with-cycles]');
        return 2;
    }
    const opts = { update: argv.includes('--update'), list: argv.includes('--list'), withCycles: argv.includes('--with-cycles') };
    let code = 0;
    for (const pkg of pkgs) code = Math.max(code, gate(pkg, opts));
    return code;
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
