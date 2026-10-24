#!/usr/bin/env node
/**
 * catch-classify: find the server's swallowed errors, sort them into buckets and
 * rewrite the safe ones.
 *
 *   node scripts/catch-classify.mjs [--json] [--list <bucket>] [--dir <prefix>]
 *   node scripts/catch-classify.mjs --apply <bucket|all> [--dir <prefix>] [--files a,b] [--dry]
 *
 * A "swallowed error" is a failure that leaves no trace above debug level:
 *   debug-only   a catch clause whose only statement is `log.debug(...)`
 *   empty        a catch clause with an empty block (comments aside)
 *   promise      `.catch(() => null|undefined|{}|[])` or `.catch(() => {})`
 * Promise chains on the filesystem or a body parse (`fs.promises.stat(p).catch(() => null)`,
 * `res.json().catch(() => null)`) are parse-or-default and absent-or-default by design and are
 * not counted (EXPECTED_RECEIVER). The count-ratchet metric `swallowed-error` is `countSwallowed`.
 *
 * Buckets (first match wins):
 *   security-relevant  server/auth, server/license, erasure/DSR/billing/permission code, or a try
 *                      body that decides access. Listed, never rewritten: a person decides each.
 *   optional-table     the message names a missing table/column and the try runs a query.
 *                      Rewrite: `if (!isMissingTable(e)) throw e;` in front of the existing line.
 *   lazy-require       the try holds only `require(...)` statements.
 *                      Rewrite: `if (e?.code !== 'MODULE_NOT_FOUND') throw e;` in front.
 *   fallback           the try assigns to a binding declared outside it, or the promise result is
 *                      used. Rewrite: `fallback('<label>', e[, value])`.
 *   best-effort        everything else: telemetry, notifications, cleanup, cache, audit writes.
 *                      Rewrite: `bestEffort('<label>', e)`.
 *   unknown            a shape the rewrite does not recognise (no binding for log.debug's error,
 *                      several statements, an "already closed" cleanup). Listed.
 * `--apply` edits text spans only (everything outside them stays byte-identical), adds the
 * `require` of server/utils/{bestEffort,isMissingTable}, and re-parses the result; a file that no
 * longer parses is left untouched. The test gate lives with the caller (scripts/impact.mjs).
 *
 * TypeScript 6's JS API from agent-hub/node_modules, syntax only (no program), as ts-outline.mjs.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');

let tsCache;
function loadTs() {
    tsCache ??= createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript');
    return tsCache;
}

export const BUCKETS = ['optional-table', 'best-effort', 'fallback', 'lazy-require', 'security-relevant', 'unknown'];
const REWRITABLE = ['optional-table', 'lazy-require', 'fallback', 'best-effort'];

const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.(?:[cm]?js|[cm]?ts)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.vite', 'testUtils']);

// Sites under these paths, or whose try body decides access or touches personal-data lifecycle.
const SECURITY_PATH = /^(?:auth|license)\/|(?:^|\/)(?:erasure|dsr|billing|stripe|payments?|permissions?|retention|privacy|crypto|opaque|mfa|sso|oauth|scim|loginThrottle|usersDelete|apiKeys?)(?:[/.A-Z_-]|$)/i;
const SECURITY_BODY = /\b(?:isAdmin|isPlatformOperator|permissions?|revoke\w*|erase\w*|purge\w*|licen[cs]e\w*|markup|invoice|decrypt\w*|password|quota|authoriz\w*|canAccess\w*|requireAuth)\b|DELETE\s+FROM/i;

// Not rewritten: standalone CLIs and migrations, and the modules the helpers themselves sit on.
const OUT_OF_PROCESS = /^(?:scripts|migrations)\/|^telemetry\/(?:log|logSafe|otel)\.js$|^utils\/(?:bestEffort|isMissingTable)\.js$/;

const TABLE_WORDS = /\b(?:table|relation|schema|column)s?\b|42P01|42703|may not exist|does not exist|not (?:yet )?(?:migrated|provisioned|created)|older (?:db|schema|install)/i;
const QUERYING = /\bquery\s*\(|\.query\b|\bpool\b|\bdb\.|\bstore\.|\bclient\./;
const EXPECTED_NOOP = /already (?:closed|aborted|ended|destroyed|stopped|removed|gone|exists?)|not (?:open|running|connected)/i;
// Promise chains whose rejection is the normal "not there" / "not parseable" answer.
const EXPECTED_RECEIVER = /\bfs\b|\bfsp\b|\bpromises\b|\.json\(\s*\)|\.text\(\s*\)|\bJSON\.|\b(?:stat|lstat|access|readFile|readdir|unlink|rm|rmdir|mkdir|realpath|readlink)\(/;

const rel = (file) => path.relative(SERVER, file).split(path.sep).join('/');

export function listServerFiles(dir = SERVER) {
    const out = [];
    const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name)) walk(full);
            } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
                out.push(full);
            }
        }
    };
    walk(dir);
    return out.sort();
}

function scriptKind(ts, file) {
    if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS;
    return ts.ScriptKind.JS;
}

export function parse(text, file) {
    const ts = loadTs();
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
}

// ── shape predicates ──────────────────────────────────────────────────────────

function unparen(ts, n) {
    while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression?.(n))) n = n.expression;
    return n;
}

/** `log.debug(...)` as a statement. */
function isLogDebugStatement(ts, st) {
    if (!ts.isExpressionStatement(st)) return false;
    const call = st.expression;
    return ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression)
        && call.expression.name.text === 'debug'
        && ts.isIdentifier(call.expression.expression) && call.expression.expression.text === 'log';
}

