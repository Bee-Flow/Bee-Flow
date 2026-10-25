// Call-site type inference for scripts/ts-convert-codefix.mjs.
//
// TypeScript's own inferFromUsage quick fix types a parameter from how the body
// uses it, which for a React component's props mostly ends in `any`. Most of
// agent-hub is TypeScript already, so the CALLERS know the types: this module
// reads them. For each untyped parameter of a function or component in the
// file it finds every reference in a TypeScript source (tests and JavaScript
// excluded: their values say nothing), and takes
//   - <Comp a={x} b />          the type of each attribute, `children` for a body
//   - fn(x, y)                  the type of each argument
//   - onChange={fn}, cb(fn)     the parameter types of the contextual signature
// widened (a literal "primary" becomes string) and joined in a union. A prop
// missing at some call site, or with a default, becomes optional. A component
// gets `interface <Name>Props` above it. Everything is refused when one
// position stays unknown, when a type prints `any`, or when it gets long:
// a person or an agent types those.

import path from 'node:path';

import { typeFromSamples } from './ts-runtime-types.mjs';

const MAX_TYPE = 140;

const isTestOrJs = (f) => !siteFilter(f);

/**
 * Where a function's JSDoc goes: the statement, class member or property that
 * holds it (`const f = (a) => ...` -> the variable statement).
 */
export function jsdocHost(ts, fn) {
    let n = fn;
    for (;;) {
        const p = n.parent;
        if (!p || ts.isSourceFile(p) || ts.isBlock(p) || ts.isModuleBlock(p) || ts.isClassLike(p) || ts.isObjectLiteralExpression(p)) return n;
        if (ts.isStatement(n) && !ts.isVariableDeclarationList(p)) return n;
        n = p;
    }
}

