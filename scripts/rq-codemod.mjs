#!/usr/bin/env node
// rq-codemod: move agent-hub data fetching onto react-query, for the canonical
// shapes only. Anything outside them is skipped and reported with a reason.
//
//   node scripts/rq-codemod.mjs <files...> [--dry] [--mode query|mutation|both]
//                                          [--report out.json]
//
// query mode     A component with `useState` data/loading/error plus ONE
//                `useEffect` that does a single GET through authFetch and
//                `setX(json)` becomes a hook in `agent-hub/src/api/queries/
//                <feature>.ts` (`useQuery`, authFetch kept INSIDE queryFn so
//                the existing test mocks of authFetch keep working) and the
//                component reads `data / loading / error` from it.
// mutation mode  `const res = await authFetch(url, { method: 'POST'|... })`
//                whose Response is checked through `res.ok` becomes `mutate()`
//                (api/mutate.ts, throws ApiError on non-2xx); the `!res.ok`
//                branch moves into a catch of ApiError.
//
// Tests that render a converted component without a QueryClient are LISTED in
// the report (`testsNeedingClient`); the tool never rewrites tests.
//
// Behaviour kept on purpose: `retry: false` and `staleTime: 0` in the hook (the
// effect fetched once per mount and never retried), `isFetching` as `loading`
// (true again whenever the key changes, like the old `setLoading(true)`), the
// old initial value as the fallback while there is no data.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ts = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript');
const K = ts.SyntaxKind;

// ---------------------------------------------------------------- text edits

function applyEdits(text, edits) {
    const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
    let out = text;
    let lastStart = Infinity;
    for (const e of sorted) {
        if (e.end > lastStart) throw new Error(`overlapping edits at ${e.start}`);
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
        lastStart = e.start;
    }
    return out;
}

function parse(file, text) {
    return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function walk(node, fn) {
    fn(node);
    ts.forEachChild(node, (c) => walk(c, fn));
}

const isFunctionLike = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

function indentOf(text, pos) {
    const ls = text.lastIndexOf('\n', pos - 1) + 1; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a repo script that reads local source files; its regexes are anchored or single-class, linear
    return /^[ \t]*/.exec(text.slice(ls, pos))[0];
}

/** Start of the line of `pos` and the end including the newline (for removing whole statements). */
function lineSpan(text, node, sf) {
    const start = node.getStart(sf);
    let s = text.lastIndexOf('\n', start - 1) + 1;
    let whole = true;
    if (text.slice(s, start).trim() !== '') { s = start; whole = false; }
    let e = node.getEnd();
    const nl = /^[ \t]*\r?\n/.exec(text.slice(e));
    if (nl && whole) e += nl[0].length;
    return { start: s, end: e };
}

// ------------------------------------------------------------------- imports

function importMap(sf) {
    const m = new Map();
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        const mod = st.moduleSpecifier.text;
        const clause = st.importClause;
        if (!clause) continue;
        if (clause.name) m.set(clause.name.text, { module: mod, imported: 'default', typeOnly: clause.isTypeOnly });
        const nb = clause.namedBindings;
        if (nb && ts.isNamedImports(nb)) {
            for (const el of nb.elements) {
                m.set(el.name.text, { module: mod, imported: (el.propertyName || el.name).text, typeOnly: clause.isTypeOnly || el.isTypeOnly });
            }
        } else if (nb && ts.isNamespaceImport(nb)) {
            m.set(nb.name.text, { module: mod, imported: '*', typeOnly: clause.isTypeOnly });
        }
    }
    return m;
}

function topLevelNames(sf) {
    const names = new Set();
    for (const st of sf.statements) {
        if (ts.isVariableStatement(st)) {
            for (const d of st.declarationList.declarations) collectBindingNames(d.name, names);
        } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) {
            names.add(st.name.text);
        }
    }
    return names;
}

function collectBindingNames(name, set) {
    if (ts.isIdentifier(name)) set.add(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) collectBindingNames(el.name, set);
}

/** Text edit that makes `names` importable from `module` (merges into an existing declaration). */
function addImportEdit(text, sf, module, names, typeOnly = false) {
    const want = names.filter(Boolean);
    if (!want.length) return null;
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== module) continue;
        const c = st.importClause;
        if (!c || !c.namedBindings || !ts.isNamedImports(c.namedBindings)) continue;
        if (!!c.isTypeOnly !== typeOnly) continue;
        const have = new Set(c.namedBindings.elements.map((e) => e.name.text));
        const add = want.filter((n) => !have.has(n));
        if (!add.length) return { start: 0, end: 0, text: '' };
        const els = c.namedBindings.elements;
        if (els.length === 0) return { start: c.namedBindings.getStart(sf), end: c.namedBindings.getEnd(), text: `{ ${add.join(', ')} }` };
        const last = els[els.length - 1];
        return { start: last.getEnd(), end: last.getEnd(), text: `, ${add.join(', ')}` };
    }
    const imports = sf.statements.filter(ts.isImportDeclaration);
    const line = `import ${typeOnly ? 'type ' : ''}{ ${want.join(', ')} } from '${module}';\n`;
    if (!imports.length) return { start: 0, end: 0, text: line + '\n' };
    const last = imports[imports.length - 1];
    return { start: last.getEnd() + 1, end: last.getEnd() + 1, text: line };
}

/** Remove import specifiers from `candidates` that nothing references any more. */
function pruneImports(file, text, candidates) {
    const sf = parse(file, text);
    const used = new Set();
    walk(sf, (n) => {
        if (ts.isIdentifier(n) && !hasAncestor(n, ts.isImportDeclaration)) used.add(n.text);
    });
    const edits = [];
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !st.importClause) continue;
        const c = st.importClause;
        const nb = c.namedBindings;
        if (!nb || !ts.isNamedImports(nb)) continue;
        const keep = nb.elements.filter((e) => !(candidates.has(e.name.text) && !used.has(e.name.text)));
        if (keep.length === nb.elements.length) continue;
        if (keep.length === 0 && !c.name) {
            const sp = lineSpan(text, st, sf);
            edits.push({ start: sp.start, end: sp.end, text: '' });
        } else {
            const typePrefix = c.isTypeOnly ? 'type ' : '';
            const def = c.name ? c.name.text + (keep.length ? ', ' : '') : '';
            const body = keep.length ? `{ ${keep.map((e) => e.getText(sf)).join(', ')} }` : '';
            edits.push({ start: c.getStart(sf), end: c.getEnd(), text: `${typePrefix}${def}${body}` });
        }
    }
    return applyEdits(text, edits);
}

function hasAncestor(node, pred) {
    for (let p = node.parent; p; p = p.parent) if (pred(p)) return true;
    return false;
}

function relModule(fromFile, toFileNoExt) {
    let r = path.relative(path.dirname(fromFile), toFileNoExt).split(path.sep).join('/');
    if (!r.startsWith('.')) r = './' + r;
    return r;
}

// -------------------------------------------------------------- identifiers

function isDeclarationName(id) {
    const p = id.parent;
    return (
        ((ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p) || ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) || ts.isClassDeclaration(p)) && p.name === id) ||
        (ts.isBindingElement(p) && p.propertyName === id) ||
        (ts.isPropertyAccessExpression(p) && p.name === id) ||
        (ts.isPropertyAssignment(p) && p.name === id) ||
        (ts.isPropertySignature(p) && p.name === id) ||
        (ts.isMethodDeclaration(p) && p.name === id) ||
        (ts.isMethodSignature(p) && p.name === id) ||
        (ts.isQualifiedName(p) && p.right === id) ||
        (ts.isCatchClause(p.parent || p) && ts.isVariableDeclaration(p) && p.name === id) ||
        (ts.isJsxAttribute(p) && p.name === id) ||
        (ts.isLabeledStatement(p) && p.label === id) ||
        (ts.isTypeParameterDeclaration(p) && p.name === id)
    );
}

/** Names referenced in `nodes` that are not declared inside them. */
function freeNames(nodes) {
    const declared = new Set();
    const refs = new Set();
    for (const root of nodes) {
        walk(root, (n) => {
            if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) {
                if (n.name) collectBindingNames(n.name, declared);
            } else if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n)) && n.name) {
                declared.add(n.name.text);
            }
        });
    }
    for (const root of nodes) {
        walk(root, (n) => {
            if (ts.isIdentifier(n) && !isDeclarationName(n)) refs.add(n.text);
        });
    }
    for (const d of declared) refs.delete(d);
    return refs;
}

function refsOf(root, name, filter = (/** @type {any} */ _n) => true) {
    const out = [];
    walk(root, (n) => {
        if (ts.isIdentifier(n) && n.text === name && !isDeclarationName(n) && filter(n)) out.push(n);
    });
    return out;
}

// ------------------------------------------------------ small AST predicates

const calleeName = (call) => (ts.isIdentifier(call.expression) ? call.expression.text : null);
const unparen = (e) => { while (ts.isParenthesizedExpression(e)) e = e.expression; return e; };

function isAuthFetchCall(n) {
    return ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'authFetch';
}

function methodOf(init) {
    if (!init || !ts.isObjectLiteralExpression(init)) return { kind: init ? 'dynamic' : 'none' };
    for (const p of init.properties) {
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'method') {
            if (ts.isStringLiteralLike(p.initializer)) return { kind: 'literal', value: p.initializer.text.toUpperCase() };
            const cond = p.initializer;
            if (ts.isConditionalExpression(cond) && ts.isStringLiteralLike(cond.whenTrue) && ts.isStringLiteralLike(cond.whenFalse)) {
                const vals = [cond.whenTrue.text.toUpperCase(), cond.whenFalse.text.toUpperCase()];
                if (vals.every((v) => v !== 'GET')) return { kind: 'literal', value: vals[0] };
            }
            return { kind: 'dynamic' };
        }
        if (ts.isSpreadAssignment(p)) return { kind: 'dynamic' };
    }
    return { kind: 'none' };
}

