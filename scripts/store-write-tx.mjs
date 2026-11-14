#!/usr/bin/env node
/**
 * Store functions that write two or more tables without a transaction.
 *
 * A store function that INSERTs into one table and UPDATEs another as two
 * separate statements on the pool leaves the first write behind when the
 * second fails: a row without its version, a grant without its audit line, a
 * debit without its ledger entry. This module finds those functions in
 * server/stores/; the `store-write-tx` metric in scripts/count-ratchet.mjs
 * counts them.
 *
 * Read off the syntax tree (TypeScript parser, no program), so SQL in a comment
 * is never counted. Per function:
 *   writes     the string and template literals in it (nested functions
 *              included) that hold `INSERT INTO t`, `UPDATE t SET` or
 *              `DELETE FROM t`. A `${…}` table name counts by its expression
 *              text. `ON CONFLICT … DO UPDATE SET` is part of its INSERT.
 *   counted    two or more such literals naming two or more distinct tables
 *              (one statement that writes two tables through a CTE is atomic
 *              on its own), none of them covered, and no nested function that
 *              is counted itself (the innermost function is the one reported).
 *   covered    a write is covered when it sits inside the arguments of a
 *              transaction call (withTransaction, runTransaction, withAppTx,
 *              inTransaction, transaction, with…Tx / with…Transaction / run…
 *              Transaction), inside a function that opens one by hand
 *              (a 'BEGIN' literal), or inside a function that takes the caller's
 *              client: a parameter (or a destructured option) named client, tx,
 *              trx, txClient, outerClient, executor, conn, dbClient, queryable or
 *              q, or `db` / `pool` with a default (`{ db = pool } = {}`), a
 *              positional `run`, `h` or `handle` (the caller's executor; a
 *              destructured `{ run }` is a factory's injected db and does not
 *              count), or a parameter whose `.client` / `.tx` it reads. A caller that hands
 *              its transaction client in joins its transaction; one that does
 *              not decides for itself.
 *   stepwise   a function with a `// stepwise: <why>` line comment (above its
 *              declaration, its property, or the statement that passes it as an
 *              argument: `const initDB = makeStoreInit(…, async () => …)`; or
 *              after the `{` that opens its body) is skipped: erasure that is idempotent by design and re-runs to
 *              completion, or writes whose independence is the point.
 *
 * What it does not see: a write through another store function (it counts the
 * literal SQL of the function itself), and SQL put together from pieces in
 * which no single piece names the statement and its table.
 *
 * Usage:
 *   node scripts/store-write-tx.mjs           list every counted function (file:line name tables)
 *   node scripts/store-write-tx.mjs --json    the same as JSON
 *
 * TypeScript's JS API from the root's `typescript-api` alias, else agent-hub's copy.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let tsCache;
function loadTs() {
    if (tsCache) return tsCache;
    try {
        tsCache = createRequire(path.join(ROOT, 'package.json'))('typescript-api');
    } catch {
        tsCache = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript');
    }
    return tsCache;
}

const NAME = String.raw`("[^"]+"|\$\{[^}]*\}|[A-Za-z_][\w.$]*)`;
const WRITE_PATTERNS = [
    new RegExp(String.raw`\bINSERT\s+INTO\s+${NAME}`, 'g'),
    new RegExp(String.raw`(?<!\bDO\s+)\bUPDATE\s+(?:ONLY\s+)?${NAME}(?:\s+(?:AS\s+)?[A-Za-z_]\w*)?\s+SET\b`, 'g'),
    new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?${NAME}`, 'g'),
];
// Cheap pre-filter: a file without one of these has nothing to report.
const WRITE_TEXT = /\b(?:INSERT\s+INTO|UPDATE\s|DELETE\s+FROM)\b/;
const TX_CALL = /^(?:with\w*(?:Tx|Transaction)\w*|run\w*Transaction|inTransaction|transaction)$/;
const CLIENT_PARAM = new Set(['client', 'tx', 'trx', 'txClient', 'outerClient', 'executor', 'conn', 'dbClient', 'queryable', 'q']);
const DEFAULTED_CLIENT_PARAM = new Set(['db', 'pool']);
const POSITIONAL_EXECUTOR = new Set(['run', 'h', 'handle']);
const CLIENT_PROPERTY = new Set(['client', 'tx']);
const STEPWISE = /^\/\/\s*stepwise:\s*\S/;

/** The tables a SQL text writes, in order of appearance (duplicates kept out). */
export function tablesWritten(sql) {
    const out = [];
    for (const re of WRITE_PATTERNS) {
        re.lastIndex = 0;
        for (const m of sql.matchAll(re)) {
            const t = m[1].replace(/"/g, '').toLowerCase();
            if (t === 'set' || out.includes(t)) continue;
            out.push(t);
        }
    }
    return out;
}

function scriptKind(ts, file) {
    return /\.[cm]?tsx?$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
}

function isFunctionLike(ts, node) {
    return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node);
}

