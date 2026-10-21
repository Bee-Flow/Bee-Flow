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

const MAX_TYPE = 140;

const isTestOrJs = (f) => /\.(test|spec)\.[jt]sx?$/.test(f) || /\.[cm]?jsx?$/.test(f) || /\/__tests__\/|\/test-utils?\/|\/testUtils\//.test(f);

function nameNodeOf(ts, fn) {
    if ((ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) && fn.name) return fn.name;
    let n = fn.parent;
    // memo(...), forwardRef(...), memo(forwardRef(...))
    while (n && ts.isCallExpression(n) && /^(React\.)?(memo|forwardRef|useCallback)$/.test(n.expression.getText())) n = n.parent;
    if (n && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name;
    if (n && ts.isExportAssignment(n)) return null;
    return null;
}

/** Return `{ node, text }` replacing `import("spec").Name` by `Name`, collecting the imports it needs. */
function printType(ts, checker, type, enclosing, file, imports) {
    const flags = ts.NodeBuilderFlags.NoTruncation | ts.NodeBuilderFlags.UseSingleQuotesForStringLiteralType
        | ts.NodeBuilderFlags.WriteArrayAsGenericType * 0 | ts.NodeBuilderFlags.IgnoreErrors * 0;
    const node = checker.typeToTypeNode(type, enclosing, flags);
    if (!node) return null;
    const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
    let text = printer.printNode(ts.EmitHint.Unspecified, node, enclosing.getSourceFile()).replace(/\s*\n\s*/g, ' ');
    const local = [];
    text = text.replace(/import\("([^"]+)"\)\.([A-Za-z_$][\w$]*)/g, (_, spec, name) => {
        let s = spec;
        if (path.isAbsolute(s)) {
            s = path.relative(path.dirname(file), s).replace(/\\/g, '/').replace(/\.(d\.)?[cm]?[jt]sx?$/, '').replace(/\/index$/, '');
            if (!s.startsWith('.')) s = `./${s}`;
        }
        local.push([name, s]);
        return name;
    });
    return { text, local };
}