/** `let cancelled = false` / `let alive = true` -> { name, init } */
function flagDecl(st) {
    if (!ts.isVariableStatement(st) || st.declarationList.declarations.length !== 1) return null;
    const d = st.declarationList.declarations[0];
    if (!ts.isIdentifier(d.name) || !d.initializer) return null;
    if (d.initializer.kind === K.FalseKeyword) return { name: d.name.text, init: false };
    if (d.initializer.kind === K.TrueKeyword) return { name: d.name.text, init: true };
    return null;
}

/** Flatten `a && b && c` / `a || b` into its operands. */
function operands(expr, op) {
    expr = unparen(expr);
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === op) return [...operands(expr.left, op), ...operands(expr.right, op)];
    return [expr];
}

const isNotOk = (e, res) => {
    e = unparen(e);
    return ts.isPrefixUnaryExpression(e) && e.operator === K.ExclamationToken && ts.isPropertyAccessExpression(unparen(e.operand)) &&
        unparen(e.operand).name.text === 'ok' && ts.isIdentifier(unparen(e.operand).expression) && unparen(e.operand).expression.text === res;
};
const isOk = (e, res) => {
    e = unparen(e);
    return ts.isPropertyAccessExpression(e) && e.name.text === 'ok' && ts.isIdentifier(e.expression) && e.expression.text === res;
};

/** 'live' when the test says "still mounted", 'dead' when it says "unmounted", else null. */
function flagTest(e, flags) {
    e = unparen(e);
    if (ts.isIdentifier(e) && flags.has(e.text)) return flags.get(e.text) ? 'live' : 'dead';
    if (ts.isPrefixUnaryExpression(e) && e.operator === K.ExclamationToken && ts.isIdentifier(unparen(e.operand)) && flags.has(unparen(e.operand).text)) return flags.get(unparen(e.operand).text) ? 'dead' : 'live';
    return null;
}

class Skip extends Error {
    constructor(reason, detail = '') { super(reason); this.reason = reason; this.detail = detail; }
}

// =============================================================== QUERY MODE