// Which call sites count as typed. agent-hub: TypeScript sources only (a
// JavaScript caller passes `any`). The server is JavaScript throughout, with
// types from JSDoc: there JavaScript callers count, tests still do not.
let siteFilter = (f) => !(/\.(test|spec)\.[jt]sx?$/.test(f) || /\.[cm]?jsx?$/.test(f) || /\/__tests__\/|\/test-utils?\/|\/testUtils\//.test(f));
export function setSiteFilter(fn) { siteFilter = fn; }

/**
 * A parameter or variable that already carries a type: `x: T`, or in a
 * JavaScript file a JSDoc `@param {T} x` / `@type {T}` (a destructured
 * parameter is documented by position). Without this a JavaScript file would
 * be typed again on every pass: the JSDoc written in pass 1 leaves `p.type`
 * empty, and the typedefs and `@type` lines stacked up (five copies, TS2300).
 */
export function hasDeclaredType(ts, node) {
    if (node.type) return true;
    if (!/\.[cm]?jsx?$/.test(node.getSourceFile().fileName)) return false;
    if (ts.isParameter(node)) return ts.getJSDocParameterTags(node).some((t) => t.typeExpression) || !!ts.getJSDocType(node);
    return !!ts.getJSDocType(node);
}

/** Names declared by `@typedef {...} Name` (nested braces included) in JSDoc text. */
export function jsdocTypedefNames(text) {
    const out = new Set();
    for (const m of text.matchAll(/@typedef\s+(?:\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}\s*)?([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
    return out;
}

export function nameNodeOf(ts, fn) {
    if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name;
    // A class's constructor is called as `new Name(...)`; a method as `x.name(...)`.
    if (ts.isConstructorDeclaration(fn)) return fn.parent.name || null;
    if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return fn.name;
    let n = fn.parent;
    // memo(...), forwardRef(...), memo(forwardRef(...))
    while (n && ts.isCallExpression(n) && /^(React\.)?(memo|forwardRef|useCallback)$/.test(n.expression.getText())) n = n.parent;
    if (n && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name;
    if (n && ts.isExportAssignment(n)) return null;
    return null;
}

/**
 * A stable key per named function: `name#n` (n-th function of that name in
 * document order). The runtime recorder (ts-runtime-types.mjs) keys what it
 * sees by the same walk over the JavaScript, and adding types moves no function.
 */
export function functionKeys(ts, sf) {
    const keys = new Map(); const seen = new Map();
    const visit = (n) => {
        if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isMethodDeclaration(n)) {
            const nn = nameNodeOf(ts, n);
            const name = nn && (ts.isConstructorDeclaration(n) ? `${nn.text}.constructor` : ts.isMethodDeclaration(n) && n.parent.name ? `${n.parent.name.text}.${nn.text}` : nn.text);
            if (name) { const c = seen.get(name) || 0; seen.set(name, c + 1); keys.set(n, `${name}#${c}`); }
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return keys;
}

// Imported type names that were used with type arguments (`WithImplicitCoercion<string>`):
// the JSDoc lowering cannot alias those (`@typedef {import('x').G} G` drops the
// parameter), it writes `import('x').G<...>` inline instead.
export const genericImports = new Set();

/** Return `{ node, text }` replacing `import("spec").Name` by `Name`, collecting the imports it needs. */
function printType(ts, checker, type, enclosing, file, imports) {
    const flags = ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseSingleQuotesForStringLiteralType
        | ts.NodeBuilderFlags.WriteArrayAsGenericType * 0 | ts.NodeBuilderFlags.IgnoreErrors * 0;
    const node = checker.typeToTypeNode(type, enclosing, flags);
    if (!node) return null;
    const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
    let text = printer.printNode(ts.EmitHint.Unspecified, node, enclosing.getSourceFile()).replace(/\s*\n\s*/g, ' ');
    const local = [];
    text = text.replace(/import\("([^"]+)"\)\.([A-Za-z_$][\w$]*)(?=(<)?)/g, (_, spec, name, lt) => {
        let s = spec;
        if (path.isAbsolute(s)) {
            s = path.relative(path.dirname(file), s).replace(/\\/g, '/').replace(/\.(d\.)?[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
            if (!s.startsWith('.')) s = `./${s}`;
        }
        if (lt) genericImports.add(name);
        local.push([name, s]);
        return name;
    });
    return { text, local };
}

/**
 * A type parameter anywhere in `t` (`T`, `T[]`, `Promise<T>`, `{ items: T[] }`):
 * it has no meaning outside its own function and prints as a bare `T`.
 */
function hasTypeParameter(ts, checker, t, depth = 0) {
    if (!t || depth > 5) return false;
    if (t.flags & (ts.TypeFlags.TypeParameter | ts.TypeFlags.Index | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional | ts.TypeFlags.Substitution)) return true;
    if (t.isUnionOrIntersection()) return t.types.some((m) => hasTypeParameter(ts, checker, m, depth + 1));
    if (t.flags & ts.TypeFlags.Object) {
        if (t.objectFlags & ts.ObjectFlags.Reference && checker.getTypeArguments(t).some((a) => hasTypeParameter(ts, checker, a, depth + 1))) return true;
        if (t.objectFlags & ts.ObjectFlags.Anonymous) return t.getProperties().some((p) => hasTypeParameter(ts, checker, checker.getTypeOfSymbol ? checker.getTypeOfSymbol(p) : checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration || p.declarations?.[0]), depth + 1));
    }
    return false;
}

/** `{}`, `Object` and `object` say nothing about a value (and `Object` makes every member access an error). */
function isUselessObjectType(ts, checker, t) {
    if (!(t.flags & ts.TypeFlags.Object)) return false;
    const s = checker.typeToString(t);
    return s === '{}' || s === 'Object' || s === 'object';
}

/**
 * The widened union of `types`, printed; null when it may not be written.
 * `null` and `undefined` among the samples are kept apart and written back as
 * `| null` / `| undefined`: with strictNullChecks off (the server's jsconfig)
 * the checker would widen them to `any` and drop them from a union, and a
 * caller that passes null would either poison the slot or lose its null.
 */
/** @type {string | undefined} */
unionText.why = undefined;
function unionText(ts, checker, types, enclosing, file, imports, { keepLiterals = false } = {}) {
    let sawNull = false; let sawUndefined = false; const rest = [];
    for (const t of types) {
        // A call site that passes `any` (untyped code) or `{}` says nothing: leave it out.
        if (t.flags & ts.TypeFlags.Any || isUselessObjectType(ts, checker, t)) continue;
        if (t.flags & ts.TypeFlags.Null) { sawNull = true; continue; }
        if (t.flags & ts.TypeFlags.Undefined || t.flags & ts.TypeFlags.Void) { sawUndefined = true; continue; }
        if (t.isUnion()) {
            // `string | null` declared on a caller's value: the null travels along.
            if (t.types.some((m) => m.flags & ts.TypeFlags.Null)) sawNull = true;
            if (t.types.some((m) => m.flags & ts.TypeFlags.Undefined)) sawUndefined = true;
        }
        rest.push(t);
    }
    if (!rest.length) { unionText.why = sawNull || sawUndefined ? 'only null/undefined at the call sites' : 'only any at the call sites'; return null; }
    const widened = rest.map((t) => (keepLiterals ? t : checker.getWidenedType(checker.getBaseTypeOfLiteralType(t))));
    if (widened.some((t) => hasTypeParameter(ts, checker, t))) { unionText.why = 'a type parameter of the caller'; return null; }
    // A union of the call-site types; the checker dedupes and collapses subtypes.
    // Two structurally equal anonymous types stay two members of a union: dedupe by text.
    const byText = new Map(); for (const t of widened) { const k = checker.typeToString(t); if (!byText.has(k)) byText.set(k, t); }
    widened.length = 0; widened.push(...byText.values());
    const u = widened.length === 1 ? widened[0] : checker.getUnionType ? checker.getUnionType(widened) : null;
    if (!u) return null;
    if (u.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) { unionText.why = checker.typeToString(u); return null; }
    const printed = printType(ts, checker, u, enclosing, file, imports);
    if (!printed) return null;
    let { text } = printed; const { local } = printed;
    // agent-hub's layer direction (lint:import-zones-ratchet): api/ and hooks/
    // never import from components/ or pages/, components/ never from pages/.
    // A type that would need such an import is not written.
    const layer = (f) => (/\/src\/(api|hooks)\//.test(f) ? 0 : /\/src\/components\//.test(f) ? 1 : /\/src\/pages\//.test(f) ? 2 : -1);
    const from = layer(file);
    if (from >= 0 && local.some(([, spec]) => spec && spec.startsWith('.') && layer(path.resolve(path.dirname(file), spec)) > from)) { unionText.why = 'needs an import against the layer direction'; return null; }
    // `Function` is banned in both emitters; a lone capital letter is a type parameter that slipped
    // through printing; a member typed `null` alone (`{ edge_pop: null }` from one object literal)
    // would freeze what a later assignment fills in.
    if (/\bany\b|\bunknown\b|\bnever\b|\bFunction\b|import\(|typeof import|\.\.\.\s*args|\bthis\b|(^|[^\w$.])[A-Z]([^\w$]|$)/.test(text) || /(^|\| )(\{\}|Object|object)( \||$)/.test(text) || /:\s*(null|undefined)(\s*\|\s*(null|undefined))?\s*[;,}]/.test(text) || text.length > MAX_TYPE) { unionText.why = text.slice(0, 200); return null; }
    if (sawNull && !/\bnull\b/.test(text)) text += ' | null';
    if (sawUndefined && !/\bundefined\b/.test(text)) text += ' | undefined';
    return { text, local };
}


// Per pass the program is fixed (the converter applies a pass's edits at its
// end), so every lookup below may be cached until resetCaches().
const refCache = new Map();
export function resetCaches() { refCache.clear(); consumerCache.clear(); }

/**
 * References of the symbol named at `nameNode`: [{ fileName, node }]. A
 * parameter or prop binding is only visible inside its function, so that
 * function is walked directly; anything else asks the language service
 * (across files), once per pass.
 */
function refsOf(ts, service, program, nameNode) {
    const sf = nameNode.getSourceFile();
    const key = `${sf.fileName}:${nameNode.getStart(sf)}`;
    if (refCache.has(key)) return refCache.get(key);
    const checker = program.getTypeChecker();
    let out = [];
    const sym = checker.getSymbolAtLocation(nameNode);
    const decl = sym && sym.valueDeclaration;
    let scope = null;
    if (decl && (ts.isParameter(decl) || ts.isBindingElement(decl))) {
        scope = decl; while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
    }
    if (scope) {
        const visit = (n) => {
            if (ts.isIdentifier(n) && n !== nameNode && n.text === nameNode.text) {
                const s = ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n ? checker.getShorthandAssignmentValueSymbol(n.parent) : checker.getSymbolAtLocation(n);
                if (s === sym) out.push({ fileName: sf.fileName, node: n });
            }
            ts.forEachChild(n, visit);
        };
        visit(scope);
    } else {
        const refs = service.findReferences(sf.fileName, nameNode.getStart(sf)) || [];
        for (const r of refs) for (const e of r.references) {
            if (e.isDefinition) continue;
            const rsf = program.getSourceFile(e.fileName); if (!rsf) continue;
            const node = findNode(ts, rsf, e.textSpan.start);
            if (node) out.push({ fileName: e.fileName, node });
        }
        const seen = new Set(out.map((r) => `${r.fileName}:${r.node.getStart()}`));
        for (const r of cjsImporterRefs(ts, program, nameNode)) if (!seen.has(`${r.fileName}:${r.node.getStart()}`)) out.push(r);
    }
    refCache.set(key, out);
    return out;
}

/**
 * CommonJS importers of a function TypeScript's findReferences does not follow
 * (`module.exports = { greet }` -> `const { greet } = require('./greet')` in
 * another file). The exported name comes from `module.exports = {...}`,
 * `module.exports.x =`, `exports.x =` or `module.exports = name`; an importer
 * is any program file whose `require(...)` the checker resolves to this file.
 * Returns the identifiers that stand for the function there.
 */
function cjsImporterRefs(ts, program, nameNode) {
    const sf = nameNode.getSourceFile();
    if (!/\.[cm]?js$/.test(sf.fileName)) return [];
    const checker = program.getTypeChecker();
    const local = nameNode.text;
    let exportName = null; let whole = false;
    const isModuleExports = (e) => ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'module' && e.name.text === 'exports';
    for (const st of sf.statements) {
        if (!ts.isExpressionStatement(st) || !ts.isBinaryExpression(st.expression) || st.expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
        const { left, right } = st.expression;
        if (isModuleExports(left) && ts.isIdentifier(right) && right.text === local) whole = true;
        if (isModuleExports(left) && ts.isObjectLiteralExpression(right)) {
            for (const p of right.properties) {
                if (ts.isShorthandPropertyAssignment(p) && p.name.text === local) exportName = local;
                if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.initializer) && p.initializer.text === local && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) exportName = p.name.text;
            }
        }
        if (ts.isPropertyAccessExpression(left) && (isModuleExports(left.expression) || ts.isIdentifier(left.expression) && left.expression.text === 'exports') && ts.isIdentifier(right) && right.text === local) exportName = left.name.text;
    }
    if (!exportName && !whole) return [];
    const out = [];
    const base = path.basename(sf.fileName).replace(/\.[cm]?js$/, '');
    for (const other of program.getSourceFiles()) {
        if (other === sf || other.isDeclarationFile || !other.text.includes(base)) continue;
        const visit = (n) => {
            if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && ts.isIdentifier(n.initializer.expression) && n.initializer.expression.text === 'require' && n.initializer.arguments[0] && ts.isStringLiteralLike(n.initializer.arguments[0])) {
                const mod = checker.getSymbolAtLocation(n.initializer.arguments[0]);
                const decl = mod && mod.valueDeclaration;
                if (decl && decl.getSourceFile && decl.getSourceFile() === sf) {
                    const refsOfBinding = (id) => { const sym = checker.getSymbolAtLocation(id); const walk = (m) => { if (ts.isIdentifier(m) && m !== id && m.text === id.text && checker.getSymbolAtLocation(m) === sym) out.push({ fileName: other.fileName, node: m }); ts.forEachChild(m, walk); }; walk(other); };
                    if (ts.isObjectBindingPattern(n.name) && exportName) {
                        for (const el of n.name.elements) if ((el.propertyName || el.name).getText(other) === exportName && ts.isIdentifier(el.name)) refsOfBinding(el.name);
                    } else if (ts.isIdentifier(n.name)) {
                        if (whole) refsOfBinding(n.name);
                        else {
                            const sym = checker.getSymbolAtLocation(n.name);
                            const walk = (m) => { if (ts.isPropertyAccessExpression(m) && m.name.text === exportName && ts.isIdentifier(m.expression) && checker.getSymbolAtLocation(m.expression) === sym) out.push({ fileName: other.fileName, node: m.name }); ts.forEachChild(m, walk); };
                            walk(other);
                        }
                    }
                }
            }
            ts.forEachChild(n, visit);
        };
        visit(other);
    }
    return out;
}

function referencesOf(ts, service, program, nameNode) {
    return refsOf(ts, service, program, nameNode).filter((r) => !isTestOrJs(r.fileName)).map((r) => r.node);
}

function findNode(ts, sf, pos) {
    let found;
    const visit = (n) => { if (pos >= n.getStart(sf) && pos < n.getEnd()) { if (ts.isIdentifier(n) && n.getStart(sf) === pos) found = n; ts.forEachChild(n, visit); } };
    visit(sf);
    return found;
}

/** Sites: [{ kind: 'jsx', attrs: Map<name, Type>, spread: bool, children: bool } | { kind: 'args', types: Type[] }], or null if some use is opaque. */
function sitesOf(ts, checker, refs) {
    const sites = []; let opaque = 0;
    for (const ref of refs) {
        let n = ref; while (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) n = n.parent;
        const p = n.parent;
        if (!p) { opaque++; continue; }
        if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === n) {
            const attrs = new Map(); let spread = false; const explicit = new Set();
            for (const a of p.attributes.properties) {
                if (ts.isJsxSpreadAttribute(a)) {
                    spread = true;
                    for (const prop of checker.getTypeAtLocation(a.expression).getProperties()) attrs.set(prop.name, checker.getTypeOfSymbolAtLocation(prop, a.expression));
                    continue;
                }
                const name = a.name.getText();
                explicit.add(name);
                if (!a.initializer) { attrs.set(name, checker.getTrueType ? checker.getTrueType() : checker.getTypeAtLocation(a.name)); continue; }
                // label="x": the checker gives a JSX string attribute of an untyped component `any`.
                if (ts.isStringLiteral(a.initializer)) { attrs.set(name, checker.getStringType()); continue; }
                const expr = ts.isJsxExpression(a.initializer) ? a.initializer.expression : a.initializer;
                if (!expr) continue;
                attrs.set(name, checker.getTypeAtLocation(expr));
            }
            const children = ts.isJsxOpeningElement(p) && p.parent.children.some((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
            sites.push({ kind: 'jsx', attrs, spread, children, explicit });
            continue;
        }
        if ((ts.isCallExpression(p) || ts.isNewExpression(p)) && p.expression === n) { sites.push({ kind: 'args', types: (p.arguments || []).map((a) => (ts.isSpreadElement(a) ? null : checker.getTypeAtLocation(a))), nodes: [...(p.arguments || [])] }); continue; }
        if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isExportSpecifier(p) || ts.isExportAssignment(p)) continue;
        // CommonJS exports (`module.exports = { fn }`, `exports.fn = fn`) name the function, they do not use it.
        const cjsExport = (x) => { let e = x; while (e && !ts.isExpressionStatement(e)) e = e.parent; return !!e && /^(module\.)?exports\b/.test(e.expression.getText()); };
        if ((ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p) && p.initializer === n || ts.isBinaryExpression(p) && p.right === n) && cjsExport(p)) continue;
        // Passed as a value: the expected signature tells the parameter types.
        if (ts.isExpression(n)) {
            const ct = checker.getContextualType(n);
            const sig = ct && checker.getNonNullableType(ct).getCallSignatures()[0];
            if (sig) {
                sites.push({ kind: 'args', types: sig.getParameters().map((s) => checker.getTypeOfSymbolAtLocation(s, n)), contextual: true });
                continue;
            }
        }
        opaque++;
    }
    return { sites, opaque };
}


const USELESS = (ts) => ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.TypeParameter | ts.TypeFlags.Index | ts.TypeFlags.IndexedAccess | ts.TypeFlags.Conditional | ts.TypeFlags.Substitution;

/** `T | undefined` -> T: an optional slot accepts the value without it. */
function withoutUndefined(ts, checker, t) {
    if (!t.isUnion()) return t;
    const kept = t.types.filter((m) => !(m.flags & ts.TypeFlags.Undefined));
    return kept.length === t.types.length ? t : kept.length ? checker.getUnionType(kept) : t;
}

/**
 * What the code expects of a value: the contextual type at every place a
 * reference to `nameNode` is handed on (a JSX attribute, an argument, an
 * object property, a returned value, an assignment), in TypeScript and
 * JavaScript sources alike (a JS caller of a TS component still has the
 * TS prop type as its contextual type). Tests excluded.
 */
const consumerCache = new Map();

/** The declaration a callee or JSX tag resolves to, through imports, memo() and forwardRef(). */
function calleeFunction(ts, checker, expr) {
    let sym = checker.getSymbolAtLocation(expr);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    let d = sym && sym.valueDeclaration;
    if (!d) return null;
    if (ts.isVariableDeclaration(d)) d = d.initializer;
    while (d && ts.isCallExpression(d) && /^(React\.)?(memo|forwardRef|useCallback)$/.test(d.expression.getText())) d = d.arguments[0];
    return d && (ts.isFunctionDeclaration(d) || ts.isArrowFunction(d) || ts.isFunctionExpression(d)) ? d : null;
}

/** Where an untyped receiver keeps the value: the prop binding or the parameter name. */
function receiverName(ts, checker, n) {
    const p = n.parent;
    if (ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent)) {
        const el = p.parent.parent.parent; // JsxAttribute -> JsxAttributes -> opening element
        const fn = calleeFunction(ts, checker, el.tagName);
        const first = fn && fn.parameters[0];
        if (!first || hasDeclaredType(ts, first) || !ts.isObjectBindingPattern(first.name)) return null;
        const key = p.parent.name.getText();
        const b = first.name.elements.find((e) => (e.propertyName || e.name).getText() === key);
        return b && ts.isIdentifier(b.name) ? b.name : null;
    }
    if (ts.isCallExpression(p) && p.expression !== n) {
        const fn = calleeFunction(ts, checker, p.expression);
        const i = p.arguments.indexOf(n);
        const prm = fn && i >= 0 && fn.parameters[i];
        return prm && !hasDeclaredType(ts, prm) && !prm.dotDotDotToken && ts.isIdentifier(prm.name) ? prm.name : null;
    }
    return null;
}

function consumerTypes(ts, service, program, checker, nameNode, depth = 0) {
    const sfN = nameNode.getSourceFile();
    const ck = `${sfN.fileName}:${nameNode.getStart(sfN)}:${sfN.text.length}`;
    if (consumerCache.has(ck)) return consumerCache.get(ck);
    consumerCache.set(ck, []); // cycles: a value handed back to itself says nothing
    const out = [];
    for (const r of refsOf(ts, service, program, nameNode)) {
        if (/\.(test|spec)\.[jt]sx?$/.test(r.fileName)) continue;
        let n = r.node;
        for (;;) {
            const p = n.parent;
            if (p && ts.isParenthesizedExpression(p)) { n = p; continue; }
            if (p && ts.isConditionalExpression(p) && p.condition !== n) { n = p; continue; }
            if (p && ts.isBinaryExpression(p) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind)) { n = p; continue; }
            break;
        }
        const p = n.parent; if (!p) continue;
        // items.map((item) => <Row item={item} />): what each element is handed
        // to says what the array holds.
        if (ts.isPropertyAccessExpression(p) && p.expression === n && /^(map|forEach|filter|find|findLast|some|every|flatMap|findIndex)$/.test(p.name.text)
            && ts.isCallExpression(p.parent) && p.parent.expression === p) {
            const cb = p.parent.arguments[0];
            const el = cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0];
            if (el && !el.type && ts.isIdentifier(el.name) && depth < 4) {
                const inner = mostSpecific(ts, checker, consumerTypes(ts, service, program, checker, el.name, depth + 1));
                if (inner) out.push(checker.createArrayType(inner));
            }
            continue;
        }
        const handedOn = (ts.isJsxExpression(p) && ts.isJsxAttribute(p.parent))
            || (ts.isCallExpression(p) && p.expression !== n) || ts.isNewExpression(p)
            || (ts.isPropertyAssignment(p) && p.initializer === n) || ts.isShorthandPropertyAssignment(p)
            || ts.isReturnStatement(p) || (ts.isVariableDeclaration(p) && p.type)
            || (ts.isBinaryExpression(p) && p.right === n && p.operatorToken.kind === ts.SyntaxKind.EqualsToken);
        if (!handedOn || !ts.isExpression(n) && !ts.isShorthandPropertyAssignment(p)) continue;
        if (ts.isShorthandPropertyAssignment(p)) {
            // `{ user }` handed to a typed function: the property's contextual type.
            const ot = checker.getContextualType(p.parent);
            const prop = ot && ot.getProperty && ot.getProperty(p.name.text);
            if (prop) out.push(withoutUndefined(ts, checker, checker.getTypeOfSymbolAtLocation(prop, p)));
            continue;
        }
        const ct = checker.getContextualType(n);
        if (!ct || ct.flags & USELESS(ts)) {
            // An untyped receiver (a JavaScript component, a parameter without a
            // type): follow the value into it, a few hops deep.
            const next = depth < 4 && receiverName(ts, checker, n);
            if (next) out.push(...consumerTypes(ts, service, program, checker, next, depth + 1));
            continue;
        }
        out.push(withoutUndefined(ts, checker, ct));
    }
    const result = out.filter((t) => !(t.flags & USELESS(ts)) && !/\bany\b|\bunknown\b|\bnever\b/.test(checker.typeToString(t)));
    consumerCache.set(ck, result);
    return result;
}