/** The widened union of `types`, printed; null when it may not be written. */
function unionText(ts, checker, types, enclosing, file, imports) {
    // A call site that passes `any` (untyped code) says nothing: leave it out.
    const widened = types.filter((t) => !(t.flags & ts.TypeFlags.Any)).map((t) => checker.getWidenedType(checker.getBaseTypeOfLiteralType(t)));
    if (!widened.length) { unionText.why = 'only any at the call sites'; return null; }
    // A union of the call-site types; the checker dedupes and collapses subtypes.
    const u = widened.length === 1 ? widened[0] : checker.getUnionType ? checker.getUnionType(widened) : null;
    if (!u) return null;
    if (u.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) { unionText.why = checker.typeToString(u); return null; }
    const printed = printType(ts, checker, u, enclosing, file, imports);
    if (!printed) return null;
    const { text, local } = printed;
    if (/\bany\b|\bunknown\b|\bnever\b|import\(|typeof import|\.\.\.\s*args|\bthis\b/.test(text) || text.length > MAX_TYPE) { unionText.why = text.slice(0, 200); return null; }
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
    }
    refCache.set(key, out);
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
            const attrs = new Map(); let spread = false;
            for (const a of p.attributes.properties) {
                if (ts.isJsxSpreadAttribute(a)) {
                    spread = true;
                    for (const prop of checker.getTypeAtLocation(a.expression).getProperties()) attrs.set(prop.name, checker.getTypeOfSymbolAtLocation(prop, a.expression));
                    continue;
                }
                const name = a.name.getText();
                if (!a.initializer) { attrs.set(name, checker.getTrueType ? checker.getTrueType() : checker.getTypeAtLocation(a.name)); continue; }
                // label="x": the checker gives a JSX string attribute of an untyped component `any`.
                if (ts.isStringLiteral(a.initializer)) { attrs.set(name, checker.getStringType()); continue; }
                const expr = ts.isJsxExpression(a.initializer) ? a.initializer.expression : a.initializer;
                if (!expr) continue;
                attrs.set(name, checker.getTypeAtLocation(expr));
            }
            const children = ts.isJsxOpeningElement(p) && p.parent.children.some((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
            sites.push({ kind: 'jsx', attrs, spread, children });
            continue;
        }
        if (ts.isCallExpression(p) && p.expression === n) { sites.push({ kind: 'args', types: p.arguments.map((a) => (ts.isSpreadElement(a) ? null : checker.getTypeAtLocation(a))) }); continue; }
        if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isExportSpecifier(p) || ts.isExportAssignment(p) || ts.isShorthandPropertyAssignment(p) && false) continue;
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
        if (!first || first.type || !ts.isObjectBindingPattern(first.name)) return null;
        const key = p.parent.name.getText();
        const b = first.name.elements.find((e) => (e.propertyName || e.name).getText() === key);
        return b && ts.isIdentifier(b.name) ? b.name : null;
    }
    if (ts.isCallExpression(p) && p.expression !== n) {
        const fn = calleeFunction(ts, checker, p.expression);
        const i = p.arguments.indexOf(n);
        const prm = fn && i >= 0 && fn.parameters[i];
        return prm && !prm.type && !prm.dotDotDotToken && ts.isIdentifier(prm.name) ? prm.name : null;
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
function inferHooks(ts, service, program, checker, sf, abs, report, edits, imports) {
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
        if (!useful.length) {
            // Nothing typed goes in: what the value is handed to says what it must be.
            const holder = isState ? decl.name.elements[0] : decl.name;
            if (holder && ts.isBindingElement(holder) ? ts.isIdentifier(holder.name) : ts.isIdentifier(holder)) {
                const nn = ts.isBindingElement(holder) ? holder.name : holder;
                const demands = consumerTypes(ts, service, program, checker, nn);
                const c = mostSpecific(ts, checker, isState ? demands : demands.map((d) => refTarget(ts, checker, d, nn)).filter(Boolean));
                if (c && demandText({ text: checker.typeToString(c) })) useful = [isState ? checker.getNonNullableType(c) : c];
            }
        }
        if (!useful.length) { report.push(`${label}: nothing typed flows in`); continue; }
        const isNull = init && init.kind === ts.SyntaxKind.NullKeyword;
        if (isNull && isState) useful.push(checker.getNullType ? checker.getNullType() : checker.getTypeAtLocation(init));
        const t = unionText(ts, checker, useful, call, abs, imports);
        if (!t) { report.push(`${label}: type not writable [${unionText.why}]`); continue; }
        // useRef<HTMLDivElement>(null) is the React 19 RefObject<T | null>: no `| null` needed.
        const text = !isState && isNull ? t.text.replace(/\s*\|\s*null\b/g, '') : t.text;
        edits.push({ start: call.expression.getEnd(), end: call.expression.getEnd(), text: `<${text}>` });
        for (const l of t.local) imports.set(l[0], l[1]);
        report.push(`${label}: <${text}>`);
    }
}