function literalText(ts, node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
        return node.head.text + node.templateSpans.map((s) => `\${${s.expression.getText()}}${s.literal.text}`).join('');
    }
    return null;
}

function calleeName(ts, call) {
    const e = call.expression;
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e)) return e.name.text;
    return '';
}

/** True when a parameter (or one destructured out of it) is the caller's client. */
function bindingTakesClient(ts, name, initializer, positional = false) {
    if (ts.isIdentifier(name)) {
        if (CLIENT_PARAM.has(name.text) || (positional && POSITIONAL_EXECUTOR.has(name.text))) return true;
        return DEFAULTED_CLIENT_PARAM.has(name.text) && !!initializer;
    }
    if (ts.isObjectBindingPattern(name)) {
        return name.elements.some((el) => {
            const key = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : null;
            if (key && (CLIENT_PARAM.has(key) || (DEFAULTED_CLIENT_PARAM.has(key) && el.initializer))) return true;
            return bindingTakesClient(ts, el.name, el.initializer);
        });
    }
    return false;
}

function takesCallerClient(ts, fn) {
    if (fn.parameters.some((p) => bindingTakesClient(ts, p.name, p.initializer, true))) return true;
    const params = new Set(fn.parameters.filter((p) => ts.isIdentifier(p.name)).map((p) => p.name.text));
    if (!params.size || !fn.body) return false;
    let found = false;
    const visit = (n) => {
        if (found) return;
        if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && params.has(n.expression.text)
            && CLIENT_PROPERTY.has(n.name.text)) { found = true; return; }
        ts.forEachChild(n, visit);
    };
    visit(fn.body);
    return found;
}

function opensTransactionByHand(ts, fn) {
    let found = false;
    const visit = (n) => {
        if (found) return;
        const text = literalText(ts, n);
        if (text !== null && /^\s*BEGIN\b/.test(text)) { found = true; return; }
        ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
    return found;
}

/** The node whose leading comments belong to the function (its declaration or property). */
function anchorOf(ts, fn) {
    let node = fn;
    for (;;) {
        const p = node.parent;
        if (!p) return node;
        if (ts.isVariableDeclaration(p) || ts.isVariableDeclarationList(p) || ts.isVariableStatement(p)
            || ts.isPropertyAssignment(p) || ts.isExportAssignment(p) || ts.isParenthesizedExpression(p)
            || ts.isExpressionStatement(p) || ts.isAwaitExpression(p) || ts.isReturnStatement(p)
            || (ts.isBinaryExpression(p) && p.right === node)
            || (ts.isCallExpression(p) && p.arguments.includes(node))) {
            node = p;
            continue;
        }
        return node;
    }
}

function isStepwise(ts, sf, fn) {
    const anchor = anchorOf(ts, fn);
    const text = sf.getFullText();
    const ranges = [...(ts.getLeadingCommentRanges(text, anchor.getFullStart()) || [])];
    // Or on the line that opens the body: `async function erase(id) { // stepwise: …`.
    if (fn.body && ts.isBlock(fn.body)) ranges.push(...(ts.getTrailingCommentRanges(text, fn.body.getStart(sf) + 1) || []));
    return ranges.some((r) => STEPWISE.test(text.slice(r.pos, r.end)));
}

/** A function passed as an argument, or called on the spot. */
function isCallback(ts, fn) {
    let node = fn;
    while (node.parent && ts.isParenthesizedExpression(node.parent)) node = node.parent;
    const p = node.parent;
    return !!p && ts.isCallExpression(p) && (p.arguments.includes(node) || p.expression === node);
}

function functionName(ts, fn) {
    if (fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name))) return fn.name.text;
    const p = fn.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    if (p && ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
    if (p && ts.isBinaryExpression(p) && ts.isPropertyAccessExpression(p.left)) return p.left.name.text;
    return '<anonymous>';
}