const GENERIC_DIRS = new Set(['components', 'pages', 'hooks', 'admin', 'tabs', 'dialogs', 'panel', 'panels', 'shared', 'sections', 'index', 'src', 'ui', 'common', 'utils']);
const GLOBAL_TYPES = new Set(['Record', 'Array', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Map', 'Set', 'Promise', 'Date', 'Exclude', 'Extract', 'NonNullable', 'ReturnType', 'Response', 'Error', 'unknown', 'never']);

const camel = (s) => s.replace(/[-_ ]+(.)/g, (_, c) => c.toUpperCase()).replace(/^(.)/, (c) => c.toLowerCase());
const pascal = (s) => camel(s).replace(/^(.)/, (c) => c.toUpperCase());

function srcRootOf(file) {
    let d = path.dirname(path.resolve(file));
    while (d !== path.dirname(d)) {
        if (path.basename(d) === 'src') return d;
        d = path.dirname(d);
    }
    return null;
}

function featureFor(file, srcRoot, queriesDir) {
    const rel = path.relative(srcRoot, path.dirname(file)).split(path.sep).filter(Boolean);
    const segs = rel.filter((s) => !GENERIC_DIRS.has(s.toLowerCase()));
    const existing = new Map();
    if (fs.existsSync(queriesDir)) {
        for (const f of fs.readdirSync(queriesDir)) {
            if (/\.ts$/.test(f) && !/\.test\./.test(f)) existing.set(f.replace(/\.ts$/, '').toLowerCase(), f.replace(/\.ts$/, ''));
        }
    }
    for (const s of [...segs].reverse()) {
        const k = camel(s).toLowerCase();
        for (const cand of [k, k.replace(/s$/, ''), k + 's']) if (existing.has(cand)) return existing.get(cand);
    }
    if (segs.length) return camel(segs[segs.length - 1]);
    const b = path.basename(file).replace(/\.[tj]sx?$/, '').replace(/^use(?=[A-Z])/, '');
    return camel(b);
}

function nameFromUrl(arg0, fallback) {
    let s = arg0 ? arg0.getText() : '';
    s = s.replace(/\$\{[^}]*\}/g, '/').split('?')[0];
    const words = (s.match(/[A-Za-z][A-Za-z0-9-]*/g) || []).filter((w) => w !== 'api');
    if (!words.length || !/^[`'"]/.test(s.trim())) return fallback;
    return camel(words.slice(-2).join('-'));
}

/** primitive-only type text of a parameter, or null */
function primitiveTypeText(checker, type) {
    const parts = type.isUnion() ? type.types : [type];
    const out = [];
    let hasTrue = false;
    let hasFalse = false;
    for (const t of parts) {
        const f = t.flags;
        if (f & ts.TypeFlags.EnumLiteral) return null;
        if (f & ts.TypeFlags.StringLiteral) out.push(JSON.stringify(t.value).replace(/"/g, "'"));
        else if (f & ts.TypeFlags.String) out.push('string');
        else if (f & ts.TypeFlags.NumberLiteral) out.push(String(t.value));
        else if (f & ts.TypeFlags.Number) out.push('number');
        else if (f & ts.TypeFlags.BooleanLiteral) { if (checker.typeToString(t) === 'true') hasTrue = true; else hasFalse = true; }
        else if (f & ts.TypeFlags.Boolean) out.push('boolean');
        else if (f & ts.TypeFlags.Null) out.push('null');
        else if (f & ts.TypeFlags.Undefined) out.push('undefined');
        else return null;
    }
    if (hasTrue && hasFalse) out.push('boolean');
    else if (hasTrue) out.push('true');
    else if (hasFalse) out.push('false');
    const uniq = [...new Set(out)];
    const rank = (x) => (x === 'null' ? 2 : x === 'undefined' ? 3 : 0);
    return uniq.sort((a, b) => rank(a) - rank(b)).join(' | ');
}

const isPureLiteral = (e) => {
    e = unparen(e);
    if (ts.isStringLiteralLike(e) || ts.isNumericLiteral(e) || [K.TrueKeyword, K.FalseKeyword, K.NullKeyword].includes(e.kind)) return true;
    if (ts.isIdentifier(e) && e.text === 'undefined') return true;
    if (ts.isPrefixUnaryExpression(e)) return isPureLiteral(e.operand);
    if (ts.isArrayLiteralExpression(e)) return e.elements.every(isPureLiteral);
    if (ts.isObjectLiteralExpression(e)) return e.properties.every((p) => ts.isPropertyAssignment(p) && !ts.isComputedPropertyName(p.name) && isPureLiteral(p.initializer));
    return false;
};
const isPrimitiveInit = (e) => {
    e = unparen(e);
    return !(ts.isArrayLiteralExpression(e) || ts.isObjectLiteralExpression(e));
};

/** Mutable per-run state: the hook files being built (several components may feed one). */
class HookFiles {
    constructor() { this.files = new Map(); }
    get(abs) {
        if (!this.files.has(abs)) {
            const exists = fs.existsSync(abs);
            this.files.set(abs, { text: exists ? fs.readFileSync(abs, 'utf8') : null, created: !exists, hooks: [] });
        }
        return this.files.get(abs);
    }
}

function createProgramFor(files) {
    let options = {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        jsx: ts.JsxEmit.ReactJSX, strict: true, noEmit: true, skipLibCheck: true, esModuleInterop: true, types: [],
        resolveJsonModule: true, allowJs: true, checkJs: false,
    };
    const cfgPath = ts.findConfigFile(path.dirname(files[0]), ts.sys.fileExists, 'tsconfig.json');
    if (cfgPath) {
        const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
        const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, path.dirname(cfgPath));
        options = { ...parsed.options, noEmit: true, skipLibCheck: true };
    }
    return ts.createProgram(files, options);
}

// ---- analysis of one useEffect ------------------------------------------------

function findStates(fn) {
    const states = new Map(); // setter name -> { value, setter, decl, init, typeNode }
    if (!fn.body || !ts.isBlock(fn.body)) return states;
    for (const st of fn.body.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
            if (!ts.isArrayBindingPattern(d.name) || !d.initializer) continue;
            const call = d.initializer;
            if (!ts.isCallExpression(call) || !['useState'].includes(calleeName(call) || (ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ''))) continue;
            const els = d.name.elements;
            const value = els[0] && !ts.isOmittedExpression(els[0]) && ts.isIdentifier(els[0].name) ? els[0].name.text : null;
            const setter = els[1] && !ts.isOmittedExpression(els[1]) && ts.isIdentifier(els[1].name) ? els[1].name.text : null;
            if (!setter) continue;
            states.set(setter, { value, setter, stmt: st, decl: d, init: call.arguments[0], typeNode: call.typeArguments && call.typeArguments[0], multi: st.declarationList.declarations.length > 1 });
        }
    }
    return states;
}

function effectCalls(fn) {
    const out = [];
    if (!fn.body || !ts.isBlock(fn.body)) return out;
    for (const st of fn.body.statements) {
        if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) continue;
        const c = st.expression;
        const nm = calleeName(c) || (ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : null);
        if (nm === 'useEffect') out.push(st);
    }
    return out;
}

/**
 * Parse one effect into a plan or throw Skip.
 * plan: { guard, fetch, queryStmts[], keptNodes[], okClause, catchClause, dataSetter, dataExpr,
 *         loadingSetter, errorSetter, flags }
 */
function parseEffect(ctx, effectStmt) {
    const { sf } = ctx;
    const call = effectStmt.expression;
    const cb = call.arguments[0];
    if (!cb || !(ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) || !ts.isBlock(cb.body)) throw new Skip('effect callback is not a block function');
    const deps = call.arguments[1];
    if (!deps || !ts.isArrayLiteralExpression(deps)) throw new Skip('effect has no dependency array');
    const depNames = [];
    for (const d of deps.elements) {
        if (!ts.isIdentifier(d)) throw new Skip('dependency the key cannot express', d.getText(sf));
        depNames.push(d.text);
    }
    const authCalls = [];
    walk(cb, (n) => { if (isAuthFetchCall(n)) authCalls.push(n); });
    if (authCalls.length === 0) throw new Skip('no authFetch in effect');
    if (authCalls.length > 1) throw new Skip('several requests in one effect');

    const plan = {
        guard: [], flags: new Map(), flagInit: new Map(), cleanupFlags: new Set(), resets: [], okClause: { kind: 'none' }, catchClause: null, finallyLoading: null,
        keptNodes: [], keptTexts: [], dataSetter: null, dataExpr: null, dataExprNode: null, depNames,
        setters: new Set(), resVar: null, fetchArgsNodes: null, jsonCond: null, effectStmt,
    };

    let stmts = [...cb.body.statements];

    // trailing cleanup `return () => { flag = true; }`
    const last = stmts[stmts.length - 1];
    if (last && ts.isReturnStatement(last) && last.expression) {
        const fnx = unparen(last.expression);
        if ((ts.isArrowFunction(fnx) || ts.isFunctionExpression(fnx)) && ts.isBlock(fnx.body) && fnx.body.statements.length && fnx.body.statements.every((s) =>
            ts.isExpressionStatement(s) && ts.isBinaryExpression(s.expression) && s.expression.operatorToken.kind === K.EqualsToken && ts.isIdentifier(s.expression.left) && (s.expression.right.kind === K.TrueKeyword || s.expression.right.kind === K.FalseKeyword))) {
            for (const s of fnx.body.statements) plan.cleanupFlags.add(s.expression.left.text);
            stmts.pop();
        } else throw new Skip('cleanup does more than set a flag');
    }

    const consumeLeading = (list) => {
        const rest = [];
        let seenWork = false;
        for (const st of list) {
            const fd = !seenWork && flagDecl(st);
            if (fd) { plan.flagInit.set(fd.name, fd.init); plan.flags = new Map([...plan.flagInit].filter(([n]) => plan.cleanupFlags.has(n))); continue; }
            if (!seenWork && ts.isIfStatement(st) && !st.elseStatement && isBareReturn(st.thenStatement)) { plan.guard.push(st.expression); continue; }
            if (!seenWork && ts.isExpressionStatement(st) && ts.isCallExpression(st.expression) && ctx.states.has(calleeName(st.expression)) && st.expression.arguments.length === 1) {
                const a = st.expression.arguments[0];
                if (a.kind === K.TrueKeyword || a.kind === K.FalseKeyword || a.kind === K.NullKeyword) { plan.resets.push({ setter: calleeName(st.expression), value: a.kind }); continue; }
            }
            seenWork = true;
            rest.push(st);
        }
        return rest;
    };
    stmts = consumeLeading(stmts);
    if (!stmts.length) throw new Skip('effect has no request');

    // locate the unit of work
    let inner = null; // statements of the async body
    let chain = null;
    if (stmts.length === 1 && ts.isExpressionStatement(stmts[0])) {
        const ex = unparen(stmts[0].expression);
        if (ts.isCallExpression(ex) && ex.arguments.length === 0 && (ts.isArrowFunction(unparen(ex.expression)) || ts.isFunctionExpression(unparen(ex.expression))) && ts.isBlock(unparen(ex.expression).body)) {
            inner = [...unparen(ex.expression).body.statements];
        } else if (ts.isCallExpression(ex) && ts.isPropertyAccessExpression(ex.expression)) {
            chain = ex;
        } else if (ts.isCallExpression(ex) && ts.isIdentifier(ex.expression)) {
            throw new Skip('request hidden in a named loader');
        } else throw new Skip('unrecognised effect body');
    } else if (stmts.length === 2 && ts.isVariableStatement(stmts[0]) && ts.isExpressionStatement(stmts[1])) {
        const d = stmts[0].declarationList.declarations[0];
        const ex = stmts[1].expression;
        if (d && ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer)) && ts.isBlock(d.initializer.body) && ts.isCallExpression(ex) && ts.isIdentifier(ex.expression) && ex.expression.text === d.name.text && ex.arguments.length === 0) {
            inner = [...d.initializer.body.statements];
        } else throw new Skip('unrecognised effect body');
    } else throw new Skip('unrecognised effect body');

    if (inner) {
        inner = consumeLeading(inner);
        parseAsyncBody(ctx, plan, inner);
    } else {
        parseChain(ctx, plan, chain);
    }

    plan.authCall = authCalls[0];
    return plan;
}

const isBareReturn = (s) => {
    if (ts.isReturnStatement(s)) return !s.expression || (ts.isIdentifier(s.expression) && s.expression.text === 'undefined');
    if (ts.isBlock(s)) return s.statements.length === 1 && isBareReturn(s.statements[0]);
    return false;
};

/** `if (alive) stmt` / `if (!cancelled) { stmt }` -> the inner statement list, else the statement itself. */
function unwrapFlagIf(st, plan) {
    if (ts.isIfStatement(st) && !st.elseStatement) {
        const parts = operands(st.expression, K.AmpersandAmpersandToken);
        const rest = parts.filter((p) => flagTest(p, plan.flags) !== 'live');
        if (rest.length < parts.length) return { stmts: ts.isBlock(st.thenStatement) ? [...st.thenStatement.statements] : [st.thenStatement], cond: rest.length ? rest : null };
    }
    return { stmts: [st], cond: null };
}

/** `setX(e)` possibly under `if (cond)` wrappers -> { call, conds } (flag tests dropped). */
function extractSetter(st, plan, ctx) {
    const conds = [];
    let cur = st;
    for (;;) {
        const c = setterCall(cur, ctx);
        if (c) return { call: c, conds };
        if (ts.isIfStatement(cur) && !cur.elseStatement) {
            for (const p of operands(cur.expression, K.AmpersandAmpersandToken)) if (flagTest(p, plan.flags) !== 'live') conds.push(p);
            const t = ts.isBlock(cur.thenStatement) ? (cur.thenStatement.statements.length === 1 ? cur.thenStatement.statements[0] : null) : cur.thenStatement;
            if (!t) return null;
            cur = t;
            continue;
        }
        if (ts.isBlock(cur) && cur.statements.length === 1) { cur = cur.statements[0]; continue; }
        return null;
    }
}

function setterCall(st, ctx) {
    if (!ts.isExpressionStatement(st)) return null;
    const c = unparen(st.expression);
    if (!ts.isCallExpression(c) || !ts.isIdentifier(c.expression) || !ctx.states.has(c.expression.text) || c.arguments.length !== 1) return null;
    return c;
}

const isLogCall = (st) => {
    if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) return false;
    let e = st.expression.expression;
    while (ts.isPropertyAccessExpression(e)) e = e.expression;
    return ts.isIdentifier(e) && (e.text === 'logger' || e.text === 'console');
};

function parseAsyncBody(ctx, plan, list) {
    // an optional try/catch/finally around the work
    let work = list;
    let tryStmt = null;
    if (list.length === 1 && ts.isTryStatement(list[0])) {
        tryStmt = list[0];
        work = [...tryStmt.tryBlock.statements];
        if (tryStmt.catchClause) parseCatch(ctx, plan, tryStmt.catchClause);
        if (tryStmt.finallyBlock) parseFinally(ctx, plan, tryStmt.finallyBlock);
    } else if (list.some((s) => ts.isTryStatement(s))) throw new Skip('several statements around try');
    work = consumeInnerResets(ctx, plan, work);
    parseWork(ctx, plan, work);
}

function consumeInnerResets(ctx, plan, list) {
    const rest = [];
    let seen = false;
    for (const st of list) {
        const c = !seen ? setterCall(st, ctx) : null;
        if (c && [K.TrueKeyword, K.FalseKeyword, K.NullKeyword].includes(c.arguments[0].kind)) { plan.resets.push({ setter: c.expression.text, value: c.arguments[0].kind }); continue; }
        seen = true;
        rest.push(st);
    }
    return rest;
}

function parseCatch(ctx, plan, cc) {
    const binder = cc.variableDeclaration && ts.isIdentifier(cc.variableDeclaration.name) ? cc.variableDeclaration.name.text : null;
    let expr = null;
    for (const st0 of cc.block.statements) {
        const { stmts, cond } = unwrapFlagIf(st0, plan);
        if (cond) throw new Skip('catch branch has a condition');
        for (const st of stmts) {
            const c = setterCall(st, ctx);
            if (c) {
                if (expr) throw new Skip('catch sets state twice');
                expr = { setter: c.expression.text, node: c.arguments[0] };
            } else if (isLogCall(st)) continue;
            else throw new Skip('catch branch does more than set the error', st.getText(ctx.sf).slice(0, 40));
        }
    }
    plan.catchClause = { binder, expr };
}

function parseFinally(ctx, plan, block) {
    for (const st0 of block.statements) {
        const { stmts, cond } = unwrapFlagIf(st0, plan);
        if (cond) throw new Skip('finally has a condition');
        for (const st of stmts) {
            const c = setterCall(st, ctx);
            if (c && c.arguments[0].kind === K.FalseKeyword) plan.finallyLoading = c.expression.text;
            else throw new Skip('finally does more than clear loading');
        }
    }
}

function parseOkBlock(ctx, plan, thenStmt, res) {
    const items = ts.isBlock(thenStmt) ? [...thenStmt.statements] : [thenStmt];
    const clause = { kind: 'silent', expr: null, throwStmt: null, resUses: false };
    for (const it0 of items) {
        const { stmts, cond } = unwrapFlagIf(it0, plan);
        if (cond) throw new Skip('non-ok branch has a condition');
        for (const it of stmts) {
            if (ts.isReturnStatement(it) && !it.expression) continue;
            if (ts.isThrowStatement(it)) { clause.kind = 'throw'; clause.throwStmt = it; continue; }
            const c = setterCall(it, ctx);
            if (c) { clause.kind = clause.kind === 'throw' ? 'throw' : 'set'; clause.expr = { setter: c.expression.text, node: c.arguments[0] }; continue; }
            if (isLogCall(it)) continue;
            throw new Skip('non-ok branch does more than set the error', it.getText(ctx.sf).slice(0, 40));
        }
    }
    return clause;
}

function parseWork(ctx, plan, work) {
    const { sf } = ctx;
    if (!work.length) throw new Skip('no request in effect');
    const first = work[0];
    // `const res = await authFetch(...)`
    let resVar = null;
    let fetchCall = null;
    if (ts.isVariableStatement(first)) {
        const d = first.declarationList.declarations[0];
        const init = d && d.initializer && unparen(d.initializer);
        if (init && ts.isAwaitExpression(init) && isAuthFetchCall(unparen(init.expression)) && ts.isIdentifier(d.name)) {
            resVar = d.name.text;
            fetchCall = unparen(init.expression);
        }
    }
    if (!fetchCall) throw new Skip('request is not the first statement of the effect work');
    plan.resVar = resVar;
    plan.fetchArgsNodes = [...fetchCall.arguments];
    const m = methodOf(fetchCall.arguments[1]);
    if (m.kind === 'dynamic') throw new Skip('request method is not a literal');
    if (m.kind === 'literal' && m.value !== 'GET') throw new Skip('not a GET request');

    const keep = [];
    const dataItems = [];
    const process = (list) => {
        for (let i = 0; i < list.length; i++) {
            const st = list[i];
            if (dataItems.length && !extractSetter(st, plan, ctx)) throw new Skip('statements after the data is set');
            // early exits
            if (ts.isIfStatement(st) && !st.elseStatement && isBareReturn(st.thenStatement)) {
                const parts = operands(st.expression, K.BarBarToken);
                let sawOk = false;
                for (const p of parts) {
                    if (flagTest(p, plan.flags) === 'dead') continue;
                    if (isNotOk(p, resVar)) { sawOk = true; continue; }
                    const pp = unparen(p);
                    if (ts.isPrefixUnaryExpression(pp) && pp.operator === K.ExclamationToken && ts.isIdentifier(unparen(pp.operand)) && unparen(pp.operand).text === resVar) continue;
                    throw new Skip('early return on a condition');
                }
                if (sawOk) plan.okClause = { kind: 'silent', expr: null };
                continue;
            }
            if (ts.isIfStatement(st) && !st.elseStatement && isNotOk(st.expression, resVar)) {
                plan.okClause = parseOkBlock(ctx, plan, st.thenStatement, resVar);
                if (plan.okClause.kind === 'throw') keep.push(st);
                continue;
            }
            if (ts.isIfStatement(st) && isOk(st.expression, resVar)) {
                if (st.elseStatement) throw new Skip('ok/else branch');
                if (i !== list.length - 1) throw new Skip('statements after the ok branch');
                plan.okClause = { kind: 'silent', expr: null };
                process(ts.isBlock(st.thenStatement) ? [...st.thenStatement.statements] : [st.thenStatement]);
                continue;
            }
            if (ts.isVariableStatement(st)) {
                keep.push(st);
                continue;
            }
            // data setter: `setX(e)`, `if (cond) setX(e)`
            const ex = extractSetter(st, plan, ctx);
            if (!ex) throw new Skip('unrecognised statement', st.getText(sf).slice(0, 40));
            dataItems.push({ setter: ex.call.expression.text, exprNode: ex.call.arguments[0], conds: ex.conds });
        }
    };
    process(work.slice(1));
    if (!dataItems.length) throw new Skip('no setData(json) in the effect');
    if (dataItems.length > 1 && dataItems.some((d) => d.conds.length)) throw new Skip('conditional setters from one response');
    plan.dataItems = dataItems;
    plan.dataSetter = dataItems[0].setter;
    plan.dataExprNode = dataItems[0].exprNode;
    plan.jsonCond = dataItems[0].conds.length ? dataItems[0].conds : null;
    plan.keptNodes = keep;
}

function parseChain(ctx, plan, expr) {
    // authFetch(args).then(r => json).then(d => setX(e)).catch(c).finally(f)
    const calls = [];
    let cur = expr;
    while (ts.isCallExpression(cur) && ts.isPropertyAccessExpression(cur.expression)) {
        calls.unshift({ name: cur.expression.name.text, call: cur });
        cur = cur.expression.expression;
    }
    if (!isAuthFetchCall(cur)) throw new Skip('chain does not start at authFetch');
    plan.fetchArgsNodes = [...cur.arguments];
    const m = methodOf(cur.arguments[1]);
    if (m.kind === 'dynamic') throw new Skip('request method is not a literal');
    if (m.kind === 'literal' && m.value !== 'GET') throw new Skip('not a GET request');
    const thens = calls.filter((c) => c.name === 'then');
    const catches = calls.filter((c) => c.name === 'catch');
    const fins = calls.filter((c) => c.name === 'finally');
    if (thens.length !== 2 || catches.length > 1 || fins.length > 1 || thens.length + catches.length + fins.length !== calls.length) throw new Skip('chain has an unrecognised shape');
    const fn1 = thens[0].call.arguments[0];
    if (!fn1 || !(ts.isArrowFunction(fn1)) || fn1.parameters.length !== 1 || !ts.isIdentifier(fn1.parameters[0].name) || ts.isBlock(fn1.body)) throw new Skip('first .then is not a one-line arrow');
    const r = fn1.parameters[0].name.text;
    plan.resVar = r;
    const body = unparen(fn1.body);
    const isJson = (e) => { e = unparen(e); return ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'json' && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === r && e.arguments.length === 0; };
    if (isJson(body)) {
        plan.chainJson = `await ${r}.json()`;
    } else if (ts.isConditionalExpression(body) && isOk(body.condition, r) && isJson(body.whenTrue)) {
        plan.chainJson = `${r}.ok ? await ${r}.json() : ${body.whenFalse.getText(ctx.sf)}`;
        plan.chainJsonNode = body.whenFalse;
    } else throw new Skip('first .then is not res.json()');
    const fn2 = thens[1].call.arguments[0];
    if (fn2 && ts.isIdentifier(fn2) && ctx.states.has(fn2.text)) {
        plan.dataSetter = fn2.text;
        plan.chainParam = 'data';
        plan.dataExprNode = null;
        plan.dataExprText = 'data';
    } else if (fn2 && ts.isArrowFunction(fn2) && fn2.parameters.length === 1 && ts.isIdentifier(fn2.parameters[0].name)) {
        plan.chainParam = fn2.parameters[0].name.text;
        plan.chainParamType = fn2.parameters[0].type;
        let b = fn2.body;
        if (ts.isBlock(b)) {
            if (b.statements.length !== 1) throw new Skip('second .then does more than set the data');
            const s = b.statements[0];
            if (!ts.isExpressionStatement(s)) throw new Skip('second .then does more than set the data');
            b = s.expression;
        }
        b = unparen(b);
        if (!ts.isCallExpression(b) || !ts.isIdentifier(b.expression) || !ctx.states.has(b.expression.text) || b.arguments.length !== 1) throw new Skip('second .then does not call a setter once');
        plan.dataSetter = b.expression.text;
        plan.dataExprNode = b.arguments[0];
    } else throw new Skip('second .then is not setData(json)');
    plan.dataItems = [{ setter: plan.dataSetter, exprNode: plan.dataExprNode, conds: [] }];
    plan.chain = true;
    plan.keptNodes = [];
    if (catches.length) {
        const cf = catches[0].call.arguments[0];
        if (!cf || !(ts.isArrowFunction(cf) || ts.isFunctionExpression(cf))) throw new Skip('catch is not a function');
        const binder = cf.parameters[0] && ts.isIdentifier(cf.parameters[0].name) ? cf.parameters[0].name.text : null;
        let items;
        if (ts.isBlock(cf.body)) items = [...cf.body.statements];
        else items = [ts.factory.createExpressionStatement(cf.body)];
        let expr2 = null;
        for (const it of ts.isBlock(cf.body) ? cf.body.statements : [cf.body]) {
            const e = ts.isExpressionStatement(it) ? unparen(it.expression) : unparen(it);
            if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && ctx.states.has(e.expression.text) && e.arguments.length === 1) { expr2 = { setter: e.expression.text, node: e.arguments[0] }; continue; }
            let root = ts.isCallExpression(e) ? e.expression : e;
            while (ts.isPropertyAccessExpression(root)) root = root.expression;
            if (ts.isIdentifier(root) && (root.text === 'logger' || root.text === 'console')) continue;
            if (ts.isBlock(cf.body) && ts.isBlock(e)) continue;
            // `() => false` style fallbacks are not state
            throw new Skip('catch does more than set the error');
        }
        void items;
        plan.catchClause = { binder, expr: expr2 };
    }
    if (fins.length) {
        const ff = fins[0].call.arguments[0];
        if (!ff || !(ts.isArrowFunction(ff) || ts.isFunctionExpression(ff))) throw new Skip('finally is not a function');
        const b = ts.isBlock(ff.body) ? (ff.body.statements.length === 1 && ts.isExpressionStatement(ff.body.statements[0]) ? ff.body.statements[0].expression : null) : ff.body;
        const c = b && unparen(b);
        if (c && ts.isCallExpression(c) && ts.isIdentifier(c.expression) && ctx.states.has(c.expression.text) && c.arguments.length === 1 && c.arguments[0].kind === K.FalseKeyword) plan.finallyLoading = c.expression.text;
        else throw new Skip('finally does more than clear loading');
    }
}

// ---- turning a plan into a hook + the component edit ---------------------------

function queryOne(ctx, effectStmt) {
    const { sf, text, file } = ctx;
    const plan = parseEffect(ctx, effectStmt);
    const effectRange = [effectStmt.getStart(sf), effectStmt.getEnd()];
    const inEffect = (n) => n.getStart(sf) >= effectRange[0] && n.getEnd() <= effectRange[1];

    // roles of the setters
    const dataStates = plan.dataItems.map((d) => ctx.states.get(d.setter));
    if (dataStates.some((d) => !d)) throw new Skip('data setter is not a useState');
    if (dataStates.some((d) => !d.value)) throw new Skip('data value unused');
    const dataState = dataStates[0];
    const dataSetters = plan.dataItems.map((d) => d.setter);
    let loadingSetter = plan.finallyLoading || null;
    let errorSetter = null;
    for (const r of plan.resets) {
        if (r.value === K.NullKeyword) errorSetter = errorSetter || r.setter;
        else if (r.value === K.TrueKeyword) loadingSetter = loadingSetter || r.setter;
        else throw new Skip('state reset to false at the start');
    }
    const clauseSetters = [plan.catchClause && plan.catchClause.expr && plan.catchClause.expr.setter, plan.okClause && plan.okClause.expr && plan.okClause.expr.setter].filter(Boolean);
    for (const s of clauseSetters) { if (errorSetter && errorSetter !== s) throw new Skip('two different error setters'); errorSetter = s; }
    if (errorSetter && loadingSetter && errorSetter === loadingSetter) throw new Skip('one setter plays two roles');
    if (new Set([...dataSetters, loadingSetter, errorSetter].filter(Boolean)).size !== [...dataSetters, loadingSetter, errorSetter].filter(Boolean).length) throw new Skip('one setter plays two roles');
    // every setter called in the effect is one of the three
    const usedSetters = new Set();
    walk(effectStmt, (n) => { if (ts.isIdentifier(n) && ctx.states.has(n.text) && !isDeclarationName(n)) usedSetters.add(n.text); });
    const depSetters = new Set(plan.depNames.filter((d) => ctx.states.has(d)));
    for (const s of usedSetters) {
        if (![...dataSetters, loadingSetter, errorSetter].includes(s)) throw new Skip('effect sets more than data/loading/error', s);
    }
    const roleStates = { data: dataState, loading: loadingSetter && ctx.states.get(loadingSetter), error: errorSetter && ctx.states.get(errorSetter) };
    const allStates = [...dataStates, roleStates.loading, roleStates.error].filter(Boolean);
    void depSetters;
    for (const st of allStates) {
        const role = dataStates.includes(st) ? 'data' : st === roleStates.loading ? 'loading' : 'error';
        if (!st) continue;
        if (st.multi) throw new Skip('state declared in a shared declaration list');
        if (role !== 'data' && !st.value) throw new Skip(`${role} value unused`);
        // setter used outside the effect?
        const outside = refsOf(ctx.fn.body, st.setter, (n) => !inEffect(n) && !hasAncestor(n, (p) => p === st.decl));
        if (outside.length) throw new Skip('setter used outside the effect', st.setter);
        // value read before the effect (hook position)?
        if (st.value) {
            const early = refsOf(ctx.fn.body, st.value, (n) => n.getStart(sf) < effectRange[0] && !hasAncestor(n, (p) => p === st.decl));
            if (early.length) throw new Skip('state read before the effect', st.value);
        }
    }
    if (roleStates.error && !clauseSetters.length) throw new Skip('error state never set');
    if (plan.keptNodes.some((n) => { let bad = false; walk(n, (x) => { if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && ctx.states.has(x.expression.text)) bad = true; }); return bad; })) throw new Skip('state set inside a helper statement');

    // data types: one per setter
    const dataInfos = dataStates.map((st) => {
        if (!st.typeNode) throw new Skip('useState has no explicit type');
        const tNode = st.typeNode;
        const typeText = tNode.getText(sf);
        const initNode = st.init ? unparen(st.init) : null;
        let hookType = typeText;
        if (ts.isUnionTypeNode(tNode)) {
            const nonNull = tNode.types.filter((t) => !(t.kind === K.LiteralType && t.literal.kind === K.NullKeyword));
            if (nonNull.length !== tNode.types.length) hookType = nonNull.map((t) => t.getText(sf)).join(' | ');
        }
        if (initNode && !isPureLiteral(initNode)) throw new Skip('initial value is not a literal');
        return { st, tNode, typeText, initNode, hookType };
    });
    const hookType = dataInfos.length === 1 ? dataInfos[0].hookType : `{ ${dataInfos.map((d) => `${d.st.value}: ${d.hookType}`).join('; ')} }`;

    // the code that moves into the hook
    const resName = plan.resVar;
    const argsText = plan.fetchArgsNodes.map((a) => a.getText(sf)).join(', ');
    const keepNodes = [...plan.fetchArgsNodes, ...plan.keptNodes];
    for (const d of plan.dataItems) if (d.exprNode) keepNodes.push(d.exprNode);
    if (plan.jsonCond) keepNodes.push(...plan.jsonCond);
    if (plan.chainJsonNode) keepNodes.push(plan.chainJsonNode);
    // remaining free variables
    const kept = freeNames(keepNodes);
    if (plan.chain) {
        kept.delete(plan.chainParam);
        kept.delete(resName);
    } else {
        kept.delete(resName);
    }
    for (const n of plan.jsonCond || []) void n;
    for (const g of plan.guard) for (const n of freeNames([g])) kept.add(n);
    const typeFree = freeNames(dataInfos.map((d) => d.tNode));
    const srcRoot0 = ctx.srcRoot;
    const importNeeds = new Map(); // module -> {names, typeOnly}
    const addNeed = (name, typeOnly) => {
        const imp = ctx.imports.get(name);
        if (imp.module.startsWith('.')) {
            const target = path.resolve(path.dirname(file), imp.module);
            const relToSrc = path.relative(srcRoot0, target).split(path.sep);
            if (relToSrc[0] === 'components' || relToSrc[0] === 'pages') throw new Skip('needs an import from components/ or pages/ (api/ may not)', name);
        }
        const key = `${imp.module}\0${typeOnly || imp.typeOnly}`;
        if (!importNeeds.has(key)) importNeeds.set(key, { module: imp.module, typeOnly: typeOnly || imp.typeOnly, specs: [] });
        importNeeds.get(key).specs.push(imp.imported === name ? name : `${imp.imported} as ${name}`);
    };
    const params = [];
    const helperNames = new Set(['authFetch', 'API_BASE']);
    const jsonVar = plan.chain ? plan.chainParam : null;
    void jsonVar;
    for (const n of kept) {
        if (helperNames.has(n)) continue;
        if (ctx.imports.has(n)) { addNeed(n, false); continue; }
        if (ctx.topNames.has(n)) throw new Skip('request code uses a file-local binding', n);
        if (ctx.compScope.has(n)) { params.push(n); continue; }
    }
    for (const n of typeFree) {
        if (GLOBAL_TYPES.has(n)) continue;
        if (ctx.imports.has(n)) { addNeed(n, true); continue; }
        if (ctx.topNames.has(n)) throw new Skip('data type declared in the component file', n);
        if (ctx.compScope.has(n)) throw new Skip('data type uses a component binding', n);
    }
    // the dependency list must be exactly what the key carries
    const paramSet = new Set(params);
    for (const p of params) if (!plan.depNames.includes(p)) throw new Skip('request uses a value that is not a dependency', p);
    const extraDeps = plan.depNames.filter((d) => !paramSet.has(d) && !ctx.states.has(d) && d !== 't');
    if (extraDeps.length) throw new Skip('dependency the key cannot express', extraDeps.join(', '));

    // parameter types (checker)
    const paramInfo = [];
    for (const p of params) {
        const useSite = (() => {
            let found = null;
            for (const n of keepNodes) walk(n, (x) => { if (!found && ts.isIdentifier(x) && x.text === p && !isDeclarationName(x)) found = x; });
            return found;
        })();
        const declSite = (() => {
            let found = null;
            for (const g of plan.guard) walk(g, (x) => { if (!found && ts.isIdentifier(x) && x.text === p) found = x; });
            return found || useSite;
        })();
        const sym = ctx.checker.getSymbolAtLocation(declSite || useSite);
        const decl = sym && sym.valueDeclaration;
        if (!sym || !decl) throw new Skip('cannot resolve a request value', p);
        const declared = primitiveTypeText(ctx.checker, ctx.checker.getTypeOfSymbolAtLocation(sym, decl)); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a repo script that reads local source files; its regexes are anchored or single-class, linear
        if (!declared) throw new Skip('request value is not a primitive', p);
        const narrowed = useSite ? primitiveTypeText(ctx.checker, ctx.checker.getTypeAtLocation(useSite)) : declared; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a repo script that reads local source files; its regexes are anchored or single-class, linear
        const needsCheck = /\bnull\b|\bundefined\b/.test(declared) && narrowed && !/\bnull\b|\bundefined\b/.test(narrowed);
        paramInfo.push({ name: p, type: declared, needsCheck });
    }

    // error clauses
    const clauses = [];
    const rebind = (node, from, to, resStatus) => {
        // textual rebind of identifier `from` -> `to` inside node
        const base = node.getStart(sf);
        const edits = [];
        walk(node, (n) => {
            if (ts.isIdentifier(n) && n.text === from && !isDeclarationName(n)) {
                if (resStatus && ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && n.parent.name.text === 'status') {
                    edits.push({ start: n.getStart(sf) - base, end: n.parent.getEnd() - base, text: `${to}.status` });
                } else if (resStatus) throw new Skip('non-ok branch reads the Response');
                else edits.push({ start: n.getStart(sf) - base, end: n.getEnd() - base, text: to });
            }
        });
        return applyEdits(node.getText(sf), edits);
    };
    const hasOkSilent = plan.okClause.kind === 'silent' || plan.okClause.kind === 'set';
    let okText = null;
    if (plan.okClause.kind === 'set') okText = rebind(plan.okClause.expr.node, resName, 'queryError', true);
    let catchText = null;
    if (plan.catchClause && plan.catchClause.expr) {
        catchText = plan.catchClause.binder ? rebind(plan.catchClause.expr.node, plan.catchClause.binder, 'queryError', false) : plan.catchClause.expr.node.getText(sf);
        if (plan.catchClause.binder === resName) throw new Skip('catch binder clashes');
    }
    let errorExpr = null;
    let needApiError = false;
    if (roleStates.error) {
        if (okText && catchText) { errorExpr = `(queryError instanceof ApiError ? ${okText} : ${catchText})`; needApiError = true; }
        else if (okText) errorExpr = okText;
        else if (catchText) {
            if (hasOkSilent) { errorExpr = `(queryError instanceof ApiError ? null : ${catchText})`; needApiError = true; }
            else errorExpr = catchText;
        }
    }
    void clauses;

    // ---- hook source
    if (ctx.compScope.has(`${dataState.value}Query`) || ctx.taken.has(`${dataState.value}Query`)) throw new Skip('name clash', `${dataState.value}Query`);
    if (errorExpr && /queryError/.test(errorExpr) && (ctx.compScope.has('queryError') || ctx.taken.has('queryError'))) throw new Skip('name clash', 'queryError');
    const srcRoot = ctx.srcRoot;
    const queriesDir = path.join(srcRoot, 'api', 'queries');
    const feature = featureFor(file, srcRoot, queriesDir);
    const hookAbs = path.join(queriesDir, `${feature}.ts`);
    const hf = ctx.hookFiles.get(hookAbs);
    const compName = ctx.compName || path.basename(file).replace(/\.[tj]sx?$/, '');
    const baseName = nameFromUrl(plan.fetchArgsNodes[0], camel(compName));
    const existingText = hf.text || '';
    let base = baseName;
    let hookName = `use${pascal(base)}`;
    let n = 1;
    while (new RegExp(`\\b${hookName}\\b`).test(existingText) || hf.hooks.some((h) => h.hookName === hookName)) {
        n += 1;
        base = n === 2 ? `${baseName}${pascal(compName)}` : `${baseName}${pascal(compName)}${n}`;
        hookName = `use${pascal(base)}`;
    }
    const keysName = `${feature}Keys`;
    const keyParamsDecl = paramInfo.map((p) => `${p.name}: ${p.type}`).join(', ');
    const keyArr = [`'${feature}'`, `'${base}'`, ...paramInfo.map((p) => p.name)].join(', ');
    const keyProp = paramInfo.length ? `${base}: (${keyParamsDecl}) => [${keyArr}] as const,` : `${base}: [${keyArr}] as const,`;
    const keyRef = paramInfo.length ? `${keysName}.${base}(${paramInfo.map((p) => p.name).join(', ')})` : `${keysName}.${base}`;

    // queryFn body
    const ind = '            ';
    const body = [];
    for (const p of paramInfo) if (p.needsCheck) body.push(`if (${p.name} == null) throw new Error('${hookName}: ${p.name} is required');`);
    const resolved = (nodeOrText) => (typeof nodeOrText === 'string' ? nodeOrText : nodeOrText.getText(sf));
    if (plan.chain) {
        body.push(`const ${resName} = await authFetch(${argsText});`);
        if (hasOkSilent) body.push(`if (!${resName}.ok) throw new ApiError(\`HTTP \${${resName}.status}\`, { status: ${resName}.status });`);
        body.push(`const ${plan.chainParam} = ${plan.chainJson};`);
        body.push(`return ${plan.dataExprNode ? resolved(plan.dataExprNode) : plan.dataExprText};`);
    } else {
        body.push(`const ${resName} = await authFetch(${argsText});`);
        if (plan.okClause.kind === 'silent' || plan.okClause.kind === 'set') body.push(`if (!${resName}.ok) throw new ApiError(\`HTTP \${${resName}.status}\`, { status: ${resName}.status });`);
        for (const k of plan.keptNodes) body.push(k.getText(sf).replace(/\n/g, '\n' + '    '.repeat(0)));
        if (plan.jsonCond) {
            const cond = plan.jsonCond.map((c) => c.getText(sf)).join(' && ');
            body.push(`if (!(${cond})) throw new Error('${hookName}: unexpected response');`);
        }
        if (plan.dataItems.length === 1) body.push(`return ${plan.dataExprNode.getText(sf)};`);
        else body.push(`return { ${plan.dataItems.map((d, i) => { const k = dataStates[i].value; const e = d.exprNode.getText(sf); return e === k ? k : `${k}: ${e}`; }).join(', ')} };`);
    }
    if (plan.okClause.kind === 'silent' || plan.okClause.kind === 'set' || (plan.chain && hasOkSilent)) needApiError = needApiError || false;
    const usesApiErrorInHook = body.some((l) => l.includes('ApiError'));

    // enabled
    let enabledLine = '';
    if (plan.guard.length) {
        const conds = plan.guard.map((g) => g.getText(sf));
        const guardText = conds.length === 1 ? conds[0] : conds.map((c) => `(${c})`).join(' || ');
        const gu = unparen(plan.guard.length === 1 ? plan.guard[0] : plan.guard[0]);
        let en;
        const flip = { [K.ExclamationEqualsEqualsToken]: '===', [K.ExclamationEqualsToken]: '==', [K.EqualsEqualsEqualsToken]: '!==', [K.EqualsEqualsToken]: '!=' };
        if (plan.guard.length === 1 && ts.isPrefixUnaryExpression(gu) && gu.operator === K.ExclamationToken) en = `!!${gu.operand.getText(sf)}`;
        else if (plan.guard.length === 1 && ts.isBinaryExpression(gu) && flip[gu.operatorToken.kind]) en = `${gu.left.getText(sf)} ${flip[gu.operatorToken.kind]} ${gu.right.getText(sf)}`;
        else en = `!(${guardText})`;
        enabledLine = `${ind.slice(4)}enabled: ${en},\n`;
    }
    const queryFnBody = body.map((l) => ind + l).join('\n');
    const hookSrc =
`export function ${hookName}(${keyParamsDecl}) {
    return useQuery<${hookType}, Error>({
        queryKey: ${keyRef},
${enabledLine}        queryFn: async () => {
${queryFnBody}
        },
        staleTime: 0,
        retry: false,
    });
}
`;

    // ---- assemble the hook file edit
    let hookText = hf.text;
    if (hookText === null) {
        hookText = `// Reads for ${feature}, moved out of components by scripts/rq-codemod.mjs.\n// authFetch stays inside queryFn on purpose: the screens' tests mock authFetch.\n\nimport { useQuery } from '@tanstack/react-query';\n`;
    }
    {
        const hsf = parse(hookAbs, hookText);
        const edits = [];
        const needs = new Map();
        const need = (mod, names, typeOnly) => {
            const key = `${mod}\0${typeOnly}`;
            if (!needs.has(key)) needs.set(key, { mod, typeOnly, names: new Set() });
            for (const nme of names) needs.get(key).names.add(nme);
        };
        need('@tanstack/react-query', ['useQuery'], false);
        need(relModule(hookAbs, path.join(srcRoot, 'utils', 'helpers')), ['authFetch', 'API_BASE'].filter((x) => queryFnBody.includes(x)), false);
        if (usesApiErrorInHook) need(relModule(hookAbs, path.join(srcRoot, 'api', 'client')), ['ApiError'], false);
        for (const nd of importNeeds.values()) {
            let mod = nd.module;
            if (mod.startsWith('.')) mod = relModule(hookAbs, path.resolve(path.dirname(file), mod));
            need(mod, nd.specs, nd.typeOnly);
        }
        let newImports = '';
        for (const nd of needs.values()) {
            if (!nd.names.size) continue;
            const e = addImportEdit(hookText, hsf, nd.mod, [...nd.names], nd.typeOnly);
            if (!e || (!e.text && e.start === e.end)) continue;
            if (e.text.startsWith('import ')) newImports += e.text; else edits.push(e);
        }
        if (newImports) {
            const imps = hsf.statements.filter(ts.isImportDeclaration);
            const at = imps.length ? imps[imps.length - 1].getEnd() + 1 : 0;
            edits.push({ start: at, end: at, text: newImports });
        }
        const keysDecl = hsf.statements.find((st) => ts.isVariableStatement(st) && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === keysName));
        let body2 = '';
        if (keysDecl) {
            const kd = keysDecl.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === keysName);
            let o = kd.initializer;
            while (o && (ts.isAsExpression(o) || ts.isParenthesizedExpression(o) || ts.isSatisfiesExpression(o))) o = o.expression;
            if (!o || !ts.isObjectLiteralExpression(o)) throw new Skip('existing keys object is not a literal');
            if (o.properties.length && !o.properties.hasTrailingComma) edits.push({ start: o.properties[o.properties.length - 1].getEnd(), end: o.properties[o.properties.length - 1].getEnd(), text: ',' });
            const closeAt = o.getEnd() - 1;
            const lineStart = hookText.lastIndexOf('\n', closeAt) + 1;
            const atLineStart = hookText.slice(lineStart, closeAt).trim() === '';
            edits.push({ start: atLineStart ? lineStart : closeAt, end: atLineStart ? lineStart : closeAt, text: atLineStart ? `    ${keyProp}\n` : `\n    ${keyProp}\n` });
        } else {
            body2 += `export const ${keysName} = {\n    ${keyProp}\n};\n\n`;
        }
        body2 += hookSrc;
        let out = applyEdits(hookText, edits);
        out = out.replace(/\n*$/, '\n') + '\n' + body2;
        hf.text = out;
        hf.hooks.push({ hookName, file: hookAbs, key: base });
    }

    // ---- component edit
    const edits = [];
    const removedImports = [];
    for (const root of [effectStmt, ...allStates.map((x) => x.stmt)]) walk(root, (x) => { if (ts.isIdentifier(x) && ctx.imports.has(x.text)) removedImports.push(x.text); });
    const hookCallArgs = paramInfo.map((p) => p.name).join(', ');
    const q = `${dataState.value}Query`;
    if (ctx.compScope.has(q) || ctx.taken.has(q)) throw new Skip('name clash', q);
    const lines = [];
    lines.push(`const ${q} = ${hookName}(${hookCallArgs});`);
    const hoistedAll = [];
    for (const di of dataInfos) {
        const { st, initNode, typeText } = di;
        let fallback;
        if (!initNode || (initNode.kind === K.Identifier && initNode.text === 'undefined')) fallback = '';
        else if (!isPrimitiveInit(initNode)) {
            const cname = `EMPTY_${st.value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
            hoistedAll.push(`const ${cname}: ${typeText} = ${initNode.getText(sf)};\n\n`);
            fallback = ` ?? ${cname}`;
        } else fallback = ` ?? ${initNode.getText(sf)}`;
        lines.push(dataInfos.length === 1 ? `const ${st.value} = ${q}.data${fallback};` : `const ${st.value} = ${q}.data?.${st.value}${fallback};`);
    }
    const hoisted = hoistedAll.length ? hoistedAll.join('') : null;
    if (roleStates.loading) lines.push(`const ${roleStates.loading.value} = ${q}.isFetching;`);
    if (roleStates.error) {
        if (/queryError/.test(errorExpr)) {
            lines.push(`const queryError = ${q}.error;`);
            lines.push(`const ${roleStates.error.value} = queryError ? ${errorExpr} : null;`);
            if (ctx.compScope.has('queryError') || ctx.taken.has('queryError')) throw new Skip('name clash', 'queryError');
        } else lines.push(`const ${roleStates.error.value} = ${q}.error ? ${errorExpr} : null;`);
    }
    const ind0 = indentOf(text, effectStmt.getStart(sf));
    edits.push({ start: effectStmt.getStart(sf), end: effectStmt.getEnd(), text: lines.join('\n' + ind0) });
    for (const st of new Set(allStates.map((x) => x.stmt))) {
        const sp = lineSpan(text, st, sf);
        edits.push({ start: sp.start, end: sp.end, text: '' });
    }
    if (hoisted) {
        const top = ctx.topStmt;
        edits.push({ start: top.getStart(sf), end: top.getStart(sf), text: hoisted });
    }
    const hookMod = relModule(file, path.join(queriesDir, feature));
    const want = (mod, nme) => { if (!ctx.importWants.has(mod)) ctx.importWants.set(mod, new Set()); ctx.importWants.get(mod).add(nme); };
    want(hookMod, hookName);
    if (needApiError) want(relModule(file, path.join(srcRoot, 'api', 'client')), 'ApiError');
    ctx.taken.add(q);
    if (roleStates.error && /queryError/.test(errorExpr)) ctx.taken.add('queryError');
    return {
        edits,
        info: { kind: 'query', hook: hookName, hookFile: hookAbs, feature, key: base, params: paramInfo.map((p) => p.name), removedNames: ['useState', 'useEffect', 'authFetch', 'API_BASE', 'logger', ...removedImports], effectLine: lineOf(sf, effectStmt) },
    };
}

/** Run query mode on one file. */
function queryFile(file, text, shared) {
    const results = { converted: [], skipped: [], text };
    if (!/\bauthFetch\b/.test(text) || !/\buseEffect\b/.test(text)) return results;
    const srcRoot = srcRootOf(file);
    if (!srcRoot) { results.skipped.push({ file, kind: 'query', line: 0, reason: 'file is not under a src/ directory' }); return results; }
    const program = shared.program(file);
    const sf = program.getSourceFile(path.resolve(file)); // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a repo script that reads local source files; its regexes are anchored or single-class, linear
    if (!sf) { results.skipped.push({ file, kind: 'query', line: 0, reason: 'file not in the TypeScript program' }); return results; }
    const checker = program.getTypeChecker();
    const imports = importMap(sf);
    const topNames = topLevelNames(sf);
    const allEdits = [];
    const importWants = new Map();
    let removed = new Set();
    // components / hooks: functions that own useEffect statements
    const fns = [];
    walk(sf, (n) => { if (isFunctionLike(n) && n.body && ts.isBlock(n.body) && effectCalls(n).length) fns.push(n); });
    for (const fn of fns) {
        const states = findStates(fn);
        const compScope = new Set();
        for (const p of fn.parameters) collectBindingNames(p.name, compScope);
        for (const st of fn.body.statements) {
            if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) collectBindingNames(d.name, compScope);
            else if (ts.isFunctionDeclaration(st) && st.name) compScope.add(st.name.text);
        }
        let topStmt = fn;
        while (topStmt.parent && topStmt.parent !== sf) topStmt = topStmt.parent;
        const compName = fn.name ? fn.name.text : (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : null);
        const ctx = { sf, text, file, checker, imports, topNames, states, compScope, fn, topStmt, srcRoot, hookFiles: shared.hookFiles, compName, taken: new Set(), importWants };
        for (const eff of effectCalls(fn)) {
            const hasFetch = /\bauthFetch\b/.test(eff.getText(sf));
            if (!hasFetch) continue;
            const hasMutation = (() => { let m = false; walk(eff, (n) => { if (isAuthFetchCall(n) && methodOf(n.arguments[1]).kind === 'literal' && methodOf(n.arguments[1]).value !== 'GET') m = true; }); return m; })();
            if (hasMutation) { results.skipped.push({ file, kind: 'query', line: lineOf(sf, eff), reason: 'mutation inside the effect' }); continue; }
            try {
                const r = queryOne(ctx, eff);
                // the three removed ranges must not overlap earlier conversions' edits
                allEdits.push(...r.edits);
                for (const nme of r.info.removedNames) removed.add(nme);
                results.converted.push({ file, line: r.info.effectLine, ...r.info });
            } catch (e) {
                if (e instanceof Skip) results.skipped.push({ file, kind: 'query', line: lineOf(sf, eff), reason: e.reason, detail: e.detail || undefined });
                else throw e;
            }
        }
    }
    if (allEdits.length) {
        let newImports = '';
        for (const [mod, names] of importWants) {
            const e = addImportEdit(text, sf, mod, [...names], false);
            if (!e || (!e.text && e.start === e.end)) continue;
            if (e.text.startsWith('import ')) newImports += e.text; else allEdits.push(e);
        }
        if (newImports) {
            const imps = sf.statements.filter(ts.isImportDeclaration);
            const at = imps.length ? imps[imps.length - 1].getEnd() + 1 : 0;
            allEdits.push({ start: at, end: at, text: newImports });
        }
        let out = applyEdits(text, allEdits);
        out = pruneImports(file, out, removed);
        results.text = out;
    }
    return results;
}

// ============================================================ MUTATION MODE

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function mutationFile(file, text) {
    const results = { converted: [], skipped: [], text };
    if (!/\bauthFetch\b/.test(text)) return results;
    const sf = parse(file, text);
    const srcRoot = srcRootOf(file);
    if (!srcRoot) return results;
    const edits = [];
    let usesApiError = false;
    const sites = [];
    walk(sf, (n) => {
        if (!isAuthFetchCall(n)) return;
        const m = methodOf(n.arguments[1]);
        if (m.kind === 'literal' && MUTATING.has(m.value)) sites.push(n);
        else if (m.kind === 'dynamic') sites.push({ dynamic: true, node: n });
    });
    for (const site of sites) {
        if (site.dynamic) { results.skipped.push({ file, kind: 'mutation', line: lineOf(sf, site.node), reason: 'method is not a literal' }); continue; }
        const line = lineOf(sf, site);
        try {
            const r = convertMutation(sf, text, site, edits);
            if (r.usesApiError) usesApiError = true;
            results.converted.push({ file, kind: 'mutation', line, shape: r.shape });
        } catch (e) {
            if (e instanceof Skip) results.skipped.push({ file, kind: 'mutation', line, reason: e.reason, detail: e.detail || undefined });
            else throw e;
        }
    }
    if (results.converted.length) {
        const mod = relModule(file, path.join(srcRoot, 'api', 'mutate'));
        const imp = addImportEdit(text, sf, mod, ['mutate', usesApiError ? 'ApiError' : null], false);
        if (imp && (imp.text || imp.start !== imp.end)) edits.push(imp);
        let out = applyEdits(text, edits);
        out = pruneImports(file, out, new Set(['authFetch']));
        results.text = out;
    }
    return results;
}

function exits(st) {
    if (ts.isReturnStatement(st) || ts.isThrowStatement(st) || ts.isContinueStatement(st) || ts.isBreakStatement(st)) return true;
    if (ts.isBlock(st)) return st.statements.length > 0 && exits(st.statements[st.statements.length - 1]);
    return false;
}

function convertMutation(sf, text, call, edits) {
    const decl = call.parent && ts.isAwaitExpression(call.parent) ? call.parent.parent : null;
    if (!decl) {
        if (call.parent && ts.isPropertyAccessExpression(call.parent)) throw new Skip('promise chain');
        if (call.parent && ts.isExpressionStatement(call.parent)) throw new Skip('Response ignored (unchecked)');
        throw new Skip('Response is passed on');
    }
    if (ts.isExpressionStatement(decl)) throw new Skip('Response ignored (unchecked)');
    if (!ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name) || !ts.isVariableDeclarationList(decl.parent) || decl.parent.declarations.length !== 1 || !ts.isVariableStatement(decl.parent.parent)) throw new Skip('Response is not bound to a const');
    const stmt = decl.parent.parent;
    const block = stmt.parent;
    if (!ts.isBlock(block)) throw new Skip('statement is not in a block');
    const res = decl.name.text;
    const idx = block.statements.indexOf(stmt);
    const after = block.statements.slice(idx + 1);
    // first statement that mentions the response
    const mentions = (st) => refsOf(st, res).length > 0;
    const firstIdx = after.findIndex(mentions);
    if (firstIdx < 0) throw new Skip('Response ignored (unchecked)');
    const first = after[firstIdx];
    if (!ts.isIfStatement(first)) {
        const okLater = after.slice(firstIdx).some((st) => { let hit = false; walk(st, (n) => { if (ts.isPropertyAccessExpression(n) && n.name.text === 'ok' && ts.isIdentifier(n.expression) && n.expression.text === res) hit = true; }); return hit; });
        throw new Skip(okLater ? 'ok check is not the first use of the Response' : 'no ok check (changing it would change behaviour)');
    }
    const cond = unparen(first.expression);
    const errName = ['err', 'apiErr', 'mutateErr'].find((nme) => !refsOf(block, nme).length && !new RegExp(`\\b${nme}\\b`).test(text.slice(first.getStart(sf), first.getEnd()))) || 'mutateErr'; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- a repo script that reads local source files; its regexes are anchored or single-class, linear
    const restMentions = after.slice(firstIdx + 1).some(mentions);

    const argsText = call.arguments.map((a) => a.getText(sf)).join(', ');
    const dstmt = (n, replaceStatus) => {
        // text of a statement list with `res.status` -> `err.status`, other res uses forbidden
        const out = [];
        for (const s of n) {
            const base = s.getStart(sf);
            const es = [];
            for (const id of refsOf(s, res)) {
                if (ts.isPropertyAccessExpression(id.parent) && id.parent.expression === id && id.parent.name.text === 'status') es.push({ start: id.getStart(sf) - base, end: id.parent.getEnd() - base, text: `${errName}.status` });
                else throw new Skip('non-ok branch reads the Response');
            }
            out.push(applyEdits(s.getText(sf), es));
        }
        void replaceStatus;
        return out;
    };

    if (ts.isPrefixUnaryExpression(cond) && isNotOk(cond, res)) {
        if (first !== after[0]) throw new Skip('statements between the request and the ok check');
        if (first.elseStatement) throw new Skip('ok check has an else');
        if (!exits(first.thenStatement)) throw new Skip('non-ok branch falls through');
        const items = ts.isBlock(first.thenStatement) ? [...first.thenStatement.statements] : [first.thenStatement];
        const bodyLines = dstmt(items);
        const ind = indentOf(text, stmt.getStart(sf));
        const i2 = '    ';
        const awaited = `await mutate(${argsText})`;
        const lines = [];
        if (restMentions) {
            lines.push(`let ${res}: Response;`);
            lines.push('try {');
            lines.push(`${i2}${res} = ${awaited};`);
        } else {
            lines.push('try {');
            lines.push(`${i2}${awaited};`);
        }
        lines.push(`} catch (${errName}) {`);
        lines.push(`${i2}if (!(${errName} instanceof ApiError)) throw ${errName};`);
        for (const l of bodyLines) lines.push(`${i2}${l}`);
        lines.push('}');
        edits.push({ start: stmt.getStart(sf), end: first.getEnd(), text: lines.join('\n' + ind) });
        return { shape: 'if (!res.ok) exit -> try/catch', usesApiError: true };
    }
    if (isOk(cond, res)) {
        if (first !== after[0]) throw new Skip('statements between the request and the ok check');
        // `if (res.ok) {A} [else {B}]`: B must not touch the Response
        if (first.elseStatement && refsOf(first.elseStatement, res).length) throw new Skip('else branch reads the Response');
        if (restMentions) throw new Skip('Response used after the ok branch');
        const dEnd = call.getEnd();
        edits.push({ start: call.expression.getStart(sf), end: call.expression.getEnd(), text: 'mutate' });
        const awaitExpr = call.parent; // await authFetch(...)
        edits.push({ start: awaitExpr.getEnd(), end: awaitExpr.getEnd(), text: `.catch((${errName}: unknown) => {\n${indentOf(text, stmt.getStart(sf))}    if (${errName} instanceof ApiError) return null;\n${indentOf(text, stmt.getStart(sf))}    throw ${errName};\n${indentOf(text, stmt.getStart(sf))}})` });
        void dEnd;
        // `await mutate(...).catch(...)`: await binds to the whole chain only if parenthesised the other way round
        edits.push({ start: first.expression.getStart(sf), end: first.expression.getEnd(), text: res });
        return { shape: 'if (res.ok) -> if (res)', usesApiError: true, needsAwaitFix: true };
    }
    throw new Skip('the ok check is not a plain res.ok test');
}

// ===================================================== tests needing a client

function findTestsNeedingClient(srcRoot, converted) {
    const out = [];
    if (!srcRoot || !converted.length) return out;
    const tests = [];
    (function w(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) { if (e.name !== 'node_modules') w(p); } else if (/\.test\.[tj]sx?$/.test(e.name)) tests.push(p);
        }
    })(srcRoot);
    const targets = new Map(converted.map((f) => [f.replace(/\.[tj]sx?$/, ''), f]));
    for (const t of tests) {
        const src = fs.readFileSync(t, 'utf8');
        const tsf = parse(t, src);
        let hit = null;
        for (const st of tsf.statements) {
            if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.')) continue;
            const abs = path.resolve(path.dirname(t), st.moduleSpecifier.text);
            for (const cand of [abs, path.join(abs, 'index')]) if (targets.has(cand)) hit = targets.get(cand);
        }
        if (!hit) continue;
        if (/renderWithClient|withQueryClient|QueryClientProvider|makeTestQueryClient/.test(src)) continue;
        out.push({ test: t, component: hit });
    }
    return out;
}

// ======================================================================== API

export function run(files, { mode = 'both', dry = false, report = null } = {}) {
    const abs = files.map((f) => path.resolve(f));
    const shared = {
        hookFiles: new HookFiles(),
        _program: null,
        program(file) {
            if (!this._program) this._program = createProgramFor(abs.filter((f) => /\.[tj]sx?$/.test(f)));
            return this._program;
        },
    };
    const converted = [];
    const skipped = [];
    const changedFiles = new Map();
    for (const file of abs) {
        let text = fs.readFileSync(file, 'utf8');
        if (/\.test\.[tj]sx?$/.test(file) || /[\\/]src[\\/]api[\\/]/.test(file)) continue;
        if (mode === 'query' || mode === 'both') {
            const r = queryFile(file, text, shared);
            converted.push(...r.converted.map((c) => ({ ...c, kind: 'query' })));
            skipped.push(...r.skipped);
            if (r.text !== text) { text = r.text; changedFiles.set(file, text); }
        }
        if (mode === 'mutation' || mode === 'both') {
            const r = mutationFile(file, text);
            converted.push(...r.converted);
            skipped.push(...r.skipped);
            if (r.text !== text) { text = r.text; changedFiles.set(file, text); }
        }
    }
    const hookWrites = new Map();
    for (const [p, hf] of shared.hookFiles.files) if (hf.hooks.length) hookWrites.set(p, hf.text);
    const queryFiles = [...new Set(converted.filter((c) => c.kind === 'query').map((c) => c.file))];
    const srcRoot = queryFiles.length ? srcRootOf(queryFiles[0]) : null;
    const testsNeedingClient = findTestsNeedingClient(srcRoot, queryFiles);
    if (!dry) {
        for (const [p, t] of changedFiles) fs.writeFileSync(p, t);
        for (const [p, t] of hookWrites) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); }
    }
    const result = {
        converted, skipped, testsNeedingClient,
        changedFiles: [...changedFiles.keys()], hookFiles: [...hookWrites.keys()],
        texts: Object.fromEntries([...changedFiles, ...hookWrites]),
        summary: summarize(converted, skipped),
    };
    if (report) fs.writeFileSync(report, JSON.stringify({ ...result, texts: undefined }, null, 2));
    return result;
}

function summarize(converted, skipped) {
    const s = { query: { converted: 0, skipped: 0, reasons: {} }, mutation: { converted: 0, skipped: 0, reasons: {} } };
    for (const c of converted) s[c.kind].converted += 1;
    for (const k of skipped) { s[k.kind].skipped += 1; s[k.kind].reasons[k.reason] = (s[k.kind].reasons[k.reason] || 0) + 1; }
    return s;
}

// ======================================================================== CLI

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const files = [];
    const opts = { mode: 'both', dry: false, report: null };
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--dry') opts.dry = true;
        else if (a === '--mode') opts.mode = args[++i];
        else if (a === '--report') opts.report = args[++i];
        else if (a.startsWith('--')) { console.error(`unknown option ${a}`); process.exit(2); }
        else files.push(a);
    }
    if (!files.length || !['query', 'mutation', 'both'].includes(opts.mode)) {
        console.error('usage: node scripts/rq-codemod.mjs <files...> [--dry] [--mode query|mutation|both] [--report out.json]');
        process.exit(2);
    }
    const r = run(files, opts);
    const rel = (p) => path.relative(process.cwd(), p);
    for (const c of r.converted) console.log(`${opts.dry ? 'would convert' : 'converted'} ${c.kind} ${rel(c.file)}:${c.line}${c.hook ? ` -> ${c.hook} (${rel(c.hookFile)})` : ` (${c.shape})`}`);
    for (const k of r.skipped) console.log(`skip ${k.kind} ${rel(k.file)}:${k.line}  ${k.reason}${k.detail ? ` [${k.detail}]` : ''}`);
    if (r.testsNeedingClient.length) {
        console.log('\ntests rendering a converted component without a QueryClient:');
        for (const t of r.testsNeedingClient) console.log(`  ${rel(t.test)}  (renders ${rel(t.component)})`);
    }
    console.log('\n' + JSON.stringify(r.summary, null, 2));
}