/**
 * A function-typed slot from how the body calls it: `onSave({ id, name })` and
 * `onClose()` give `(value: { id: string; name: string }) => void` and
 * `() => void`. Only when every use is a call whose result is thrown away, or
 * a truthiness test (`if (onSave)`, `onSave && ...`, `onSave?.()` makes it
 * optional); any other use, or an argument without a type, refuses.
 */
function calleeShape(ts, service, program, checker, nameNode, enclosing, abs, imports) {
    const refs = refsOf(ts, service, program, nameNode);
    if (!refs.length) return null;
    const calls = []; let optional = false;
    for (const { node } of refs) {
        const p = node.parent;
        if (ts.isCallExpression(p) && p.expression === node) {
            if (!ts.isExpressionStatement(p.parent) && !(ts.isArrowFunction(p.parent) && p.parent.body === p) && !ts.isVoidExpression(p.parent)) return null;
            if (p.questionDotToken) optional = true;
            calls.push(p);
            continue;
        }
        const test = ts.isIfStatement(p) && p.expression === node
            || ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken
            || ts.isBinaryExpression(p) && p.left === node && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(p.operatorToken.kind)
            || ts.isConditionalExpression(p) && p.condition === node
            || ts.isTypeOfExpression(p);
        if (test) { optional = true; continue; }
        return null;
    }
    if (!calls.length) return null;
    const arity = Math.max(...calls.map((c) => c.arguments.length));
    const params = [];
    for (let i = 0; i < arity; i++) {
        const types = []; let missing = false; let name = null;
        for (const c of calls) {
            const a = c.arguments[i];
            if (!a) { missing = true; continue; }
            if (ts.isSpreadElement(a)) return null;
            if (!name && ts.isIdentifier(a) && /^[a-z][\w$]*$/.test(a.text)) name = a.text;
            types.push(checker.getTypeAtLocation(a));
        }
        const t = unionText(ts, checker, types, enclosing, abs, imports);
        if (!t) return null;
        params.push({ name: name || (arity === 1 ? 'value' : `arg${i}`), text: t.text, missing, local: t.local });
    }
    // An optional parameter may not come before a required one.
    for (let i = params.length - 2; i >= 0; i--) if (params[i].missing && !params[i + 1].missing) params[i].missing = false;
    const seen = new Set();
    for (const p of params) { let n = p.name; for (let k = 2; seen.has(n); k++) n = `${p.name}${k}`; p.name = n; seen.add(n); }
    const text = `(${params.map((p) => `${p.name}${p.missing ? '?' : ''}: ${p.text}`).join(', ')}) => void`;
    if (text.length > MAX_TYPE) return null;
    return { text, local: params.flatMap((p) => p.local), optional };
}

