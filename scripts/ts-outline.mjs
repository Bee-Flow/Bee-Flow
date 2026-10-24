#!/usr/bin/env node
// Outline of a source file for agents that must split it with minimal reading.
//
//   node scripts/ts-outline.mjs <file> [--json]
//
// One line per top-level declaration: kind, name, lines (size), exported?, which
// other top-level declarations of the same file it references, which imports it
// uses and which tests reference it. Then "closed clusters": groups of
// declarations that reference the rest of the file only through members of the
// group, so they can move to a sibling without importing back (scripts/ts-split.mjs
// does the move).
//
// The parse is TypeScript 6's JS API (agent-hub/node_modules/typescript); .js, .cjs
// and .mjs are parsed as JavaScript. References are found with block/function scope
// (a parameter named like a top-level function does not count), not with type
// information; a name used only through `obj[name]` or a string is invisible.
//
// Tests that couple to the file's PATH instead of its exports are flagged in the header
// (WARN test coupling, `testCouplings` in --json): stubbing by the requiring file
// (`Module._resolveFilename` checking `parent.filename`, `require.cache[...]` keyed on a path)
// and `readFileSync` of the file itself. A split breaks those silently.
//
// The analysis (`analyze`, `findTests`, ...) is shared with ts-split.mjs.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { importsOf, readAliases } from './scc-ratchet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let tsCache;
/** TypeScript 6 from agent-hub (the server's TypeScript 7 has no JS API). */
export function loadTs() {
    tsCache ??= createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript');
    return tsCache;
}

const DIRECTIVE = /^\/\/\s*@(?:typecheck|ts-check|ts-nocheck)\b|^#!|^\/\*\s*eslint-disable(?!-next)|^\/\/\s*eslint-disable(?!-next)/;

/** Nearest directory at or above `file` with a package.json (else its own directory). */
export function packageRoot(file) {
    for (let d = path.dirname(file); ; d = path.dirname(d)) {
        if (fs.existsSync(path.join(d, 'package.json'))) return d;
        if (d === path.dirname(d)) return path.dirname(file);
    }
}

function scriptKind(ts, file) {
    if (/\.tsx$/.test(file)) return ts.ScriptKind.TSX;
    if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS;
    if (/\.jsx$/.test(file)) return ts.ScriptKind.JSX;
    return ts.ScriptKind.JS;
}

const hasExport = (ts, n) => !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
const hasDefault = (ts, n) => !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);

/** Names bound by a binding name / pattern. */
function bindingNames(ts, name, out = []) {
    if (ts.isIdentifier(name)) out.push(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindingNames(ts, el.name, out);
    return out;
}

/** `require('x')` optionally followed by property accesses: [specNode, suffixText] or null. */
function requireCall(ts, init, text) {
    let e = init;
    while (e && ts.isPropertyAccessExpression(e)) e = e.expression;
    if (e && ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require'
        && e.arguments.length === 1 && ts.isStringLiteral(e.arguments[0])) {
        return { spec: e.arguments[0], suffix: text.slice(e.end, init.end), call: e };
    }
    return null;
}

/** Start of a node including the comment lines attached to it (no blank line between). */
function attachedStart(ts, sf, text, node) {
    const start = node.getStart(sf);
    const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) || [];
    let begin = start;
    for (let i = ranges.length - 1; i >= 0; i--) {
        const r = ranges[i];
        if ((text.slice(r.end, begin).match(/\n/g) || []).length > 1) break;
        if (DIRECTIVE.test(text.slice(r.pos, r.end))) break;
        begin = r.pos;
    }
    return begin;
}

/** End of a node, plus a comment on the same line. */
function extendedEnd(text, end) {
    const rest = /^[ \t]*(?:\/\/[^\n]*|\/\*[^\n]*?\*\/)?[ \t]*(?=\r?\n|$)/.exec(text.slice(end));
    return rest ? end + rest[0].replace(/[ \t]+$/, '').length : end;
}

/**
 * References of one top-level statement: top-level names and import bindings it
 * mentions, scope-aware (parameters, let/const/var/function/class and type
 * parameters declared inside shadow top-level names).
 */
