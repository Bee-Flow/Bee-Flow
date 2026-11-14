#!/usr/bin/env node
/**
 * any-share ratchet — how much of the server's checked code the type checker
 * sees as `any`, in two numbers that may only go down:
 *
 *   expressions         the share of expressions whose type is `any`
 *   exported functions  the share of exported functions with an `any`
 *                       parameter or an `any` (or `Promise<any>`) return
 *
 * A file can pass `npm run typecheck` and still be mostly unchecked: an
 * unannotated parameter is `any` below noImplicitAny, a `JSON.parse` result or
 * a `require` of an unchecked module is `any` at every level, and everything
 * computed from it is `any` again. The error count does not show that; this
 * does.
 *
 * What is measured: the files `server/scripts/typecheck.mjs` checks (a
 * `// @typecheck` marker, or `.mts`), without tests and test helpers, each
 * under the options of ITS level (one program per level), so the count is
 * what that file's own check sees. TypeScript 7 has no JavaScript
 * API, so the programs are built with the TypeScript 6 API the root package
 * carries as `typescript-api`; the gate that decides errors stays tsc 7.
 *
 * An expression is every node in expression position except literal tokens
 * (strings, numbers, `true`, `null`, regexes, templates without substitutions),
 * parentheses, and function, class, object and array literals: those are never
 * `any`, and counting them would only water the share down. `a.b` is one
 * expression next to `a`, not two. A type that failed
 * to resolve counts as `any`, which is what the checker uses for it.
 *
 * Budget: <package>/.any-share-ratchet.json
 *   { tolerance, expressions: { any, total, pct }, exportedFunctions: { any, total, pct } }
 * A share above its recorded `pct` plus `tolerance` (percentage points; room
 * for two branches that merge) fails.
 *
 * Usage:
 *   node scripts/any-share.mjs <package>            gate, with the totals per top-level folder
 *   node scripts/any-share.mjs <package> --update   lower the budget (never raises it)
 *   node scripts/any-share.mjs <package> --list     the 40 files with the most `any` expressions
 *   node scripts/any-share.mjs <package> --list-exports   every exported function with `any`
 *   node scripts/any-share.mjs <package> --json     the whole measurement as JSON
 *
 * It type-checks the whole package once per level (about a minute and a half
 * on server, several gigabytes of heap) and needs
 * <package>/node_modules for the typings, so check:fast leaves it out and
 * ci.yml's server-checks job runs it.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @typedef {{ file: string, level: string, expressions: { any: number, total: number }, exports: { name: string, any: string[] }[] }} FileCount */

/** Percentage points a share may sit above its budget before the gate fails. */
export const DEFAULT_TOLERANCE = 0.1;

/** Tests and test helpers: their fixtures are loose on purpose. */
export const TEST_FILE = /\.test\.[cm]?[jt]s$|\.testkit\.|\.testutil\.|(^|\/)testUtils\/|(^|\/)test\//;

/** `n` of `total` in percent, two decimals; 0 when there is nothing to count. */
export function pct(n, total) {
    return total === 0 ? 0 : Math.round((n / total) * 10000) / 100;
}

/** The TypeScript API (TypeScript 6, the root's `typescript-api`). */
export function loadTs() {
    const name = 'typescript-api';
    return createRequire(path.join(ROOT, 'package.json'))(name);
}

/**
 * Is this node counted as an expression? `ts.isExpressionNode` decides the
 * position (an identifier that names a declaration or a property is not one);
 * the kinds that can never be `any` are left out.
 * @param {any} ts
 * @param {any} node
 */
export function isCountedExpression(ts, node) {
    const K = ts.SyntaxKind;
    switch (node.kind) {
        case K.StringLiteral:
        case K.NumericLiteral:
        case K.BigIntLiteral:
        case K.NoSubstitutionTemplateLiteral:
        case K.RegularExpressionLiteral:
        case K.TrueKeyword:
        case K.FalseKeyword:
        case K.NullKeyword:
        case K.ParenthesizedExpression:
        case K.FunctionExpression:
        case K.ArrowFunction:
        case K.ClassExpression:
        case K.ObjectLiteralExpression:
        case K.ArrayLiteralExpression:
        case K.OmittedExpression:
        case K.JsxElement:
        case K.JsxSelfClosingElement:
        case K.JsxFragment:
            return false;
        case K.Identifier:
            // `a.b` is one expression: the access. Its name alone is not a second one.
            if (node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) return false;
            return ts.isExpressionNode(node);
        default:
            return ts.isExpressionNode(node);
    }
}