/**
 * A demand is only a lower bound (the receiver may read one field of a much
 * larger object), so it may stand for the value's type only when it names a
 * domain type, a primitive or a function: no anonymous object shape, and not
 * a bare null/undefined.
 */
function demandText(t) {
    if (!t) return null;
    if (/^(null|undefined)$/.test(t.text) || t.text.includes('{')) return null;
    return t;
}

/** The candidate assignable to every other one (the strictest demand), or null on a conflict. */
function mostSpecific(ts, checker, types) {
    if (!types.length) return null;
    for (const t of types) if (types.every((o) => o === t || checker.isTypeAssignableTo(t, o))) return t;
    return null;
}

const LITERAL = (ts) => ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral;
const isLiteralUnion = (ts, t) => !!(t.flags & LITERAL(ts)) || (t.isUnion() && t.types.every((m) => m.flags & LITERAL(ts)));

/**
 * Callers pass literals (`'local'`, `'eu'`) and the body hands the value to a
 * place that demands a literal union (`state: 'unknown' | 'local' | 'eu'` in a
 * typedef the function returns): the union is the type, not the widened
 * `string`, which the demand would then reject (TS2322). Only when every
 * caller's literal fits the demand; otherwise the callers decide.
 */
function literalContract(ts, service, program, checker, nameNode, callTypes, enclosing, abs, imports) {
    // Each caller passes a literal, or a choice of literals (`hint ? 'local' : 'unknown'`).
    if (!callTypes.length || !callTypes.every((t) => isLiteralUnion(ts, t))) return null;
    const c = mostSpecific(ts, checker, consumerTypes(ts, service, program, checker, nameNode));
    if (!c || !isLiteralUnion(ts, c) || !callTypes.every((t) => checker.isTypeAssignableTo(t, c))) return null;
    return unionText(ts, checker, [c], enclosing, abs, imports, { keepLiterals: true });
}

/** True for `null`, `undefined`, `[]`, `{}` or no argument: an initial value that says nothing about T. */
function isEmptyInit(ts, arg) {
    if (!arg) return true;
    if (arg.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isIdentifier(arg) && arg.text === 'undefined') return true;
    if (ts.isArrayLiteralExpression(arg) && !arg.elements.length) return true;
    if (ts.isObjectLiteralExpression(arg) && !arg.properties.length) return true;
    return false;
}

/** The T of a ref from a contextual type like Ref<T> (the member with `current`). */
function refTarget(ts, checker, ct, at) {
    const members = ct.isUnion() ? ct.types : [ct];
    for (const m of members) {
        const cur = m.getProperty && m.getProperty('current');
        if (cur) return checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(cur, at));
    }
    return null;
}

/**
 * useState(null|[]|{}) and useRef(null) without a type argument: T from what the
 * code puts in. For a state, the arguments of every setter call (and the
 * parameter type where the setter is passed on); for a ref, `ref={x}` and
 * `x.current = v`. The initial value joins the union (null stays possible).
 */
function inferHooks(ts, service, program, checker, sf, abs, report, edits, imports, observed, named, { fkeys, allowed, chosen }) {
    const calls = [];
    const visit = (n) => {
        if (ts.isCallExpression(n) && !n.typeArguments && /(^|\.)(useState|useRef)$/.test(n.expression.getText(sf)) && ts.isVariableDeclaration(n.parent) && n.parent.initializer === n) calls.push(n);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const call of calls) {
        const init = call.arguments[0];
        if (!isEmptyInit(ts, init)) continue;
        const isState = /useState$/.test(call.expression.getText(sf));
        const decl = call.parent;
        let target;
        if (isState) {
            if (!ts.isArrayBindingPattern(decl.name) || decl.name.elements.length < 2) continue;
            const setter = decl.name.elements[1];
            if (!ts.isBindingElement(setter) || !ts.isIdentifier(setter.name)) continue;
            target = setter.name;
        } else {
            if (!ts.isIdentifier(decl.name)) continue;
            target = decl.name;
        }
        const label = `${isState ? 'useState' : 'useRef'} ${target.text}`;
        const slot = hookSlot(ts, decl, fkeys);
        const types = [];
        for (const { fileName, node } of refsOf(ts, service, program, target)) {
            if (isTestOrJs(fileName)) continue;
            const rsf = node.getSourceFile();
            const p = node.parent;
            if (isState) {
                if (p && ts.isCallExpression(p) && p.expression === node && p.arguments[0]) {
                    const a = p.arguments[0];
                    if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) {
                        // An updater: its return type, unless it is built from the untyped prev.
                        const sig = checker.getSignatureFromDeclaration(a);
                        if (sig) types.push(checker.getReturnTypeOfSignature(sig));
                    } else if (ts.isPropertyAccessExpression(a) && a.name.text === 'message' && checker.getTypeAtLocation(a).flags & ts.TypeFlags.Any) {
                        types.push(checker.getStringType()); // setError(err.message): an error message is a string
                    } else types.push(checker.getTypeAtLocation(a));
                } else if (ts.isExpression(node)) {
                    const ct = checker.getContextualType(node);
                    const sig = ct && checker.getNonNullableType(ct).getCallSignatures()[0];
                    const param = sig && sig.getParameters()[0];
                    if (param) {
                        const pt = checker.getTypeOfSymbolAtLocation(param, node);
                        // Dispatch<SetStateAction<T>>: keep the members that are not functions.
                        const ms = (pt.isUnion() ? pt.types : [pt]).filter((t) => !t.getCallSignatures().length);
                        types.push(...ms);
                    }
                }
            } else {
                if (p && ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent) && p.parent.name.getText(rsf) === 'ref') {
                    const ct = checker.getContextualType(node);
                    const t = ct && refTarget(ts, checker, ct, node);
                    if (t) types.push(t);
                } else if (p && ts.isPropertyAccessExpression(p) && p.name.text === 'current' && ts.isBinaryExpression(p.parent) && p.parent.left === p && p.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                    types.push(checker.getTypeAtLocation(p.parent.right));
                }
            }
        }
        let useful = types.filter((t) => !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Never | ts.TypeFlags.Unknown)) && !/\bnever\b|\bany\b/.test(checker.typeToString(t)));
        // setX(null) / setX(undefined) only resets: it says nothing about T.
        if (useful.every((t) => t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))) useful = [];
        let source = 'call';
        if (useful.length && !allowed(slot, 'call')) useful = [];
        if (!useful.length && allowed(slot, 'demand')) {
            source = 'demand';
            // Nothing typed goes in: what the value is handed to says what it must be.
            const holder = isState ? decl.name.elements[0] : decl.name;
            if (holder && ts.isBindingElement(holder) ? ts.isIdentifier(holder.name) : ts.isIdentifier(holder)) {
                const nn = ts.isBindingElement(holder) ? holder.name : holder;
                const demands = consumerTypes(ts, service, program, checker, nn);
                const c = mostSpecific(ts, checker, isState ? demands : demands.map((d) => refTarget(ts, checker, d, nn)).filter(Boolean));
                if (c && demandText({ text: checker.typeToString(c) })) useful = [isState ? checker.getNonNullableType(c) : c];
            }
        }
        if (!useful.length && isState && allowed(slot, 'observed')) {
            const o = observedText(observed, `state:${target.text}`, '=', named);
            if (o) {
                chosen.push({ slot, source: 'observed' });
                const text = init && init.kind === ts.SyntaxKind.NullKeyword && !/\bnull\b/.test(o.text) ? `${o.text} | null` : o.text;
                edits.push({ start: call.expression.getEnd(), end: call.expression.getEnd(), text: `<${text}>`, kind: 'typeArg', type: text });
                for (const l of o.local) imports.set(l[0], l[1]);
                report.push(`${label}: <${text}> (observed)`);
                continue;
            }
        }
        if (!useful.length) { report.push(`${label}: nothing typed flows in`); continue; }
        const isNull = init && init.kind === ts.SyntaxKind.NullKeyword;
        if (isNull && isState) useful.push(checker.getNullType ? checker.getNullType() : checker.getTypeAtLocation(init));
        const t = unionText(ts, checker, useful, call, abs, imports);
        if (!t) { report.push(`${label}: type not writable [${unionText.why}]`); continue; }
        // useRef<HTMLDivElement>(null) is the React 19 RefObject<T | null>: no `| null` needed.
        const text = !isState && isNull ? t.text.replace(/\s*\|\s*null\b/g, '') : t.text;
        edits.push({ start: call.expression.getEnd(), end: call.expression.getEnd(), text: `<${text}>`, kind: 'typeArg', type: text });
        for (const l of t.local) imports.set(l[0], l[1]);
        chosen.push({ slot, source });
        report.push(`${label}: <${text}>${source === 'call' ? '' : ` (${source})`}`);
    }
}