/** null, undefined, void 0, {} or []. */
function isEmptyLiteral(ts, expr) {
    const n = unparen(ts, expr);
    if (!n) return false;
    if (n.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isIdentifier(n) && n.text === 'undefined') return true;
    if (ts.isVoidExpression(n)) return true;
    if (ts.isObjectLiteralExpression(n)) return n.properties.length === 0;
    if (ts.isArrayLiteralExpression(n)) return n.elements.length === 0;
    return false;
}

/** The `fn` of `.catch(fn)` when it yields nothing or an empty literal; { value } is its source text. */
function emptyFallbackFn(ts, sf, fn) {
    if (!(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
    if (fn.parameters.length > 1 || fn.parameters.some((p) => !ts.isIdentifier(p.name))) return null;
    const b = fn.body;
    if (ts.isBlock(b)) {
        if (b.statements.length === 0) return { value: null };
        if (b.statements.length === 1 && ts.isReturnStatement(b.statements[0])) {
            const r = b.statements[0].expression;
            if (!r) return { value: null };
            return isEmptyLiteral(ts, r) ? { value: literalValue(ts, sf, r) } : null;
        }
        return null;
    }
    return isEmptyLiteral(ts, b) ? { value: literalValue(ts, sf, b) } : null;
}

/** Source text of the fallback literal; null and undefined both read as "no value" (undefined), null stays. */
function literalValue(ts, sf, expr) {
    const n = unparen(ts, expr);
    if ((ts.isIdentifier(n) && n.text === 'undefined') || ts.isVoidExpression(n)) return null;
    return n.getText(sf);
}

/** Is the value of the call used, or does it stand alone as a statement (through await/void/parens)? */
function resultUsed(ts, call) {
    let p = call.parent;
    while (p && (ts.isParenthesizedExpression(p) || ts.isAwaitExpression(p) || ts.isVoidExpression(p) || ts.isNonNullExpression(p))) p = p.parent;
    return !(p && ts.isExpressionStatement(p));
}

/** A readable name for the code around a node: `Class.method`, `function`, `const x = () =>`, else ''. */
function enclosingName(ts, node) {
    for (let p = node.parent; p; p = p.parent) {
        let name = '';
        if (ts.isFunctionDeclaration(p) && p.name) name = p.name.text;
        else if ((ts.isMethodDeclaration(p) || ts.isPropertyAssignment(p)) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
            const isFn = ts.isMethodDeclaration(p) || (p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer)));
            if (isFn) name = p.name.text;
        } else if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) name = p.name.text;
        if (name) {
            const cls = ts.isMethodDeclaration(p) ? p.parent : null;
            return cls && ts.isClassLike(cls) && cls.name ? `${cls.name.text}.${name}` : name;
        }
    }
    return '';
}