/** @param {any} ts @param {any} type */
const isAny = (ts, type) => (type.flags & ts.TypeFlags.Any) !== 0;

/**
 * The expressions of one source file: how many, and how many are `any`.
 * @param {any} ts
 * @param {any} checker
 * @param {any} sourceFile
 * @returns {{ any: number, total: number }}
 */
export function countExpressions(ts, checker, sourceFile) {
    let total = 0;
    let anyCount = 0;
    const visit = (/** @type {any} */ node) => {
        // Types, JSDoc and import/export clauses hold no expressions.
        if (ts.isTypeNode(node) || node.kind === ts.SyntaxKind.JSDoc) return;
        if (isCountedExpression(ts, node)) {
            total++;
            if (isAny(ts, checker.getTypeAtLocation(node))) anyCount++;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { any: anyCount, total };
}

/**
 * Does a signature take or give `any`? A parameter of type `any` (or a rest
 * parameter `any[]`), or a return of `any` / `Promise<any>`.
 * @param {any} ts
 * @param {any} checker
 * @param {any} signature
 * @returns {string[]} what is `any`: parameter names and/or 'return'
 */
export function anyOfSignature(ts, checker, signature) {
    const out = [];
    for (const p of signature.getParameters()) {
        const decl = p.valueDeclaration;
        const type = checker.getTypeOfSymbol(p);
        const rest = decl && ts.isParameter(decl) && decl.dotDotDotToken;
        const element = rest && checker.isArrayType(type) ? checker.getTypeArguments(type)[0] : null;
        if (isAny(ts, type) || (element && isAny(ts, element))) out.push(p.getName());
    }
    const ret = checker.getReturnTypeOfSignature(signature);
    const awaited = ret.symbol?.getName() === 'Promise' ? checker.getTypeArguments(ret)[0] : null;
    if (isAny(ts, ret) || (awaited && isAny(ts, awaited))) out.push('return');
    return out;
}

/**
 * The exported functions of one module (ES exports, `module.exports = {…}`,
 * `exports.x = …`), each with what is `any` in its signatures.
 * @param {any} ts
 * @param {any} checker
 * @param {any} sourceFile
 * @returns {{ name: string, any: string[] }[]}
 */
export function exportedFunctions(ts, checker, sourceFile) {
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) return [];
    const out = [];
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
        const type = checker.getTypeOfSymbolAtLocation(symbol, sourceFile);
        const signatures = type.getCallSignatures();
        if (signatures.length === 0) continue;
        const bad = new Set();
        for (const s of signatures) for (const a of anyOfSignature(ts, checker, s)) bad.add(a);
        out.push({ name: symbol.getName(), any: [...bad] });
    }
    return out;
}

/** The top-level folder a package-relative file belongs to. */
export function folderOf(file) {
    const at = file.indexOf('/');
    return at < 0 ? '(root)' : file.slice(0, at);
}

/**
 * Totals per top-level folder and overall.
 * @param {{ file: string, expressions: { any: number, total: number }, exports: { name: string, any: string[] }[] }[]} files
 */
export function summarise(files) {
    /** @type {Map<string, { files: number, expressions: { any: number, total: number }, exportedFunctions: { any: number, total: number } }>} */
    const folders = new Map();
    const blank = () => ({ files: 0, expressions: { any: 0, total: 0 }, exportedFunctions: { any: 0, total: 0 } });
    const total = blank();
    for (const f of files) {
        const key = folderOf(f.file);
        const row = folders.get(key) ?? blank();
        folders.set(key, row);
        for (const t of [row, total]) {
            t.files++;
            t.expressions.any += f.expressions.any;
            t.expressions.total += f.expressions.total;
            t.exportedFunctions.total += f.exports.length;
            t.exportedFunctions.any += f.exports.filter((e) => e.any.length > 0).length;
        }
    }
    return { total, folders: [...folders].map(([folder, row]) => ({ folder, ...row })).sort((a, b) => b.expressions.any - a.expressions.any) };
}

/**
 * The verdict for a measurement against the budget file's content.
 * @param {{ expressions: { any: number, total: number }, exportedFunctions: { any: number, total: number } }} total
 * @param {{ tolerance?: number, expressions: { pct: number }, exportedFunctions: { pct: number } } | null} budget
 * @param {boolean} update
 */