// ------------------------------------------------------------ slots and sources
//
// A slot is one place a type is written: a parameter (`fn#0|#1`), a prop
// (`Card#0|.label`), a state (`state:setX@fn#0`) or a ref. Each slot takes the
// first source that yields a type: `call` (typed call sites), `demand` (what
// the value is handed to), `observed` (the test runs). The converter checks
// the result: a slot whose own references now carry type errors had a source
// that was wrong (a demand or a fixture is only a lower bound), and is redone
// without that source.

function enclosingKey(ts, node, fkeys) {
    for (let n = node.parent; n; n = n.parent) if (fkeys.has(n)) return fkeys.get(n);
    return '';
}

function hookSlot(ts, decl, fkeys) {
    const init = decl.initializer;
    if (!init || !ts.isCallExpression(init)) return null;
    const callee = init.expression.getText();
    if (/(^|\.)useState$/.test(callee) && ts.isArrayBindingPattern(decl.name)) {
        const set = decl.name.elements[1];
        return set && ts.isBindingElement(set) && ts.isIdentifier(set.name) ? `state:${set.name.text}@${enclosingKey(ts, decl, fkeys)}` : null;
    }
    if (/(^|\.)useRef$/.test(callee) && ts.isIdentifier(decl.name)) return `ref:${decl.name.text}@${enclosingKey(ts, decl, fkeys)}`;
    return null;
}

/** The slot an identifier's value was declared in, or null. */
function slotOfIdentifier(ts, checker, id, fkeys) {
    const sym = ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
    const d = sym && sym.valueDeclaration;
    if (!d) return null;
    if (ts.isParameter(d) && ts.isIdentifier(d.name) && fkeys.has(d.parent)) return `${fkeys.get(d.parent)}|#${d.parent.parameters.indexOf(d)}`;
    if (ts.isBindingElement(d)) {
        const pat = d.parent;
        if (ts.isObjectBindingPattern(pat) && ts.isParameter(pat.parent) && fkeys.has(pat.parent.parent)) return `${fkeys.get(pat.parent.parent)}|.${(d.propertyName || d.name).getText()}`;
        if (ts.isArrayBindingPattern(pat) && ts.isVariableDeclaration(pat.parent)) return hookSlot(ts, pat.parent, fkeys);
    }
    if (ts.isVariableDeclaration(d)) return hookSlot(ts, d, fkeys);
    return null;
}

// Diagnostics that say a value's type does not fit how the code uses it.
export const MISFIT = new Set([2339, 2551, 2532, 2533, 18046, 18047, 18048, 18049, 2345, 2322, 2538, 7053, 2349, 2722, 2769, 2353]);

/** The slot a diagnostic is about: the value at (or left of) its span. */
export function slotOfDiagnostic(ts, program, abs, d) {
    const sf = program.getSourceFile(abs); if (!sf || d.start === undefined) return null;
    const checker = program.getTypeChecker();
    const fkeys = functionKeys(ts, sf);
    let n = ts.getTokenAtPosition(sf, d.start);
    for (let up = 0; n && up < 5; up++, n = n.parent) {
        let id = null;
        if (ts.isIdentifier(n)) id = n;
        else if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n)) {
            let e = n.expression; while (e && (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) || ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
            if (e && ts.isIdentifier(e)) id = e;
        } else if (ts.isJsxAttribute(n) && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression && ts.isIdentifier(n.initializer.expression)) id = n.initializer.expression;
        if (id) { const slot = slotOfIdentifier(ts, checker, id, fkeys); if (slot) return slot; }
        if (ts.isStatement(n)) break;
    }
    return null;
}

// ------------------------------------------------------------ observed types

let namedIndex = null;

/** Exported object-shaped interfaces and type aliases of agent-hub/src: name -> { file, props, required }. */
function buildNamedIndex(ts, program) {
    const idx = [];
    for (const sf of program.getSourceFiles()) {
        const f = sf.fileName;
        if (!/\/agent-hub\/src\//.test(f) || /\.d\.ts$|\.(test|spec)\.|\/test\//.test(f) || !/\.tsx?$/.test(f)) continue;
        for (const st of sf.statements) {
            const exported = st.modifiers && st.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
            if (!exported || st.typeParameters && st.typeParameters.length) continue;
            let members = null;
            if (ts.isInterfaceDeclaration(st) && !st.heritageClauses) members = st.members;
            else if (ts.isTypeAliasDeclaration(st) && ts.isTypeLiteralNode(st.type)) members = st.type.members;
            if (!members) continue;
            const props = new Set(); const required = new Set(); let ok = true;
            for (const m of members) {
                if (!ts.isPropertySignature(m) || !m.name || !(ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) { ok = false; break; }
                props.add(m.name.text); if (!m.questionToken) required.add(m.name.text);
            }
            if (ok && props.size >= 2) idx.push({ name: st.name.text, file: f, props, required });
        }
    }
    return idx;
}

/**
 * The exported interface an observed object shape belongs to: every observed
 * key (80% at least) is one of its properties, all its required ones were
 * seen, and it wins on overlap. One clear winner, or nothing.
 */
function namedFor(ts, program, sf, abs, imports, declaredHere) {
    namedIndex ??= buildNamedIndex(ts, program);
    return (objs) => {
        const keys = new Set(objs.flatMap((o) => Object.keys(o.p)));
        if (keys.size < 2) return null;
        // Real data carries fields an interface leaves out (a fixture's userId):
        // most observed keys must be properties, all required ones observed.
        // Score: Jaccard overlap; a tie goes to the declaration nearest to the file.
        const dist = (f) => path.relative(path.dirname(abs), path.dirname(f)).split('/').filter(Boolean).length;
        let best = null; let bestScore = 0; let tie = false;
        for (const c of namedIndex) {
            if (c.file === abs) continue;
            const hit = [...keys].filter((k) => c.props.has(k)).length;
            if (hit < 2 || hit / keys.size < 0.8) continue;
            if (![...c.required].every((k) => keys.has(k))) continue;
            const score = hit / new Set([...keys, ...c.props]).size;
            if (score < 0.4) continue;
            if (score > bestScore + 1e-9) { best = c; bestScore = score; tie = false; } else if (Math.abs(score - bestScore) < 1e-9 && best && best.name !== c.name) {
                const d = dist(c.file) - dist(best.file);
                if (d < 0) { best = c; tie = false; } else if (d === 0) tie = true;
            }
        }
        if (!best || tie || declaredHere.has(best.name) && !imports.has(best.name)) return null;
        const layer = (f) => (/\/src\/(api|hooks)\//.test(f) ? 0 : /\/src\/components\//.test(f) ? 1 : /\/src\/pages\//.test(f) ? 2 : -1);
        if (layer(abs) >= 0 && layer(best.file) > layer(abs)) return null; // against the layer direction
        let spec = path.relative(path.dirname(abs), best.file).replace(/\\/g, '/').replace(/\.tsx?$/, '').replace(/\/index$/, '');
        if (!spec.startsWith('.')) spec = `./${spec}`;
        imports.set(best.name, spec);
        return best.name;
    };
}

/** The observed type of one slot as `{ text, local, optional }`, or null. */
function observedText(observed, key, slot, named) {
    const descs = observed && observed[key] && observed[key][slot];
    if (!descs) return null;
    const opts = {};
    const text = typeFromSamples(descs, named, 0, opts);
    if (!text) return null;
    return { text, local: text.includes('React.') ? [['React', null]] : [], optional: !!opts.optional };
}

/**
 * `const out = { views: 0 }; out.rate = 1.5;` and `const byId = {}; byId[k] = v;`:
 * a JS object grown after its literal. TypeScript closes the literal's type, so
 * it gets the whole shape: the literal's members plus each later one as
 * optional, or Record<string, T> for an empty literal filled by key.
 */
function inferExpandos(ts, checker, sf, abs, imports, edits, report) {
    const decls = [];
    const visit = (n) => {
        if (ts.isVariableDeclaration(n) && !hasDeclaredType(ts, n) && ts.isIdentifier(n.name) && n.initializer && ts.isObjectLiteralExpression(n.initializer)) decls.push(n);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const d of decls) {
        const sym = checker.getSymbolAtLocation(d.name); if (!sym) continue;
        let scope = d; while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
        const lit = d.initializer;
        const own = new Set();
        let ok = true;
        for (const p of lit.properties) {
            if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) own.add(p.name.text);
            else ok = false;
        }
        if (!ok) continue;
        const extra = new Map(); const keyed = []; let other = false;
        const walk = (n) => {
            if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                const l = n.left;
                if (ts.isPropertyAccessExpression(l) && ts.isIdentifier(l.expression) && checker.getSymbolAtLocation(l.expression) === sym && !own.has(l.name.text)) {
                    if (!extra.has(l.name.text)) extra.set(l.name.text, []);
                    extra.get(l.name.text).push(checker.getTypeAtLocation(n.right));
                } else if (ts.isElementAccessExpression(l) && ts.isIdentifier(l.expression) && checker.getSymbolAtLocation(l.expression) === sym) {
                    if (ts.isStringLiteral(l.argumentExpression)) { if (!own.has(l.argumentExpression.text)) { if (!extra.has(l.argumentExpression.text)) extra.set(l.argumentExpression.text, []); extra.get(l.argumentExpression.text).push(checker.getTypeAtLocation(n.right)); } } else keyed.push(n);
                }
            }
            if (ts.isDeleteExpression(n)) other = true;
            ts.forEachChild(n, walk);
        };
        walk(scope);
        if (other || !extra.size && !keyed.length) continue;
        const label = `object ${d.name.text}`;
        let text = null; const local = [];
        if (keyed.length && !own.size && !extra.size) {
            // Filled by computed key only: Record<string, T>.
            const keyTypes = keyed.map((n) => checker.getTypeAtLocation(n.left.argumentExpression));
            if (!keyTypes.every((t) => t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike))) { report.push(`${label}: key not a string`); continue; }
            const t = unionText(ts, checker, keyed.map((n) => checker.getTypeAtLocation(n.right)), d, abs, imports);
            if (!t) { report.push(`${label}: value type not writable`); continue; }
            text = `Record<string, ${t.text}>`; local.push(...t.local);
        } else if (!keyed.length) {
            const members = [];
            for (const p of lit.properties) {
                const t = unionText(ts, checker, [checker.getTypeAtLocation(ts.isPropertyAssignment(p) ? p.initializer : p.name)], d, abs, imports);
                if (!t) { ok = false; break; }
                members.push(`${IDENT_RE.test(p.name.text) ? p.name.text : JSON.stringify(p.name.text)}: ${t.text}`); local.push(...t.local);
            }
            for (const [k, types] of extra) {
                const t = ok && unionText(ts, checker, types, d, abs, imports);
                if (!t) { ok = false; break; }
                members.push(`${IDENT_RE.test(k) ? k : JSON.stringify(k)}?: ${t.text}`); local.push(...t.local);
            }
            if (!ok) { report.push(`${label}: a member type not writable`); continue; }
            text = `{ ${members.join('; ')} }`;
        } else { report.push(`${label}: named and computed members mixed`); continue; }
        if (text.length > 2 * MAX_TYPE) { report.push(`${label}: shape too long`); continue; }
        edits.push({ start: d.name.getEnd(), end: d.name.getEnd(), text: `: ${text}`, kind: 'var', type: text, host: d.parent.parent.getStart(sf) });
        for (const l of local) imports.set(l[0], l[1]);
        report.push(`${label}: ${text}`);
    }
}
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * Patterns the agents fixed by hand in the first wave, done by the tooling:
 *  - a lookup table read with a computed key (`LABELS[kind]`) is
 *    `Record<string, T>` (unless something takes `typeof`/`keyof` of it);
 *  - `catch (e) { ... e.message }`: `(e as Error).message` for message/name/stack;
 *  - `let ro = null; ... ro = new ResizeObserver(...)`: the union of what is
 *    assigned, null included.
 */