function collectRefs(ts, root, topNames, importNames) {
    const refs = new Set();
    const imps = new Set();
    const scopes = [];
    const shadowed = (n) => scopes.some((s) => s.has(n));
    const K = ts.SyntaxKind;
    const isFn = (n) => ts.isFunctionLike(n) && !ts.isFunctionTypeNode?.(n) || false;

    function declaredIn(statements, set) {
        for (const st of statements) {
            if (ts.isVariableStatement(st) && (st.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
                for (const d of st.declarationList.declarations) bindingNames(ts, d.name, []).forEach((x) => set.add(x));
            } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)
                || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) && st.name) set.add(st.name.text);
        }
    }
    function hoistedVars(node, set) {
        const walk = (n) => {
            if (n !== node && (ts.isFunctionLike(n) || ts.isClassLike(n))) return;
            if (ts.isVariableDeclarationList(n) && !(n.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) {
                for (const d of n.declarations) bindingNames(ts, d.name, []).forEach((x) => set.add(x));
            }
            ts.forEachChild(n, walk);
        };
        walk(node);
    }
    const typeParams = (n, set) => (n.typeParameters || []).forEach((t) => set.add(t.name.text));

    function visit(n) {
        let pushed = false;
        const set = new Set();
        if (ts.isFunctionLike(n)) {
            typeParams(n, set);
            for (const p of n.parameters || []) bindingNames(ts, p.name, []).forEach((x) => set.add(x));
            if ((ts.isFunctionExpression(n)) && n.name) set.add(n.name.text);
            if (n.body) hoistedVars(n.body, set);
            pushed = true;
        } else if (ts.isClassLike(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) {
            typeParams(n, set);
            if (ts.isClassExpression(n) && n.name) set.add(n.name.text);
            pushed = set.size > 0;
        } else if (ts.isBlock(n) || ts.isModuleBlock(n)) {
            declaredIn(n.statements, set); pushed = true;
        } else if (ts.isCaseBlock(n)) {
            for (const c of n.clauses) declaredIn(c.statements, set);
            pushed = true;
        } else if ((ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
            for (const d of n.initializer.declarations) bindingNames(ts, d.name, []).forEach((x) => set.add(x));
            pushed = true;
        } else if (ts.isCatchClause(n) && n.variableDeclaration) {
            bindingNames(ts, n.variableDeclaration.name, []).forEach((x) => set.add(x)); pushed = true;
        }
        if (pushed) scopes.push(set);

        if (ts.isIdentifier(n)) {
            const p = n.parent;
            const isName = p && p.name === n && (ts.isPropertyAccessExpression(p) || ts.isPropertyAssignment(p)
                || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) || ts.isMethodSignature(p)
                || ts.isGetAccessor(p) || ts.isSetAccessor(p) || ts.isEnumMember(p) || ts.isJsxAttribute(p)
                || ts.isFunctionDeclaration(p) || ts.isClassDeclaration(p) || ts.isInterfaceDeclaration(p)
                || ts.isTypeAliasDeclaration(p) || ts.isEnumDeclaration(p) || ts.isModuleDeclaration(p)
                || ts.isParameter(p) || ts.isVariableDeclaration(p) || ts.isBindingElement(p) || ts.isTypeParameterDeclaration(p)
                || ts.isFunctionExpression(p) || ts.isClassExpression(p) || ts.isLabeledStatement(p));
            const isRight = p && ts.isQualifiedName(p) && p.right === n;
            const isPropName = p && ts.isBindingElement(p) && p.propertyName === n;
            const isLabel = p && (ts.isBreakStatement(p) || ts.isContinueStatement(p));
            if (!isName && !isRight && !isPropName && !isLabel && !shadowed(n.text)) {
                if (topNames.has(n.text)) refs.add(n.text);
                if (importNames.has(n.text)) imps.add(n.text);
            }
        }
        ts.forEachChild(n, visit);
        if (pushed) scopes.pop();
    }
    void isFn; void K;
    visit(root);
    return { refs, imps };
}

/** Parse a file into units (top-level declarations and statements) and import bindings. */
export function analyze(file, textIn) {
    const ts = loadTs();
    const text = textIn ?? fs.readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(ts, file));
    const lineOf = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;

    const importStmts = []; // { node, start, end, spec, specNode, bindings, side, esm, typeOnly }
    const bindings = new Map(); // local -> binding
    const units = [];
    let esmSyntax = false; let cjsSyntax = false;

    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st)) {
            esmSyntax = true;
            const info = { node: st, spec: st.moduleSpecifier.text, specNode: st.moduleSpecifier, esm: true, bindings: [], side: !st.importClause, typeOnly: !!st.importClause?.isTypeOnly };
            const c = st.importClause;
            if (c?.name) info.bindings.push({ local: c.name.text, kind: 'default' });
            if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) info.bindings.push({ local: c.namedBindings.name.text, kind: 'ns' });
            if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) {
                for (const e of c.namedBindings.elements) info.bindings.push({ local: e.name.text, kind: 'named', imported: (e.propertyName || e.name).text, typeOnly: e.isTypeOnly });
            }
            for (const b of info.bindings) { b.stmt = info; b.spec = info.spec; b.typeOnly ||= info.typeOnly; bindings.set(b.local, b); }
            importStmts.push(info);
            continue;
        }
        if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1) {
            const d = st.declarationList.declarations[0];
            const rc = d.initializer && requireCall(ts, d.initializer, text);
            if (rc) {
                cjsSyntax = true;
                const info = { node: st, spec: rc.spec.text, specNode: rc.spec, esm: false, bindings: [], side: false, suffix: rc.suffix, declKeyword: (st.declarationList.flags & ts.NodeFlags.Const) ? 'const' : (st.declarationList.flags & ts.NodeFlags.Let) ? 'let' : 'var' };
                if (ts.isIdentifier(d.name)) info.bindings.push({ local: d.name.text, kind: 'cjs-whole' });
                else if (ts.isObjectBindingPattern(d.name) && !rc.suffix && d.name.elements.every((e) => ts.isIdentifier(e.name) && !e.dotDotDotToken && !e.initializer)) {
                    for (const e of d.name.elements) info.bindings.push({ local: e.name.text, kind: 'cjs-named', imported: (e.propertyName || e.name).text });
                }
                if (info.bindings.length) {
                    for (const b of info.bindings) { b.stmt = info; b.spec = info.spec; bindings.set(b.local, b); }
                    importStmts.push(info);
                    continue;
                }
            }
        }
        units.push({ node: st });
    }

    // Name the units.
    for (const u of units) {
        const st = u.node;
        u.names = []; u.kind = 'stmt'; u.exported = false; u.exportsList = [];
        if (ts.isFunctionDeclaration(st) && st.name) { u.kind = 'fn'; u.names = [st.name.text]; }
        else if (ts.isClassDeclaration(st) && st.name) { u.kind = 'class'; u.names = [st.name.text]; }
        else if (ts.isInterfaceDeclaration(st)) { u.kind = 'interface'; u.names = [st.name.text]; }
        else if (ts.isTypeAliasDeclaration(st)) { u.kind = 'type'; u.names = [st.name.text]; }
        else if (ts.isEnumDeclaration(st)) { u.kind = 'enum'; u.names = [st.name.text]; }
        else if (ts.isModuleDeclaration(st) && ts.isIdentifier(st.name)) { u.kind = 'namespace'; u.names = [st.name.text]; }
        else if (ts.isVariableStatement(st)) {
            u.kind = 'var';
            const init = st.declarationList.declarations.length === 1 ? st.declarationList.declarations[0].initializer : null;
            if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) u.kind = 'fn';
            else if (init && ts.isClassExpression(init)) u.kind = 'class';
            u.mutable = !(st.declarationList.flags & ts.NodeFlags.Const);
            for (const d of st.declarationList.declarations) bindingNames(ts, d.name, u.names);
        } else if (ts.isExportDeclaration(st)) {
            esmSyntax = true; u.kind = st.moduleSpecifier ? 'reexport' : 'exports';
        } else if (ts.isExportAssignment(st)) { esmSyntax = true; u.kind = 'exports'; }
        else if (ts.isExpressionStatement(st)) {
            const e = st.expression;
            const txt = e.getText(sf);
            if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && /^(?:module\.exports|exports)\b/.test(e.left.getText(sf))) {
                cjsSyntax = true; u.kind = 'exports';
            }
            void txt;
        }
        if (['fn', 'class', 'interface', 'type', 'enum', 'namespace', 'var'].includes(u.kind) && hasExport(ts, st)) {
            u.exported = true; esmSyntax = true;
            if (hasDefault(ts, st)) u.isDefault = true;
        }
        if (/^(?:module\.exports|exports)\b/.test(st.getText(sf)) && u.kind === 'stmt') u.kind = 'exports';
    }

    const topNames = new Set(units.flatMap((u) => u.names));
    const importNames = new Set(bindings.keys());
    const nameToUnit = new Map();
    units.forEach((u, i) => u.names.forEach((n) => nameToUnit.set(n, i)));

    for (const [i, u] of units.entries()) {
        u.index = i;
        const st = u.node;
        const start = attachedStart(ts, sf, text, st);
        u.start = start; u.end = extendedEnd(text, st.getEnd());
        u.startLine = lineOf(start); u.endLine = lineOf(Math.max(start, u.end - 1)); u.size = u.endLine - u.startLine + 1;
        let r;
        if (u.kind === 'exports' && ts.isExportDeclaration(st)) {
            r = { refs: new Set(), imps: new Set() };
            for (const e of st.exportClause?.elements || []) {
                const local = (e.propertyName || e.name).text;
                u.exportsList.push(local);
                if (topNames.has(local)) r.refs.add(local); if (importNames.has(local)) r.imps.add(local);
            }
        } else if (u.kind === 'reexport') r = { refs: new Set(), imps: new Set() };
        else r = collectRefs(ts, st, topNames, importNames);
        for (const n of u.names) r.refs.delete(n);
        u.refNames = r.refs; u.importUses = r.imps;
        u.refs = [...r.refs].map((n) => nameToUnit.get(n)).filter((x) => x !== undefined && x !== i);
        if (u.kind === 'exports' && !ts.isExportDeclaration(st)) {
            // module.exports = { A, b: B } / module.exports = A / exports.X = Y: the local names exported.
            const e = ts.isExpressionStatement(st) ? st.expression : st;
            const rhs = ts.isBinaryExpression(e) ? e.right : e.expression;
            if (ts.isObjectLiteralExpression(rhs)) {
                for (const p of rhs.properties) {
                    if (ts.isShorthandPropertyAssignment(p)) u.exportsList.push(p.name.text);
                    else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer)) u.exportsList.push(p.initializer.text);
                }
            } else if (rhs && ts.isIdentifier(rhs)) u.exportsList.push(rhs.text);
        }
    }
    // Exported = inline export modifier, or listed by an export statement.
    const listed = new Set(units.flatMap((u) => u.exportsList));
    for (const u of units) if (u.names.some((n) => listed.has(n))) u.exported = true;

    // Module style.
    const ext = path.extname(file);
    let moduleStyle;
    if (ext === '.cjs') moduleStyle = 'cjs';
    else if (['.mjs', '.ts', '.tsx', '.mts', '.jsx'].includes(ext)) moduleStyle = 'esm';
    else if (esmSyntax && !cjsSyntax) moduleStyle = 'esm';
    else if (cjsSyntax || /\brequire\(|module\.exports/.test(text)) moduleStyle = 'cjs';
    else {
        try { moduleStyle = JSON.parse(fs.readFileSync(path.join(packageRoot(file), 'package.json'), 'utf8')).type === 'module' ? 'esm' : 'cjs'; } catch { moduleStyle = 'cjs'; }
    }
    const typecheck = /^\s*(?:\/\/\s*@typecheck\b|\/\/\s*@ts-check\b)/m.test(text.slice(0, 400)) ? (/@ts-check/.test(text.slice(0, 400)) && !/@typecheck/.test(text.slice(0, 400)) ? '// @ts-check' : '// @typecheck') : null;

    return { ts, sf, file, text, units, importStmts, bindings, nameToUnit, moduleStyle, typecheck, lineCount: text.split('\n').length - (text.endsWith('\n') ? 1 : 0) };
}