export function verdict(total, budget, update) {
    const measured = {
        expressions: { ...total.expressions, pct: pct(total.expressions.any, total.expressions.total) },
        exportedFunctions: { ...total.exportedFunctions, pct: pct(total.exportedFunctions.any, total.exportedFunctions.total) },
    };
    const keys = /** @type {const} */ (['expressions', 'exportedFunctions']);
    if (update || !budget) {
        // Per number: the lower of what is recorded and what is measured.
        const next = { ...measured };
        if (budget) for (const k of keys) if (budget[k].pct < measured[k].pct) next[k] = /** @type {any} */ (budget[k]);
        return { status: /** @type {const} */ ('write'), measured, next };
    }
    const tolerance = budget.tolerance ?? DEFAULT_TOLERANCE;
    const over = keys.filter((k) => measured[k].pct > budget[k].pct + tolerance);
    if (over.length > 0) return { status: /** @type {const} */ ('fail'), measured, over };
    const under = keys.some((k) => measured[k].pct < budget[k].pct);
    return { status: under ? /** @type {const} */ ('under') : /** @type {const} */ ('at'), measured };
}

/**
 * Count the files of ONE typecheck level, in this process.
 * @param {string} pkgDir
 * @param {string} level
 * @param {{ ts?: any, files?: { file: string, level: string }[] }} [opts]
 */
export async function measureLevel(pkgDir, level, opts = {}) {
    const ts = opts.ts ?? loadTs();
    const typecheck = await import(pathToFileURL(path.join(pkgDir, 'scripts', 'typecheck.mjs')).href);
    const marked = opts.files ?? typecheck.markedFiles(pkgDir);
    const files = marked.filter((/** @type {{ file: string, level: string }} */ f) => f.level === level && !TEST_FILE.test(f.file)).map((/** @type {{ file: string }} */ f) => f.file);
    if (files.length === 0) return [];
    const typesDir = path.join(pkgDir, 'types');
    const ambient = fs.existsSync(typesDir) ? fs.readdirSync(typesDir).filter((f) => f.endsWith('.d.ts')).map((f) => path.join(typesDir, f)) : [];
    const configPath = path.join(pkgDir, 'jsconfig.json');
    const base = ts.readConfigFile(configPath, ts.sys.readFile);
    if (base.error) throw new Error(ts.flattenDiagnosticMessageText(base.error.messageText, '\n'));
    const json = { compilerOptions: { ...base.config.compilerOptions, checkJs: true, noEmit: true, ...typecheck.LEVEL_OPTIONS[level] }, files: [] };
    const parsed = ts.parseJsonConfigFileContent(json, ts.sys, pkgDir, undefined, configPath);
    const program = ts.createProgram({ rootNames: [...files.map((/** @type {string} */ f) => path.join(pkgDir, f)), ...ambient], options: parsed.options });
    const checker = program.getTypeChecker();
    return files.map((/** @type {string} */ file) => {
        const sourceFile = program.getSourceFile(path.join(pkgDir, file));
        if (!sourceFile) throw new Error(`any-share: ${file} is not in the program`);
        return { file, level, expressions: countExpressions(ts, checker, sourceFile), exports: exportedFunctions(ts, checker, sourceFile) };
    });
}

/** Heap for one level's program, in MB: the whole server under checkJs does not fit node's default. */
const WORKER_HEAP_MB = 8192;

/** Levels measured at the same time: each is a multi-gigabyte heap, two fit a CI runner. */
const WORKERS_AT_ONCE = 2;

/**
 * One level in a child process; resolves with its files.
 * @param {string} pkgDir
 * @param {string} level
 * @returns {Promise<FileCount[]>}
 */
function runLevel(pkgDir, level) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [`--max-old-space-size=${WORKER_HEAP_MB}`, fileURLToPath(import.meta.url), path.relative(ROOT, pkgDir), '--worker', level], { stdio: ['ignore', 'pipe', 'inherit'] });
        /** @type {Buffer[]} */
        const chunks = [];
        child.stdout.on('data', (c) => chunks.push(c));
        child.on('error', reject);
        child.on('close', (code, signal) => {
            if (code !== 0) reject(new Error(`any-share: the ${level} level stopped with ${code ?? signal}`));
            else resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        });
    });
}

/**
 * Measure a package: each file counted under the options of its own level.
 * One child process per level: a level's program pulls in most of the
 * package, and four of them do not fit one heap.
 * @param {string} pkgDir
 * @returns {Promise<FileCount[]>}
 */
export async function measure(pkgDir) {
    const typecheck = await import(pathToFileURL(path.join(pkgDir, 'scripts', 'typecheck.mjs')).href);
    const queue = [...typecheck.LEVELS];
    /** @type {FileCount[]} */
    const out = [];
    const worker = async () => {
        for (let level = queue.shift(); level; level = queue.shift()) out.push(...(await runLevel(pkgDir, level)));
    };
    await Promise.all(Array.from({ length: WORKERS_AT_ONCE }, worker));
    return out.sort((x, y) => x.file.localeCompare(y.file));
}