function inferLearned(ts, checker, sf, abs, imports, edits, report) {
    const consts = []; const lets = []; const catches = []; const arrays = [];
    const visit = (n) => {
        if (ts.isVariableDeclaration(n) && !hasDeclaredType(ts, n) && ts.isIdentifier(n.name) && n.initializer) {
            const flags = n.parent && n.parent.flags;
            if (ts.isObjectLiteralExpression(n.initializer) && n.initializer.properties.length && flags & ts.NodeFlags.Const) consts.push(n);
            if (!(flags & ts.NodeFlags.Const) && isEmptyInit(ts, n.initializer) && n.initializer.kind === ts.SyntaxKind.NullKeyword) lets.push(n);
            if (ts.isArrayLiteralExpression(n.initializer) && !n.initializer.elements.length) arrays.push(n);
        }
        if (ts.isVariableDeclaration(n) && !hasDeclaredType(ts, n) && ts.isIdentifier(n.name) && !n.initializer && n.parent && !(n.parent.flags & ts.NodeFlags.Const) && ts.isVariableDeclarationList(n.parent) && !ts.isForInStatement(n.parent.parent) && !ts.isForOfStatement(n.parent.parent)) lets.push(n);
        if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name) && !n.variableDeclaration.type) catches.push(n);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    const refsIn = (scope, sym) => {
        const out = [];
        const walk = (n) => { if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === sym) out.push(n); ts.forEachChild(n, walk); };
        walk(scope);
        return out;
    };
    for (const d of consts) {
        const sym = checker.getSymbolAtLocation(d.name); if (!sym) continue;
        const refs = refsIn(sf, sym).filter((r) => r !== d.name);
        const computed = refs.some((r) => ts.isElementAccessExpression(r.parent) && r.parent.expression === r && !ts.isStringLiteralLike(r.parent.argumentExpression) && !ts.isNumericLiteral(r.parent.argumentExpression));
        if (!computed) continue;
        if (refs.some((r) => ts.isTypeQueryNode(r.parent) || ts.isTypeOfExpression(r.parent) && false)) continue;
        const exported = d.parent.parent && ts.isVariableStatement(d.parent.parent) && d.parent.parent.modifiers && d.parent.parent.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
        if (exported) continue; // other files may rely on its literal keys
        const props = d.initializer.properties;
        if (!props.every((p) => ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p))) continue;
        const t = unionText(ts, checker, props.map((p) => checker.getTypeAtLocation(ts.isPropertyAssignment(p) ? p.initializer : p.name)), d, abs, imports);
        if (!t) { report.push(`lookup ${d.name.text}: value type not writable`); continue; }
        edits.push({ start: d.name.getEnd(), end: d.name.getEnd(), text: `: Record<string, ${t.text}>`, kind: 'var', type: `Record<string, ${t.text}>`, host: d.parent.parent.getStart(sf) });
        for (const l of t.local) imports.set(l[0], l[1]);
        report.push(`lookup ${d.name.text}: Record<string, ${t.text}>`);
    }
    for (const c of catches) {
        const v = c.variableDeclaration.name; const sym = checker.getSymbolAtLocation(v); if (!sym) continue;
        for (const r of refsIn(c.block, sym)) {
            const p = r.parent;
            if (ts.isPropertyAccessExpression(p) && p.expression === r && /^(message|name|stack)$/.test(p.name.text)) {
                edits.push({ start: r.getStart(sf), end: r.getStart(sf), text: '(', kind: 'castOpen', type: 'Error' });
                edits.push({ start: r.getEnd(), end: r.getEnd(), text: ' as Error)', kind: 'castClose', type: 'Error' });
            }
        }
    }
    for (const d of lets) {
        const sym = checker.getSymbolAtLocation(d.name); if (!sym) continue;
        let scope = d; while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
        const types = [];
        for (const r of refsIn(scope, sym)) {
            const p = r.parent;
            if (ts.isBinaryExpression(p) && p.left === r && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) types.push(checker.getTypeAtLocation(p.right));
        }
        const useful = types.filter((t) => !(t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Null | ts.TypeFlags.Undefined)));
        if (!useful.length) continue;
        if (d.initializer) useful.push(checker.getNullType());
        const t = unionText(ts, checker, useful, d, abs, imports);
        if (!t) continue;
        edits.push({ start: d.name.getEnd(), end: d.name.getEnd(), text: `: ${t.text}`, kind: 'var', type: t.text, host: d.parent.parent.getStart(sf) });
        for (const l of t.local) imports.set(l[0], l[1]);
        report.push(`let ${d.name.text}: ${t.text}`);
    }
    // `const out = []; out.push(x)`: TypeScript gives the empty literal `never[]`
    // (`any[]` without strictNullChecks, TS7034). T is what goes in: the arguments
    // of push/unshift, what is assigned by index, and whole reassignments.
    for (const d of arrays) {
        const sym = checker.getSymbolAtLocation(d.name); if (!sym) continue;
        let scope = d; while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
        const types = []; let spreadIn = false;
        for (const r of refsIn(scope, sym)) {
            if (r === d.name) continue;
            const p = r.parent;
            if (ts.isPropertyAccessExpression(p) && p.expression === r && /^(push|unshift)$/.test(p.name.text) && ts.isCallExpression(p.parent) && p.parent.expression === p) {
                for (const a of p.parent.arguments) {
                    if (ts.isSpreadElement(a)) { const at = checker.getTypeAtLocation(a.expression); const el = checker.getIndexTypeOfType ? checker.getIndexTypeOfType(at, ts.IndexKind.Number) : null; if (el) types.push(el); else spreadIn = true; } else types.push(checker.getTypeAtLocation(a));
                }
            } else if (ts.isElementAccessExpression(p) && p.expression === r && ts.isBinaryExpression(p.parent) && p.parent.left === p && p.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                types.push(checker.getTypeAtLocation(p.parent.right));
            } else if (ts.isBinaryExpression(p) && p.left === r && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
                const at = checker.getTypeAtLocation(p.right); const el = checker.getIndexTypeOfType ? checker.getIndexTypeOfType(at, ts.IndexKind.Number) : null;
                if (el) types.push(el); else spreadIn = true;
            }
        }
        if (spreadIn || !types.length) continue;
        // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- dev-only converter run by hand on our own source files, no user input
        const t = unionText(ts, checker, types, d, abs, imports);
        if (!t) { report.push(`array ${d.name.text}: element type not writable [${unionText.why}]`); continue; }
        const text = /[|&]/.test(t.text) && !/^\(.*\)$/.test(t.text) ? `(${t.text})[]` : `${t.text}[]`;
        edits.push({ start: d.name.getEnd(), end: d.name.getEnd(), text: `: ${text}`, kind: 'var', type: text, host: d.parent.parent.getStart(sf) });
        for (const l of t.local) imports.set(l[0], l[1]);
        report.push(`array ${d.name.text}: ${text}`);
    }
}