/* ---------------------------------------------------------------- */
/* Tests that reference a file                                       */
/* ---------------------------------------------------------------- */

const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.vite', '.next']);
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
export const SOURCE_FILE_RE = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;

export function walk(dir, accept, out = []) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        if (e.name.startsWith('.') && e.name !== '.') continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(full, accept, out); } else if (accept(e.name)) out.push(full);
    }
    return out;
}

/** Absolute path a specifier points at, without extension resolution, or null for a bare package. */
export function specBase(from, spec, aliases) {
    const s = spec.replace(/[?#].*$/, '');
    if (s.startsWith('.')) return path.resolve(path.dirname(from), s);
    const a = aliases.find(([prefix]) => s.startsWith(prefix));
    return a ? path.join(a[1], s.slice(a[0].length)) : null;
}

/** Does `spec`, written in `from`, name `target`? */
export function specIsFile(from, spec, aliases, target) {
    const base = specBase(from, spec, aliases);
    if (!base) return false;
    const stem = target.replace(/\.[cm]?[jt]sx?$/, '');
    if (base === target || base === stem) return true;
    if (/\.[cm]?jsx?$/.test(base) && base.replace(/\.[cm]?jsx?$/, '') === stem) return true;
    return path.basename(stem) === 'index' && base === path.dirname(stem);
}

const MOCK_CALL = /(?:\b(?:vi|jest)\.(?:mock|doMock|unmock|importActual|requireActual|requireMock)|\bmock\.module)\(\s*(['"`])([^'"`\n]+)\1/g;
const CACHE_STUB = /require\.cache\[\s*require\.resolve\(\s*(['"`])([^'"`\n]+)\1/g;

/** Mock / stub references to `target` in a file's text: [{ line, text, kind }]. */
export function mockRefs(text, from, aliases, target) {
    const out = [];
    for (const [re, kind] of [[MOCK_CALL, 'mock'], [CACHE_STUB, 'require.cache']]) {
        for (const m of text.matchAll(re)) {
            if (!specIsFile(from, m[2], aliases, target)) continue;
            const line = text.slice(0, m.index).split('\n').length;
            out.push({ file: from, line, kind, text: text.split('\n')[line - 1].trim().slice(0, 140) });
        }
    }
    return out;
}

/** Test files that reference `file`: next to it, or importing / mocking it. */
export function findTests(file, textCache) {
    const pkg = packageRoot(file);
    const aliases = readAliases(pkg);
    const stem = path.basename(file).replace(/\.[cm]?[jt]sx?$/, '');
    const found = [];
    for (const t of walk(pkg, (n) => TEST_FILE.test(n))) {
        const text = textCache?.get(t) ?? fs.readFileSync(t, 'utf8');
        if (!text.includes(stem)) continue;
        const near = path.dirname(t) === path.dirname(file) && path.basename(t).startsWith(`${stem}.`);
        let imports = false;
        try { imports = importsOf(text).some((s) => specIsFile(t, s, aliases, file)); } catch { /* unreadable */ }
        const mocks = mockRefs(text, t, aliases, file);
        if (near || imports || mocks.length) found.push({ file: t, text, near, imports, mocks });
    }
    return found;
}

const lineOfIndex = (text, i) => text.slice(0, i).split('\n').length;
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Test coupling that a move or rename of `file` breaks WITHOUT a failing import:
 * [{ file, line, kind, text, message }]. `tests` is findTests(file).
 *   resolve-by-parent  Module._resolveFilename (or a require hook) that looks at `parent.filename`:
 *                      it stubs a module only for ONE requiring file, whose path changes when
 *                      the code moves
 *   require.cache      require.cache[...] keyed on a path built from the file name
 *   reads-source       readFileSync of the file's own path (a regex over its text): the text
 *                      is no longer there after a split
 */
export function testCouplings(file, tests) {
    const base = path.basename(file);
    const stem = base.replace(/\.[cm]?[jt]sx?$/, '');
    const out = [];
    const add = (t, index, kind, message) => {
        const line = lineOfIndex(t.text, index);
        out.push({ file: t.file, line, kind, text: t.text.split('\n')[line - 1].trim().slice(0, 140), message });
    };
    for (const t of tests) {
        const text = t.text;
        for (const m of text.matchAll(/_resolveFilename/g)) {
            const hit = /\bparent\??\.filename\b/.exec(text.slice(m.index, m.index + 700));
            if (hit) add(t, m.index + hit.index, 'resolve-by-parent', `stubs by the requiring file's path (Module._resolveFilename checks parent.filename): breaks silently when code moves out of ${base}; stub by the required module instead`);
        }
        for (const m of text.matchAll(/require\.cache\[([^\]\n]*)\]/g)) {
            if (!(m[1].includes(stem) || (/path\.|__dirname/.test(m[1]) && text.includes(stem)))) continue;
            add(t, m.index, 'require.cache', `require.cache keyed on a path (${m[1].trim().slice(0, 60)}): the key is the old file's path after a move`);
        }
        const literal = new RegExp(`['"\`][^'"\`\\n]*${esc(base)}['"\`]`);
        for (const m of text.matchAll(/readFileSync\(/g)) {
            const near = text.slice(Math.max(0, m.index - 300), m.index + 300);
            if (literal.test(near)) add(t, m.index, 'reads-source', `reads ${base} as text (readFileSync): a regex over the source finds nothing once declarations move out`);
        }
    }
    // One entry per (file, line, kind).
    const seen = new Set();
    return out.filter((w) => { const k = `${w.file}:${w.line}:${w.kind}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

/* ---------------------------------------------------------------- */
/* Clusters                                                          */
/* ---------------------------------------------------------------- */

/** Declarations (named units) and the closure each one needs. */
export function clusters(a) {
    const named = a.units.filter((u) => u.names.length && !u.isDefault);
    const idx = new Map(named.map((u) => [u.index, u]));
    const closure = (u) => {
        const seen = new Set(); const stack = [u.index];
        while (stack.length) {
            const i = stack.pop();
            if (seen.has(i) || !idx.has(i)) continue;
            seen.add(i);
            for (const r of idx.get(i).refs) stack.push(r);
        }
        return seen;
    };
    const closures = new Map(named.map((u) => [u.index, closure(u)]));
    // Roots: no other named declaration references them (a cycle with no outside referrer counts once).
    const referencedBy = new Map(named.map((u) => [u.index, new Set()]));
    for (const u of named) for (const r of u.refs) if (referencedBy.has(r)) referencedBy.get(r).add(u.index);
    const roots = named.filter((u) => {
        for (const by of referencedBy.get(u.index)) if (!closures.get(u.index).has(by)) return false;
        return true;
    });
    // Union roots whose closures overlap: the finest partition into independent closed groups.
    const parent = new Map(roots.map((r) => [r.index, r.index]));
    const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
    const owner = new Map();
    for (const r of roots) for (const i of closures.get(r.index)) {
        if (owner.has(i)) parent.set(find(r.index), find(owner.get(i))); else owner.set(i, r.index);
    }
    const groups = new Map();
    for (const r of roots) {
        const g = find(r.index);
        if (!groups.has(g)) groups.set(g, { roots: [], members: new Set() });
        groups.get(g).roots.push(r);
        for (const i of closures.get(r.index)) groups.get(g).members.add(i);
    }
    const sizeOf = (set) => [...set].reduce((n, i) => n + idx.get(i).size, 0);
    const out = [...groups.values()].map((g) => {
        const members = [...g.members].sort((x, y) => x - y);
        const g2 = { members: members.map((i) => idx.get(i).names.join('+')), lines: sizeOf(g.members), roots: g.roots.map((r) => r.names.join('+')) };
        const rootSet = new Set(g.roots.map((r) => r.index));
        const support = members.filter((i) => !rootSet.has(i));
        if (support.length && support.length < members.length) {
            g2.support = { members: support.map((i) => idx.get(i).names.join('+')), lines: sizeOf(new Set(support)) };
        }
        // Several roots: each root's closure. One root: the closures of its direct dependencies instead.
        const heads = g.roots.length > 1 ? g.roots : [...new Set(g.roots.flatMap((r) => r.refs))].map((i) => idx.get(i)).filter(Boolean);
        if (heads.length > 1) {
            g2.closures = heads.map((r) => {
                const c = closures.get(r.index);
                const shared = [...c].filter((i) => heads.some((o) => o !== r && closures.get(o.index).has(i)));
                return { root: r.names.join('+'), members: [...c].sort((x, y) => x - y).map((i) => idx.get(i).names.join('+')), lines: sizeOf(c), sharedWithOtherRoots: shared.map((i) => idx.get(i).names.join('+')) };
            }).filter((k) => g.roots.length > 1 || k.lines >= 25).sort((x, y) => y.lines - x.lines);
            g2.closuresOf = g.roots.length > 1 ? 'roots' : `dependencies of ${g.roots.map((r) => r.names.join('+')).join(',')}`;
        }
        return g2;
    }).sort((x, y) => y.lines - x.lines);
    return { groups: out, closureOf: (name) => { const i = a.nameToUnit.get(name); return i === undefined ? null : [...closures.get(i) ?? []].sort((x, y) => x - y).map((j) => idx.get(j).names.join('+')); } };
}

/* ---------------------------------------------------------------- */
/* Outline                                                           */
/* ---------------------------------------------------------------- */

export function outline(file) {
    const abs = path.resolve(file);
    const a = analyze(abs);
    const tests = findTests(abs);
    const tname = tests.map((t, i) => ({ id: `t${i + 1}`, file: path.relative(path.dirname(abs), t.file), mocks: t.mocks.length > 0, text: t.text }));
    const wordRe = (n) => new RegExp(`(?<![\\w$.])${n.replace(/\$/g, '\\$')}(?![\\w$])`);
    const rows = a.units.filter((u) => !['reexport'].includes(u.kind)).map((u) => {
        const name = u.names.length ? u.names.join('+') : (u.kind === 'exports' ? 'exports' : a.text.slice(u.node.getStart(a.sf), u.node.getEnd()).split('\n')[0].slice(0, 44));
        const testRefs = u.names.length ? tname.filter((t) => u.names.some((n) => wordRe(n).test(t.text))).map((t) => (t.mocks ? `${t.id}m` : t.id)) : [];
        return {
            kind: u.kind, name, from: u.startLine, to: u.endLine, size: u.size, exported: u.exported,
            refs: [...u.refNames].filter((n) => a.nameToUnit.has(n)), imports: [...u.importUses], tests: testRefs,
            ...(u.kind === 'exports' ? { exports: u.exportsList } : {}),
        };
    });
    const cl = clusters(a);
    return {
        file: abs.startsWith(`${ROOT}${path.sep}`) ? path.relative(ROOT, abs) : abs, lines: a.lineCount, module: a.moduleStyle, typecheck: a.typecheck,
        imports: a.importStmts.filter((s) => !s.side).map((s) => ({ spec: s.spec, names: s.bindings.map((b) => b.local) })),
        tests: tname.map((t) => ({ id: t.id, file: t.file, mocksThisFile: t.mocks })),
        testCouplings: testCouplings(abs, tests).map((w) => ({ ...w, file: path.relative(path.dirname(abs), w.file) })),
        declarations: rows, clusters: cl.groups,
    };
}

export function format(o) {
    const L = [];
    L.push(`${o.file}  ${o.lines} lines  ${o.module.toUpperCase()}${o.typecheck ? `  ${o.typecheck}` : ''}`);
    if (o.imports.length) L.push(`imports: ${o.imports.map((i) => `${i.spec}{${i.names.join(',')}}`).join(' ')}`);
    if (o.tests.length) L.push(`tests: ${o.tests.map((t) => `${t.id}=${t.file}${t.mocksThisFile ? '(mocks)' : ''}`).join(' ')}`);
    for (const w of o.testCouplings || []) L.push(`WARN test coupling ${w.file}:${w.line} [${w.kind}] ${w.message}`);
    L.push('decls (kind name Lstart-end size E=exported ->refs imp:imports T:tests, m=mocked there):');
    for (const d of o.declarations) {
        if (d.kind === 'exports') { L.push(`  L${d.from}-${d.to} exports: ${d.exports.join(',') || '(dynamic)'}`); continue; }
        const parts = [`  L${d.from}-${d.to}`, d.kind, d.name, `${d.size}${d.exported ? 'E' : ''}`];
        if (d.refs.length) parts.push(`->${d.refs.join(',')}`);
        if (d.imports.length) parts.push(`imp:${d.imports.join(',')}`);
        if (d.tests.length) parts.push(`T:${d.tests.join(',')}`);
        L.push(parts.join(' '));
    }
    L.push('closed clusters (move a whole cluster, or one root closure, without importing back):');
    const shown = o.clusters.filter((c) => c.lines >= 12 || o.clusters.length <= 6).slice(0, 12);
    for (const c of shown) {
        L.push(`  ${c.lines} lines: ${c.members.length > 14 ? `${c.members.slice(0, 14).join(',')},+${c.members.length - 14} more` : c.members.join(',')}`);
        if (c.support) L.push(`    support without the root${c.roots.length > 1 ? 's' : ''} (${c.roots.join(',')}), closed: ${c.support.lines} lines: ${c.support.members.join(',')}`);
        for (const k of (c.closures || []).slice(0, 6)) {
            L.push(`    ${c.closuresOf === 'roots' ? 'root' : 'dep'} ${k.root} (${k.lines} lines, ${k.members.length} decls)${k.sharedWithOtherRoots.length ? ` shares ${k.sharedWithOtherRoots.slice(0, 6).join(',')}` : ''}`);
        }
    }
    if (!shown.length) L.push('  (none)');
    if (o.clusters.length > shown.length) L.push(`  (+${o.clusters.length - shown.length} small clusters; --json lists all)`);
    return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith('--'));
    if (!file) { console.error('usage: node scripts/ts-outline.mjs <file> [--json]'); process.exit(2); }
    const o = outline(file);
    console.log(args.includes('--json') ? JSON.stringify(o, null, 2) : format(o));
}