/** Names declared inside `node` (variables, parameters, functions), to tell an outer assignment from a local one. */
function declaredWithin(ts, node) {
    const names = new Set();
    const visit = (n) => {
        if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name)) names.add(n.name.text);
        if (ts.isFunctionDeclaration(n) && n.name) names.add(n.name.text);
        ts.forEachChild(n, visit);
    };
    visit(node);
    return names;
}

/** Does the try body assign to a binding it did not declare itself (the default stays when it throws)? */
function assignsOuter(ts, tryBlock) {
    const local = declaredWithin(ts, tryBlock);
    let found = false;
    const visit = (n) => {
        if (found) return;
        if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
            let target = n.left;
            while (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) target = target.expression;
            if (ts.isIdentifier(target) && !local.has(target.text)) found = true;
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'push') found = true;
        ts.forEachChild(n, visit);
    };
    visit(tryBlock);
    return found;
}

const REQUIRE_ONLY = /^(?:(?:const|let|var)\s+[^=]+=\s*|[\w.$]+\s*=\s*)?(?:await\s+)?require\s*\([^)]*\)(?:\.[\w$]+)*\s*;?$/;

/** String text of a log message argument, or '' when it is not a plain literal. */
function messageOf(ts, call) {
    const a = call.arguments[0];
    if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) return a.text;
    if (a && ts.isTemplateExpression(a)) return a.head.text + a.templateSpans.map((s) => s.literal.text).join(' ');
    return '';
}

// ── scan ──────────────────────────────────────────────────────────────────────

/**
 * Every swallowed-error site in one file.
 * @returns {Array<{ file: string, line: number, kind: string, bucket: string, reason: string, fn: string, start: number, end: number, ... }>}
 */