/**
 * True when the body treats `nameNode`'s value as possibly absent: `x?.y`,
 * `x ?? d`, `x || d`, `if (x)`, `if (!x)`, `x && ...`, `x ? : `, `typeof x`,
 * `x == null`, `x === undefined`. Such a prop is optional even when every
 * typed caller happens to pass it (the first wave's biggest error class was
 * props declared required that callers leave out).
 */
export function guardedInBody(ts, service, program, checker, nameNode) {
    for (const { node } of refsOf(ts, service, program, nameNode)) {
        let n = node; while (n.parent && ts.isParenthesizedExpression(n.parent)) n = n.parent;
        const p = n.parent; if (!p) continue;
        if (ts.isPropertyAccessExpression(p) && p.expression === n && p.questionDotToken) return true;
        if (ts.isCallExpression(p) && p.expression === n && p.questionDotToken) return true;
        if (ts.isBinaryExpression(p)) {
            const k = p.operatorToken.kind;
            if (p.left === n && (k === ts.SyntaxKind.QuestionQuestionToken || k === ts.SyntaxKind.BarBarToken || k === ts.SyntaxKind.AmpersandAmpersandToken)) return true;
            if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(k)) {
                const other = p.left === n ? p.right : p.left;
                if (other.kind === ts.SyntaxKind.NullKeyword || ts.isIdentifier(other) && other.text === 'undefined') return true;
            }
        }
        if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
        if (ts.isIfStatement(p) && p.expression === n) return true;
        if (ts.isConditionalExpression(p) && p.condition === n) return true;
        if (ts.isTypeOfExpression(p)) return true;
    }
    return false;
}