const row = (/** @type {string} */ label, /** @type {{ files: number, expressions: { any: number, total: number }, exportedFunctions: { any: number, total: number } }} */ r) =>
    `${label.padEnd(22)} ${String(r.files).padStart(5)}  ${String(r.expressions.any).padStart(7)} / ${String(r.expressions.total).padStart(7)}  ${pct(r.expressions.any, r.expressions.total).toFixed(1).padStart(5)}%   ${String(r.exportedFunctions.any).padStart(5)} / ${String(r.exportedFunctions.total).padStart(5)}  ${pct(r.exportedFunctions.any, r.exportedFunctions.total).toFixed(1).padStart(5)}%`;

/** @param {string[]} args */
async function main(args) {
    const pkg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--worker');
    if (!pkg) {
        console.error('usage: node scripts/any-share.mjs <package> [--update | --list | --list-exports | --json]');
        process.exit(2);
    }
    const pkgDir = path.join(ROOT, pkg);
    const workerAt = args.indexOf('--worker');
    if (workerAt >= 0) {
        process.stdout.write(JSON.stringify(await measureLevel(pkgDir, args[workerAt + 1])));
        return;
    }
    const budgetFile = path.join(pkgDir, '.any-share-ratchet.json');
    const budget = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, 'utf8')) : null;
    const update = args.includes('--update');
    const files = await measure(pkgDir);
    const { total, folders } = summarise(files);

    if (args.includes('--json')) {
        console.log(JSON.stringify({ total, folders, files }, null, 1));
        return;
    }
    if (args.includes('--list')) {
        for (const f of [...files].sort((a, b) => b.expressions.any - a.expressions.any).slice(0, 40)) {
            console.log(`${String(f.expressions.any).padStart(6)} of ${String(f.expressions.total).padStart(6)}  ${pct(f.expressions.any, f.expressions.total).toFixed(0).padStart(3)}%  ${f.file}  [${f.level}]`);
        }
        console.log('');
    }
    if (args.includes('--list-exports')) {
        for (const f of files) for (const e of f.exports) if (e.any.length > 0) console.log(`${f.file}  ${e.name}(${e.any.join(', ')})`);
        console.log('');
    }
    console.log(`${'folder'.padEnd(22)} files  any expressions      share   exported fns with any`);
    for (const f of folders) console.log(row(f.folder, f));
    console.log(row('total', total));
    console.log('');
    if ((args.includes('--list') || args.includes('--list-exports')) && !update) return;

    const v = verdict(total, budget, update);
    const say = (/** @type {{ expressions: { pct: number }, exportedFunctions: { pct: number } }} */ m) => `${m.expressions.pct}% of expressions are any, ${m.exportedFunctions.pct}% of exported functions carry any`;
    if (v.status === 'write') {
        const next = {
            _comment: `Highest share of \`any\` ${pkg}'s checked code may still carry: expressions whose type is any, and exported functions with an any parameter or return (scripts/any-share.mjs explains what is counted). Lower it with \`node scripts/any-share.mjs ${pkg} --update\` after typing work; raising it is a deliberate edit that belongs in a commit message with a reason.`,
            _generated: new Date().toISOString().slice(0, 10),
            tolerance: budget?.tolerance ?? DEFAULT_TOLERANCE,
            ...v.next,
        };
        fs.writeFileSync(budgetFile, `${JSON.stringify(next, null, 2)}\n`);
        console.log(`Budget written to ${path.relative(ROOT, budgetFile)}: ${say(v.next)} (measured: ${say(v.measured)})`);
    } else if (v.status === 'fail') {
        console.error(`❌ ${pkg}: ${say(v.measured)}; the budget is ${budget.expressions.pct}% and ${budget.exportedFunctions.pct}% — type the new code (a parameter type, a typed parse of the JSON, a typed import) rather than raising the budget (\`--list\` and \`--list-exports\` show where it is)`);
        process.exit(1);
    } else if (v.status === 'under') {
        console.log(`✅ ${pkg}: ${say(v.measured)}, under the budget of ${budget.expressions.pct}% and ${budget.exportedFunctions.pct}%. Run \`node scripts/any-share.mjs ${pkg} --update\` to lower it.`);
    } else {
        console.log(`➖ ${pkg}: ${say(v.measured)}, at budget`);
    }
}

if (isEntryPoint(import.meta.url)) await main(process.argv.slice(2));