export function scanText(text, file) {
    const ts = loadTs();
    const sf = parse(text, file);
    const r = rel(file);
    const sites = [];
    const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    const securityPath = SECURITY_PATH.test(r);

    const visit = (node) => {
        if (ts.isCatchClause(node)) catchSite(node);
        else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'catch' && node.arguments.length === 1) promiseSite(node);
        ts.forEachChild(node, visit);
    };

    function catchSite(node) {
        const stmts = node.block.statements;
        const empty = stmts.length === 0;
        if (!empty && !stmts.every((s) => isLogDebugStatement(ts, s))) return;
        const tryStmt = node.parent;
        const tryText = tryStmt.tryBlock.getText(sf);
        const bind = node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name) ? node.variableDeclaration.name.text : null;
        const site = {
            file: r, line: lineOf(node.getStart(sf)), kind: empty ? 'empty' : 'debug-only', fn: enclosingName(ts, node),
            msg: '', bucket: 'unknown', reason: '', bind, node, sf,
        };
        let call = null;
        if (!empty) {
            call = stmts[0].expression;
            site.msg = messageOf(ts, call);
        }
        const bodyStatements = tryStmt.tryBlock.statements;
        const reqOnly = bodyStatements.length > 0 && bodyStatements.every((s) => REQUIRE_ONLY.test(s.getText(sf).trim()));

        if (OUT_OF_PROCESS.test(r)) {
            site.reason = 'runs outside the request path (scripts, migrations) or underneath the helpers (log, otel)';
        } else if (securityPath || SECURITY_BODY.test(tryText) || SECURITY_BODY.test(site.fn)) {
            site.bucket = 'security-relevant';
            site.reason = securityPath ? 'path' : 'try body decides access or touches personal data';
        } else if (!empty && stmts.length > 1) {
            site.reason = 'several log.debug statements';
        } else if (!empty && !(bind && call.arguments.length >= 1 && call.arguments.some((a) => ts.isIdentifier(a) && a.text === bind))) {
            site.reason = 'log.debug does not pass the caught error';
        } else if (empty && node.block.getText(sf).replace(/\s/g, '') !== '{}') {
            site.reason = 'empty catch carrying a comment';
        } else if (EXPECTED_NOOP.test(site.msg)) {
            site.reason = 'expected no-op (already closed/gone)';
        } else if (TABLE_WORDS.test(site.msg) && QUERYING.test(tryText) && bind) {
            site.bucket = 'optional-table';
        } else if (reqOnly && bind) {
            site.bucket = 'lazy-require';
        } else if (assignsOuter(ts, tryStmt.tryBlock)) {
            site.bucket = 'fallback';
        } else {
            site.bucket = 'best-effort';
        }
        sites.push(site);
    }

    function promiseSite(node) {
        const fnInfo = emptyFallbackFn(ts, sf, node.arguments[0]);
        if (!fnInfo) return;
        const receiver = node.expression.expression.getText(sf);
        if (EXPECTED_RECEIVER.test(receiver)) return;
        const used = resultUsed(ts, node);
        const site = {
            file: r, line: lineOf(node.getStart(sf)), kind: 'promise', fn: enclosingName(ts, node), msg: '',
            bucket: used ? 'fallback' : 'best-effort', reason: '', value: fnInfo.value, node, sf,
        };
        if (OUT_OF_PROCESS.test(r)) {
            site.bucket = 'unknown';
            site.reason = 'runs outside the request path (scripts, migrations) or underneath the helpers (log, otel)';
        } else if (securityPath || SECURITY_BODY.test(receiver) || SECURITY_BODY.test(site.fn)) {
            site.bucket = 'security-relevant';
            site.reason = securityPath ? 'path' : 'receiver decides access or touches personal data';
        } else if (/^\s*await\s+import\s*\(|^\s*import\s*\(/.test(receiver) || /^\s*require\s*\(/.test(receiver)) {
            site.bucket = 'lazy-require';
            site.reason = 'promise form: no mechanical rewrite';
            site.manual = true;
        }
        sites.push(site);
    }

    visit(sf);
    return sites;
}

/** Count for the `swallowed-error` ratchet: every site of kinds debug-only, empty and promise. */
export function countSwallowed(text, file) {
    if (!/\blog\s*\.\s*debug\b|\bcatch\b/.test(text)) return 0;
    return scanText(text, file).length;
}

export function scanAll(dir = SERVER, filter = () => true) {
    const sites = [];
    for (const file of listServerFiles(dir)) {
        if (!filter(rel(file))) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (!/\bcatch\b/.test(text)) continue;
        for (const s of scanText(text, file)) sites.push(s);
    }
    return sites;
}

// ── rewrite ───────────────────────────────────────────────────────────────────

const HELPER_MODULE = { bestEffort: 'utils/bestEffort', fallback: 'utils/bestEffort', isMissingTable: 'utils/isMissingTable' };

function sanitizeLabel(s) {
    return s.replace(/[^\w/.:#$-]/g, '');
}

/** Insert (or extend) the require/import of the helpers a rewrite uses. Returns the new text, or null when unsafe. */
function addImports(ts, text, file, sf, names, local) {
    const esm = /\.mjs$|\.mts$/.test(file) || (!/\brequire\s*\(/.test(text) && sf.statements.some((s) => ts.isImportDeclaration(s)));
    const dir = path.dirname(file);
    const byModule = new Map();
    for (const n of names) {
        const mod = HELPER_MODULE[n];
        if (!byModule.has(mod)) byModule.set(mod, new Set());
        byModule.get(mod).add(n);
    }
    let out = text;
    const lines = [];
    for (const [mod, set] of byModule) {
        let spec = path.relative(dir, path.join(SERVER, mod)).split(path.sep).join('/');
        if (!spec.startsWith('.')) spec = `./${spec}`;
        const already = new RegExp(`(?:require\\(|from\\s+)['"]${spec.replace(/[./]/g, '\\$&')}(?:\\.js)?['"]`).test(text);
        if (already) return { text: null, reason: `${mod} already imported` };
        const parts = [];
        for (const n of set) parts.push(local(n) === n ? n : `${n}: ${local(n)}`);
        lines.push(esm
            ? `import { ${parts.map((p) => p.replace(': ', ' as ')).join(', ')} } from '${spec}.js';`
            : `const { ${parts.join(', ')} } = require('${spec}');`);
    }
    // After the last top-level require/import statement, else after the directive prologue / leading comments.
    let at = -1;
    for (const s of sf.statements) {
        const t = s.getText(sf);
        if (ts.isImportDeclaration(s) || (ts.isVariableStatement(s) && /\brequire\s*\(/.test(t) && !/=>|function/.test(t))) at = s.getEnd();
        else if (at >= 0 && !ts.isImportDeclaration(s)) { /* keep scanning: requires may follow a statement */ }
    }
    if (at < 0) {
        const first = sf.statements.find((s) => !(ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)));
        if (!first) return { text: null, reason: 'no insertion point' };
        out = `${text.slice(0, first.getStart(sf))}${lines.join('\n')}\n${text.slice(first.getStart(sf))}`;
    } else {
        out = `${text.slice(0, at)}\n${lines.join('\n')}${text.slice(at)}`;
    }
    return { text: out };
}

/**
 * Rewrite the sites of the given buckets in one file.
 * @returns {{ text: string|null, applied: object[], skipped: object[] }}
 */
export function rewriteText(text, file, buckets) {
    const ts = loadTs();
    const sites = scanText(text, file);
    const sf = sites[0]?.sf ?? parse(text, file);
    const used = new Set();
    // A helper name that already means something else in the file is imported under an alias, never shadowed.
    const taken = new Set();
    const collect = (n) => { if (ts.isIdentifier(n)) taken.add(n.text); ts.forEachChild(n, collect); };
    collect(sf);
    const local = (h) => (taken.has(h) ? `${h}Swallowed` : h);
    const edits = [];
    const applied = [];
    const skipped = [];

    // Label seed: labels already in the file, so a second run never reuses one.
    const seen = new Map();
    for (const m of text.matchAll(/(?:bestEffort|fallback)\w*\(\s*'([^']+)'/g)) seen.set(m[1], 1);
    const mod = rel(file).replace(/\.[cm]?[jt]s$/, '');
    const labelFor = (site) => {
        let base = sanitizeLabel(`${mod}:${site.fn || 'anon'}`);
        let label = base;
        for (let n = 2; seen.has(label); n++) label = `${base}#${n}`;
        seen.set(label, 1);
        return label;
    };

    for (const site of sites) {
        if (!buckets.includes(site.bucket)) continue;
        if (site.manual) { skipped.push({ file: site.file, line: site.line, reason: site.reason }); continue; }
        const node = site.node;
        if (site.kind === 'promise') {
            const fn = node.arguments[0];
            const label = labelFor(site);
            const helper = site.bucket === 'best-effort' ? 'bestEffort' : 'fallback';
            used.add(helper);
            const value = site.bucket === 'fallback' && site.value !== null ? `, ${site.value}` : '';
            edits.push({ start: fn.getStart(sf), end: fn.getEnd(), text: `(e) => ${local(helper)}('${label}', e${value})` });
            applied.push({ file: site.file, line: site.line, bucket: site.bucket });
            continue;
        }
        // Catch clause.
        const block = node.block;
        let bind = site.bind;
        const edit = {};
        if (!bind) {
            // `catch {` / empty `catch (…) {`: give the clause a binding.
            if (node.variableDeclaration) { skipped.push({ file: site.file, line: site.line, reason: 'destructured catch binding' }); continue; }
            bind = 'e';
            edit.addBinding = true;
        }
        const catchKw = node.getStart(sf) + 'catch'.length;
        if (site.bucket === 'optional-table' || site.bucket === 'lazy-require') {
            const guard = site.bucket === 'optional-table' ? `if (!${local('isMissingTable')}(${bind})) throw ${bind};` : `if (${bind}?.code !== 'MODULE_NOT_FOUND') throw ${bind};`;
            if (site.bucket === 'optional-table') used.add('isMissingTable');
            const first = block.statements[0];
            const startPos = first.getStart(sf);
            const between = text.slice(block.getStart(sf) + 1, startPos);
            const multiline = between.includes('\n');
            const indent = multiline ? between.slice(between.lastIndexOf('\n') + 1) : '';
            edits.push({ start: startPos, end: startPos, text: multiline ? `${guard}\n${indent}` : `${guard} ` });
        } else {
            const helper = site.bucket === 'best-effort' ? 'bestEffort' : 'fallback';
            used.add(helper);
            const label = labelFor(site);
            const call = `${local(helper)}('${label}', ${bind});`;
            if (site.kind === 'empty') {
                edits.push({ start: block.getStart(sf), end: block.getEnd(), text: `{ ${call} }` });
            } else {
                const first = block.statements[0];
                const restOfLine = text.slice(first.getEnd(), text.indexOf('\n', first.getEnd()) < 0 ? text.length : text.indexOf('\n', first.getEnd()));
                const note = site.msg.trim();
                const keep = note && !note.includes('\n') && !note.includes('*/') && note.length <= 90;
                const comment = !keep ? '' : restOfLine.trim() === '' ? ` // ${note}` : ` /* ${note} */`;
                edits.push({ start: first.getStart(sf), end: first.getEnd(), text: `${call}${comment}` });
            }
        }
        if (edit.addBinding) {
            // `catch {` → `catch (e) {`; `catch{` too.
            edits.push({ start: catchKw, end: catchKw, text: ' (e)' });
        }
        applied.push({ file: site.file, line: site.line, bucket: site.bucket });
    }
    if (!edits.length) return { text: null, applied, skipped };

    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let out = text;
    for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

    const withImports = addImports(ts, out, file, parse(out, file), [...used], local);
    if (!withImports.text) {
        return { text: null, applied: [], skipped: [...skipped, ...applied.map((a) => ({ ...a, reason: withImports.reason }))] };
    }
    out = withImports.text;
    const bad = ts.transpileModule(out, { reportDiagnostics: true, fileName: file, compilerOptions: { allowJs: true } }).diagnostics ?? [];
    if (bad.length) { if (process.env.CC_DEBUG) console.error(file, bad.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), out); }
    if (bad.length) return { text: null, applied: [], skipped: [...skipped, ...applied.map((a) => ({ ...a, reason: 'rewrite does not parse' }))] };
    return { text: out, applied, skipped };
}


// ── test gate ─────────────────────────────────────────────────────────────────

const SERVER_ENV = {
    NODE_ENV: 'test',
    SESSION_SECRET: 'ci-session-secret-value-at-least-32-chars-long',
    MASTER_ENCRYPTION_KEY: 'ci-master-encryption-key-for-tests-only!!',
};
const TEST_TIMEOUT_MS = 240_000;

function runTest(testRel) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ['--test', '--require', './testUtils/registerFeatures.js', testRel], {
            cwd: SERVER, env: { ...process.env, ...SERVER_ENV }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => { out += d; if (out.length > 200_000) out = out.slice(-100_000); });
        child.stderr.on('data', (d) => { out += d; if (out.length > 200_000) out = out.slice(-100_000); });
        const timer = setTimeout(() => { out += '\n(catch-classify: timeout)'; child.kill('SIGKILL'); }, TEST_TIMEOUT_MS);
        child.on('close', (code) => { clearTimeout(timer); resolve({ test: testRel, ok: code === 0, tail: out.slice(-1500) }); });
    });
}

async function runPool(tests, width = 3) {
    const results = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(width, tests.length) }, async () => {
        while (next < tests.length) results.push(await runTest(tests[next++]));
    }));
    return results;
}