/** Edits for one file: [{ start, end, text }]; plus imports to add. */
export function inferFile(ts, service, abs, observed = null, banned = new Set()) {
    const program = service.getProgram(); const checker = program.getTypeChecker();
    const sf = program.getSourceFile(abs); if (!sf) return { edits: [], report: [] };
    const edits = []; const report = []; const imports = new Map(); const chosen = [];
    // Types this file declares: TypeScript declarations, and in JavaScript the JSDoc typedefs.
    const declared = jsdocTypedefNames(sf.text);
    sf.forEachChild((s) => { if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) declared.add(s.name.text); });
    const fns = [];
    const visit = (n) => {
        if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isMethodDeclaration(n)) && n.parameters.some((p) => !hasDeclaredType(ts, p))) fns.push(n);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    const have0 = new Set(declared);
    sf.forEachChild((st) => { if ((ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) have0.add(st.name.text); });
    const named = namedFor(ts, program, sf, abs, imports, have0);
    const fkeys = functionKeys(ts, sf);
    const allowed = (slot, source) => !banned.has(`${slot}|${source}`);
    inferHooks(ts, service, program, checker, sf, abs, report, edits, imports, observed, named, { fkeys, allowed, chosen });
    inferExpandos(ts, checker, sf, abs, imports, edits, report);
    inferLearned(ts, checker, sf, abs, imports, edits, report);
    for (const fn of fns) {
        const nameNode = nameNodeOf(ts, fn);
        if (!nameNode) continue; // inline callbacks: contextually typed, or the codefix pass takes them
        const fname = nameNode.text;
        const refs = referencesOf(ts, service, program, nameNode);
        const { sites, opaque } = sitesOf(ts, checker, refs);
        // Call sites count only when every use was understood; otherwise the
        // consumers (what the body hands the value to) are the only source.
        const usable = sites.length > 0 && !opaque;
        if (!usable) report.push(`${fname}: ${sites.length ? `${opaque} opaque use(s)` : 'no typed call site'}`);
        const local = [];
        const first = fn.parameters[0];
        const isComponent = /^[A-Z]/.test(fname) && !ts.isConstructorDeclaration(fn) && !ts.isMethodDeclaration(fn) && first && !hasDeclaredType(ts, first) && ts.isObjectBindingPattern(first.name) && (!usable || sites.every((s) => s.kind === 'jsx'));
        // A function taking one options object (`useData({ user, onError })`,
        // `span({ dx } = {})`) is typed the same way: an interface per binding.
        const isOptions = !isComponent && first && !hasDeclaredType(ts, first) && ts.isObjectBindingPattern(first.name);
        if (isOptions && usable && sites.every((s) => s.kind === 'args')) {
            for (const site of sites) {
                const t0 = site.types[0]; const n0 = site.nodes && site.nodes[0];
                site.kind = 'jsx'; site.attrs = new Map(); site.children = false; site.explicit = new Set();
                if (!t0 || t0.flags & ts.TypeFlags.Any) { site.opaque = true; continue; }
                for (const prop of checker.getNonNullableType(t0).getProperties()) {
                    site.attrs.set(prop.name, checker.getTypeOfSymbolAtLocation(prop, first));
                    // Only the keys an object literal spells out count as "passed" members
                    // the function should declare; a typed variable carries its whole shape.
                    if (n0 && ts.isObjectLiteralExpression(n0)) site.explicit.add(prop.name);
                }
            }
        }
        if (isComponent || isOptions && (!usable || sites.every((s) => s.kind === 'jsx' && !s.opaque))) {
            const lines = []; const open = [];
            let ok = true;
            const declaredKeys = new Set();
            for (const el of first.name.elements) {
                if (el.dotDotDotToken || !ts.isIdentifier(el.name)) { ok = false; break; }
                const key = (el.propertyName || el.name).getText(sf);
                if (!/^[A-Za-z_$][\w$]*$/.test(key)) { ok = false; break; }
                declaredKeys.add(key);
                const hasDefault = !!el.initializer;
                const slot = `${fkeys.get(fn)}|.${key}`;
                let missing = hasDefault; const types = []; let children = false; let source = 'call';
                if (usable) for (const s of sites) {
                    if (key === 'children' && s.children) { children = true; continue; }
                    // `x={undefined}` is a way of leaving a prop out.
                    if (s.attrs.has(key) && !(s.attrs.get(key).flags & ts.TypeFlags.Undefined)) types.push(s.attrs.get(key)); else missing = true;
                }
                // The body guards it (`x?.`, `x || d`, `if (x)`): it may be absent whatever the callers do.
                if (!missing && guardedInBody(ts, service, program, checker, el.name)) missing = true;
                if (key === 'children' && (children || !usable)) { lines.push(`    children${missing || !children ? '?' : ''}: React.ReactNode;`); continue; }
                if (hasDefault) types.push(checker.getTypeAtLocation(el.initializer));
                let t = types.length && allowed(slot, 'call') ? literalContract(ts, service, program, checker, el.name, types, fn, abs, imports) || unionText(ts, checker, types, fn, abs, imports) : null;
                if (t && /^(null|undefined)( \| (null|undefined))?$/.test(t.text)) t = null;
                if (!t && allowed(slot, 'demand')) {
                    const c = mostSpecific(ts, checker, consumerTypes(ts, service, program, checker, el.name));
                    if (c) t = demandText(unionText(ts, checker, [c], fn, abs, imports));
                    if (t) source = 'demand';
                }
                if (!t && allowed(slot, 'callee')) {
                    const c = calleeShape(ts, service, program, checker, el.name, fn, abs, imports);
                    if (c) { t = c; source = 'callee'; if (c.optional) missing = true; }
                }
                if (!t && allowed(slot, 'observed')) {
                    const o = observedText(observed, fkeys.get(fn), `.${key}`, named);
                    if (o) { t = o; source = 'observed'; if (o.optional) missing = true; }
                }
                if (t) chosen.push({ slot, source });
                if (!t) { open.push(`${key}${unionText.why ? ` [${unionText.why}]` : ''}`); unionText.why = ''; continue; }
                local.push(...t.local);
                lines.push(`    ${key}${missing ? '?' : ''}: ${t.text};`);
            }
            if (!ok) { report.push(`${fname}: props not a plain destructure`); continue; }
            // A prop a caller spells out that the destructure does not name is part of
            // the contract too (`<Row id={x} />` while Row reads `props.id` elsewhere, or
            // ignores it): declared optional, so no agent has to delete it at the call site.
            let extra = 0;
            if (usable && ok) {
                const passed = new Map();
                for (const s of sites) for (const k of s.explicit || []) if (!declaredKeys.has(k) && k !== 'children' && k !== 'key' && k !== 'ref' && IDENT_RE.test(k) && s.attrs.has(k)) (passed.get(k) || passed.set(k, []).get(k)).push(s.attrs.get(k));
                for (const [k, ts_] of passed) {
                    const t = unionText(ts, checker, ts_.filter((x) => !(x.flags & ts.TypeFlags.Undefined)), fn, abs, imports);
                    if (!t) continue;
                    local.push(...t.local); lines.push(`    ${k}?: ${t.text};`); extra++;
                }
            }
            if (!lines.length) { report.push(`${fname}: no prop typed (${open.join(', ')})`); continue; }
            const iname = isComponent ? `${fname}Props` : `${fname[0].toUpperCase()}${fname.slice(1)}Args`;
            // `({ a } = {})`: the whole object may be left out, so every member is optional.
            if (first.initializer) for (let k = 0; k < lines.length; k++) lines[k] = lines[k].replace(/^(\s+[\w$]+)(\??):/, '$1?:');
            if (declared.has(iname)) { report.push(`${fname}: ${iname} exists`); continue; }
            declared.add(iname);
            let stmt = fn; while (stmt.parent && stmt.parent !== sf) stmt = stmt.parent;
            const at = stmt.getStart(sf);
            // Props the tooling could not type stay out: the destructure then
            // names them as errors, which is the to-do list for the next step.
            // Component props stay an `interface`; a plain options object is a `type`
            // alias, whose implicit index signature lets it be passed where a
            // `Record<string, unknown>` or a looser shape is expected.
            const decl = isComponent ? `interface ${iname} {\n${lines.join('\n')}\n}\n\n` : `type ${iname} = {\n${lines.join('\n')}\n};\n\n`;
            edits.push({ start: at, end: at, text: decl, kind: 'interface', name: iname, members: lines.map((l) => { const m = l.match(/^\s+([\w$]+)(\??): (.*);$/); return { key: m[1], optional: !!m[2], type: m[3] }; }) });
            edits.push({ start: first.name.getEnd(), end: first.name.getEnd(), text: `: ${iname}`, kind: 'param', name: null, index: 0, optional: !!first.initializer, type: iname, host: jsdocHost(ts, fn).getStart(sf) });
            if (lines.some((l) => l.includes('React.'))) local.push(['React', null]);
            for (const l of local) imports.set(l[0], l[1]);
            report.push(`${fname}: props typed ${lines.length - extra}/${lines.length - extra + open.length}${extra ? `, ${extra} passed but not destructured` : ''}${open.length ? ` (open: ${open.join(', ')})` : ''}`);
            continue;
        }
        // Plain function: per position, call sites first, then consumers.
        const posEdits = [];
        fn.parameters.forEach((p, i) => {
            if (hasDeclaredType(ts, p) || p.dotDotDotToken || !ts.isIdentifier(p.name)) return;
            const types = []; let missing = !!p.initializer || !!p.questionToken;
            const slot = `${fkeys.get(fn)}|#${i}`; let source = 'call';
            // A site that only hands the function on (onRowClick={fn}) gives the receiver's
            // expectation, a lower bound like any demand: it is checked as one.
            if (usable && sites.every((s) => s.kind === 'args') && sites.every((s) => s.contextual)) source = 'demand';
            if (usable && allowed(slot, source) && sites.every((s) => s.kind === 'args')) for (const s of sites) {
                // `fn(a, undefined)` leaves the parameter out as much as `fn(a)` does.
                if (i < s.types.length && s.types[i] && !(s.types[i].flags & ts.TypeFlags.Undefined)) types.push(s.types[i]);
                else if (!s.contextual) missing = true;
            }
            if (p.initializer) types.push(checker.getTypeAtLocation(p.initializer));
            let t = types.length ? literalContract(ts, service, program, checker, p.name, types, fn, abs, imports) || unionText(ts, checker, types, fn, abs, imports) : null;
            if (t && /^(null|undefined)( \| (null|undefined))?$/.test(t.text)) t = null;
            if (!t && allowed(slot, 'demand')) {
                const c = mostSpecific(ts, checker, consumerTypes(ts, service, program, checker, p.name));
                if (c) t = demandText(unionText(ts, checker, [c], fn, abs, imports));
                if (t) source = 'demand';
            }
            if (!t && allowed(slot, 'callee')) {
                const c = calleeShape(ts, service, program, checker, p.name, fn, abs, imports);
                if (c) { t = c.optional && !p.initializer ? { ...c, text: `(${c.text}) | undefined` } : c; source = 'callee'; }
            }
            if (!t && allowed(slot, 'observed')) {
                const o = observedText(observed, fkeys.get(fn), `#${i}`, named);
                // `x?:` is only legal when every later parameter is optional too.
                if (o) { t = o.optional && !p.initializer ? { ...o, text: `${o.text} | undefined` } : o; source = 'observed'; }
            }
            if (t) chosen.push({ slot, source });
            if (!t) { report.push(`${fname}#${i}: open`); return; }
            local.push(...t.local);
            const opt = missing && !p.initializer ? '?' : '';
            posEdits.push({ start: p.name.getEnd(), end: p.name.getEnd(), text: `${opt}: ${t.text}`, kind: 'param', name: p.name.text, index: i, optional: !!(opt || p.initializer), type: t.text, host: jsdocHost(ts, fn).getStart(sf), arrowParen: ts.isArrowFunction(fn) && fn.parameters.length === 1 && !fn.getChildren(sf).some((c) => c.kind === ts.SyntaxKind.OpenParenToken) ? p : null });
        });
        if (!posEdits.length) continue;
        for (const e of posEdits) {
            if (e.arrowParen) { // x => ... needs parentheses to take a type
                edits.push({ start: e.arrowParen.getStart(sf), end: e.arrowParen.getStart(sf), text: '(', kind: 'arrowParen' });
                edits.push({ ...e, text: `${e.text})` });
            } else edits.push(e);
        }
        for (const l of local) imports.set(l[0], l[1]);
        report.push(`${fname}: ${posEdits.length} parameter(s) typed`);
    }
    // Imports: `import type { X } from 'spec'` for types printed by module path.
    // A JavaScript file's `/** @typedef {import('x').T} T */` already imports T.
    const have = jsdocTypedefNames(sf.text);
    sf.forEachChild((s) => {
        if (ts.isImportDeclaration(s) && s.importClause) {
            const c = s.importClause; if (c.name) have.add(c.name.text);
            if (c.namedBindings && ts.isNamedImports(c.namedBindings)) c.namedBindings.elements.forEach((e) => have.add(e.name.text));
            if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) have.add(c.namedBindings.name.text);
        }
        if ((ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isClassDeclaration(s) || ts.isFunctionDeclaration(s)) && s.name) have.add(s.name.text);
    });
    const add = [];
    for (const [name, spec] of imports) {
        if (have.has(name)) continue;
        if (name === 'React' && spec === null) { add.push(`import type React from 'react';`); continue; }
        if (!spec) return { edits: [], chosen: [], report: [...report, `import for ${name} unknown: file refused`] };
        // One `import type` line per module, not per name.
        const same = add.findIndex((l) => l.endsWith(` from '${spec}';`) && l.startsWith('import type { '));
        if (same >= 0) add[same] = add[same].replace(/ \} from /, `, ${name} } from `);
        else add.push(`import type { ${name} } from '${spec}';`);
    }
    if (add.length) {
        const lastImport = [...sf.statements].reverse().find((s) => ts.isImportDeclaration(s));
        const at = lastImport ? lastImport.getEnd() : 0;
        edits.push({ start: at, end: at, text: (lastImport ? '\n' : '') + add.join('\n') + (lastImport ? '' : '\n'), kind: 'imports', imports: [...imports].filter(([name]) => !have.has(name)).map(([name, spec]) => [name, spec, genericImports.has(name)]) });
    }
    return { edits, report, chosen };
}

export function applyEdits(text, edits) {
    const sorted = [...edits].map((e, i) => ({ ...e, i })).sort((a, b) => b.start - a.start || b.i - a.i);
    let out = text;
    for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return out;
}