/** Edits for one file: [{ start, end, text }]; plus imports to add. */
export function inferFile(ts, service, abs) {
    const program = service.getProgram(); const checker = program.getTypeChecker();
    const sf = program.getSourceFile(abs); if (!sf) return { edits: [], report: [] };
    const edits = []; const report = []; const imports = new Map();
    const declared = new Set();
    sf.forEachChild((s) => { if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) declared.add(s.name.text); });
    const fns = [];
    const visit = (n) => {
        if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parameters.some((p) => !p.type)) fns.push(n);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    inferHooks(ts, service, program, checker, sf, abs, report, edits, imports);
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
        const isComponent = /^[A-Z]/.test(fname) && first && !first.type && ts.isObjectBindingPattern(first.name) && (!usable || sites.every((s) => s.kind === 'jsx'));
        if (isComponent) {
            const lines = []; const open = [];
            let ok = true;
            for (const el of first.name.elements) {
                if (el.dotDotDotToken || !ts.isIdentifier(el.name)) { ok = false; break; }
                const key = (el.propertyName || el.name).getText(sf);
                if (!/^[A-Za-z_$][\w$]*$/.test(key)) { ok = false; break; }
                const hasDefault = !!el.initializer;
                let missing = hasDefault; const types = []; let children = false;
                if (usable) for (const s of sites) {
                    if (key === 'children' && s.children) { children = true; continue; }
                    if (s.attrs.has(key)) types.push(s.attrs.get(key)); else missing = true;
                }
                if (key === 'children' && (children || !usable)) { lines.push(`    children${missing || !children ? '?' : ''}: React.ReactNode;`); continue; }
                if (hasDefault) types.push(checker.getTypeAtLocation(el.initializer));
                let t = types.length ? unionText(ts, checker, types, fn, abs, imports) : null;
                if (t && /^(null|undefined)( \| (null|undefined))?$/.test(t.text)) t = null;
                if (!t) {
                    const c = mostSpecific(ts, checker, consumerTypes(ts, service, program, checker, el.name));
                    if (c) t = demandText(unionText(ts, checker, [c], fn, abs, imports));
                    if (t && !usable) missing = missing || false;
                }
                if (!t) { open.push(`${key}${unionText.why ? ` [${unionText.why}]` : ''}`); unionText.why = ''; continue; }
                local.push(...t.local);
                lines.push(`    ${key}${missing ? '?' : ''}: ${t.text};`);
            }
            if (!ok) { report.push(`${fname}: props not a plain destructure`); continue; }
            if (!lines.length) { report.push(`${fname}: no prop typed (${open.join(', ')})`); continue; }
            const iname = `${fname}Props`;
            if (declared.has(iname)) { report.push(`${fname}: ${iname} exists`); continue; }
            declared.add(iname);
            let stmt = fn; while (stmt.parent && stmt.parent !== sf) stmt = stmt.parent;
            const at = stmt.getStart(sf);
            // Props the tooling could not type stay out: the destructure then
            // names them as errors, which is the to-do list for the next step.
            edits.push({ start: at, end: at, text: `interface ${iname} {\n${lines.join('\n')}\n}\n\n` });
            edits.push({ start: first.name.getEnd(), end: first.name.getEnd(), text: `: ${iname}` });
            if (lines.some((l) => l.includes('React.'))) local.push(['React', null]);
            for (const l of local) imports.set(l[0], l[1]);
            report.push(`${fname}: props typed ${lines.length}/${lines.length + open.length}${open.length ? ` (open: ${open.join(', ')})` : ''}`);
            continue;
        }
        // Plain function: per position, call sites first, then consumers.
        const posEdits = [];
        fn.parameters.forEach((p, i) => {
            if (p.type || p.dotDotDotToken || !ts.isIdentifier(p.name)) return;
            const types = []; let missing = !!p.initializer || !!p.questionToken;
            if (usable && sites.every((s) => s.kind === 'args')) for (const s of sites) {
                if (i < s.types.length && s.types[i]) types.push(s.types[i]);
                else if (!s.contextual) missing = true;
            }
            if (p.initializer) types.push(checker.getTypeAtLocation(p.initializer));
            let t = types.length ? unionText(ts, checker, types, fn, abs, imports) : null;
            if (t && /^(null|undefined)( \| (null|undefined))?$/.test(t.text)) t = null;
            if (!t) {
                const c = mostSpecific(ts, checker, consumerTypes(ts, service, program, checker, p.name));
                if (c) t = demandText(unionText(ts, checker, [c], fn, abs, imports));
            }
            if (!t) { report.push(`${fname}#${i}: open`); return; }
            local.push(...t.local);
            const opt = missing && !p.initializer ? '?' : '';
            posEdits.push({ start: p.name.getEnd(), end: p.name.getEnd(), text: `${opt}: ${t.text}`, arrowParen: ts.isArrowFunction(fn) && fn.parameters.length === 1 && !fn.getChildren(sf).some((c) => c.kind === ts.SyntaxKind.OpenParenToken) ? p : null });
        });
        if (!posEdits.length) continue;
        for (const e of posEdits) {
            if (e.arrowParen) { // x => ... needs parentheses to take a type
                edits.push({ start: e.arrowParen.getStart(sf), end: e.arrowParen.getStart(sf), text: '(' });
                edits.push({ start: e.start, end: e.end, text: `${e.text})` });
            } else edits.push(e);
        }
        for (const l of local) imports.set(l[0], l[1]);
        report.push(`${fname}: ${posEdits.length} parameter(s) typed`);
    }
    // Imports: `import type { X } from 'spec'` for types printed by module path.
    const have = new Set();
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
        if (!spec) return { edits: [], report: [...report, `import for ${name} unknown: file refused`] };
        add.push(`import type { ${name} } from '${spec}';`);
    }
    if (add.length) {
        const lastImport = [...sf.statements].reverse().find((s) => ts.isImportDeclaration(s));
        const at = lastImport ? lastImport.getEnd() : 0;
        edits.push({ start: at, end: at, text: (lastImport ? '\n' : '') + add.join('\n') + (lastImport ? '' : '\n') });
    }
    return { edits, report };
}

export function applyEdits(text, edits) {
    const sorted = [...edits].map((e, i) => ({ ...e, i })).sort((a, b) => b.start - a.start || b.i - a.i);
    let out = text;
    for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
    return out;
}