/**
 * The functions in one source file that write two or more tables in separate
 * statements without a transaction or a caller's client.
 * @returns {{ name: string, line: number, tables: string[] }[]}
 */
export function nonAtomicWrites(text, file = 'x.js') {
    if (!WRITE_TEXT.test(text)) return []; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a repo script over source files it reads itself; fixed keywords with single whitespace runs between them: linear
    const ts = loadTs();
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
    const found = [];

    // Returns the uncovered write literals of `node` ({ tables }[]), and whether a nested function was counted.
    const walk = (node, covered) => {
        if (isFunctionLike(ts, node)) {
            const own = covered || isStepwise(ts, sf, node) || takesCallerClient(ts, node) || opensTransactionByHand(ts, node);
            const inner = walkChildren(node, own);
            if (!own && !inner.counted) {
                const tables = new Set(inner.writes.flatMap((w) => w.tables));
                if (inner.writes.length >= 2 && tables.size >= 2) {
                    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
                    found.push({ name: functionName(ts, node), line, tables: [...tables] });
                    return { writes: [], counted: true };
                }
            }
            // A callback runs as part of the function it is passed to (a map over rows, an
            // IIFE); a named function (a method of a store factory, a local helper) is a
            // unit of its own, so its writes do not add up with its siblings'.
            return isCallback(ts, node) ? inner : { writes: [], counted: inner.counted };
        }
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a repo script: an anchored alternation of literals, tested on a callee name of a source file it reads itself
        if (ts.isCallExpression(node) && TX_CALL.test(calleeName(ts, node))) {
            const callee = walk(node.expression, covered);
            const args = node.arguments.map((a) => walk(a, true));
            return { writes: callee.writes, counted: callee.counted || args.some((a) => a.counted) };
        }
        const text = literalText(ts, node);
        if (text !== null) {
            const tables = tablesWritten(text);
            const nested = walkChildren(node, covered);
            if (tables.length && !covered) nested.writes.unshift({ tables });
            return nested;
        }
        return walkChildren(node, covered);
    };
    const walkChildren = (node, covered) => {
        const writes = [];
        let counted = false;
        ts.forEachChild(node, (child) => {
            const r = walk(child, covered);
            writes.push(...r.writes);
            counted = counted || r.counted;
        });
        return { writes, counted };
    };
    walk(sf, false);
    return found.sort((a, b) => a.line - b.line);
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);

/**
 * The store sources the metric reads (paths from server/): stores/ minus tests,
 * testkits (seed helpers for tests) and declaration files.
 */
export function isStoreSource(rel) {
    return rel.startsWith('stores/') && /\.[cm]?[jt]s$/.test(rel)
        && !/\.test(?:kit)?\.[cm]?[jt]s$/.test(rel) && !/\.d\.[cm]?ts$/.test(rel);
}

/** Every counted function under <root>/server/stores. */
export function scanStores(root = ROOT) {
    const base = path.join(root, 'server');
    const out = [];
    const visit = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) visit(full); continue; }
            const rel = path.relative(base, full).split(path.sep).join('/');
            if (!isStoreSource(rel)) continue;
            for (const f of nonAtomicWrites(fs.readFileSync(full, 'utf8'), rel)) out.push({ file: rel, ...f });
        }
    };
    visit(path.join(base, 'stores'));
    return out;
}

function main() {
    const rows = scanStores();
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify(rows, null, 2));
        return;
    }
    for (const r of rows) console.log(`${r.file}:${r.line}  ${r.name}  [${r.tables.join(', ')}]`);
    console.log(`\n${rows.length} store functions write two or more tables without a transaction`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