/**
 * Run the tests that cover the rewritten files. A red test is traced to the file(s) whose rewrite
 * breaks it (revert them all, then put them back one by one) and those files are restored;
 * a test that is red without any rewrite is reported as pre-existing and keeps the rewrites.
 * @param {Map<string, { original: string, rewritten: string }>} changes server-relative path -> texts
 */
async function gate(changes) {
    const { buildGraph, select } = await import('./impact.mjs');
    const graph = buildGraph(ROOT);
    const covers = new Map(); // test (server-relative) -> Set of changed files it covers
    for (const f of changes.keys()) {
        const sel = select(graph, [`server/${f}`]);
        for (const t of sel.tests.keys()) {
            if (!t.startsWith('server/')) continue;
            const k = t.slice('server/'.length);
            if (!covers.has(k)) covers.set(k, new Set());
            covers.get(k).add(f);
        }
    }
    const write = (f, which) => fs.writeFileSync(path.join(SERVER, f), changes.get(f)[which]);
    const first = await runPool([...covers.keys()]);
    const red = first.filter((r) => !r.ok);
    const reverted = [];
    const preExisting = [];
    for (const r of red) {
        const cands = [...covers.get(r.test)].filter((f) => !reverted.some((x) => x.file === f));
        if (!cands.length) continue; // already explained by an earlier revert: recheck below
        for (const f of cands) write(f, 'original');
        const clean = await runTest(r.test);
        if (!clean.ok) {
            for (const f of cands) write(f, 'rewritten');
            preExisting.push({ test: r.test, tail: clean.tail });
            continue;
        }
        // Put the files back one at a time; the one that turns the test red is the culprit and stays reverted.
        for (const f of cands) {
            write(f, 'rewritten');
            const again = await runTest(r.test);
            if (!again.ok) {
                write(f, 'original');
                reverted.push({ file: f, test: r.test, tail: again.tail });
            }
        }
    }
    // Everything that was reverted changes what the other tests see: one confirming pass over the tests that were red.
    const recheck = await runPool(red.map((r) => r.test));
    const stillRed = recheck.filter((r) => !r.ok && !preExisting.some((p) => p.test === r.test));
    return { ran: covers.size, red: red.map((r) => r.test), reverted, preExisting: preExisting.map((p) => p.test), stillRed: stillRed.map((r) => r.test) };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function summarize(sites) {
    const counts = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
    const kinds = {};
    for (const s of sites) {
        counts[s.bucket]++;
        kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    }
    return { total: sites.length, buckets: counts, kinds };
}

const plain = (s) => ({ file: s.file, line: s.line, kind: s.kind, bucket: s.bucket, fn: s.fn, msg: s.msg || undefined, reason: s.reason || undefined });

async function main(argv) {
    const flags = new Map();
    for (let i = 0; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--') && ['--list', '--apply', '--dir', '--files'].includes(argv[i])) { flags.set(argv[i], next); i++; } else flags.set(argv[i], true);
    }
    const dir = flags.get('--dir');
    const files = flags.get('--files') ? new Set(String(flags.get('--files')).split(',')) : null;
    const filter = (r) => (!dir || r.startsWith(dir)) && (!files || files.has(r));

    if (flags.has('--apply')) {
        const which = flags.get('--apply');
        const buckets = which === 'all' ? REWRITABLE : [which];
        if (buckets.some((b) => !REWRITABLE.includes(b))) {
            console.error(`catch-classify: --apply takes ${REWRITABLE.join('|')}|all (security-relevant and unknown are never rewritten)`);
            return 2;
        }
        const touched = [];
        const skipped = [];
        const changes = new Map();
        let n = 0;
        for (const file of listServerFiles()) {
            const r = rel(file);
            if (!filter(r)) continue;
            const text = fs.readFileSync(file, 'utf8');
            if (!/\bcatch\b/.test(text)) continue;
            const res = rewriteText(text, file, buckets);
            skipped.push(...res.skipped);
            if (!res.text) continue;
            n += res.applied.length;
            touched.push(r);
            changes.set(r, { original: text, rewritten: res.text });
            if (!flags.has('--dry')) fs.writeFileSync(file, res.text);
        }
        let gated = null;
        if (flags.has('--gate') && !flags.has('--dry')) gated = await gate(changes);
        console.log(JSON.stringify({ applied: n, files: touched, skipped, gate: gated }, null, 2));
        return gated && (gated.reverted.length || gated.stillRed.length) ? 1 : 0;
    }

    const sites = scanAll(SERVER, filter);
    if (flags.has('--list')) {
        const bucket = flags.get('--list');
        for (const s of sites) {
            if (bucket !== true && s.bucket !== bucket) continue;
            console.log(`server/${s.file}:${s.line}  ${s.kind}  ${s.bucket}${s.reason ? `  (${s.reason})` : ''}${s.msg ? `  "${s.msg}"` : ''}`);
        }
        return 0;
    }
    if (flags.has('--json')) {
        console.log(JSON.stringify({ ...summarize(sites), sites: sites.map(plain) }, null, 2));
        return 0;
    }
    const sum = summarize(sites);
    console.log(`swallowed errors in server/: ${sum.total}`);
    for (const b of BUCKETS) console.log(`  ${b.padEnd(18)} ${String(sum.buckets[b]).padStart(5)}`);
    console.log(`  kinds: ${Object.entries(sum.kinds).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(await main(process.argv.slice(2)));
}
