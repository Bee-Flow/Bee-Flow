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
    while (n && ts.isCallExpression(n) && /^(React\.)?(memo|forwardRef)$/.test(n.expression.getText())) n = n.parent;
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

function referencesOf(ts, service, program, nameNode) {
    const out = [];
    const refs = service.findReferences(nameNode.getSourceFile().fileName, nameNode.getStart()) || [];
    for (const r of refs) for (const e of r.references) {
        if (e.isDefinition) continue;
        if (isTestOrJs(e.fileName)) continue;
        const sf = program.getSourceFile(e.fileName); if (!sf) continue;
        const node = findNode(ts, sf, e.textSpan.start);
        if (node) out.push(node);
    }
    return out;
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
    for (const fn of fns) {
        const nameNode = nameNodeOf(ts, fn);
        if (!nameNode) continue; // inline callbacks: contextually typed, or the codefix pass takes them
        const refs = referencesOf(ts, service, program, nameNode);
        const { sites, opaque } = sitesOf(ts, checker, refs);
        const fname = nameNode.text;
        if (!sites.length) { report.push(`${fname}: no typed call site`); continue; }
        if (opaque) { report.push(`${fname}: ${opaque} opaque use(s)`); continue; }
        const local = [];
        const first = fn.parameters[0];
        const isComponent = /^[A-Z]/.test(fname) && sites.some((s) => s.kind === 'jsx');
        if (isComponent && first && !first.type) {
            if (sites.some((s) => s.kind !== 'jsx')) { report.push(`${fname}: used as component and as function`); continue; }
            const names = [];
            let ok = true;
            if (ts.isObjectBindingPattern(first.name)) {
                for (const el of first.name.elements) {
                    if (el.dotDotDotToken) { ok = false; break; }
                    const key = (el.propertyName || el.name).getText();
                    if (!/^[A-Za-z_$][\w$]*$/.test(key)) { ok = false; break; }
                    names.push({ key, hasDefault: !!el.initializer, init: el.initializer });
                }
            } else ok = false;
            if (!ok) { report.push(`${fname}: props not a plain destructure`); continue; }
            const lines = [];
            for (const { key, hasDefault, init } of names) {
                const types = []; let missing = hasDefault;
                for (const s of sites) {
                    if (key === 'children' && s.children) { types.push(null); continue; }
                    if (s.attrs.has(key)) types.push(s.attrs.get(key)); else missing = true;
                }
                if (key === 'children' && types.includes(null)) { lines.push(`    children${missing ? '?' : ''}: React.ReactNode;`); continue; }
                if (hasDefault) types.push(checker.getTypeAtLocation(init));
                if (!types.length) { ok = false; report.push(`${fname}.${key}: never passed`); break; }
                const t = unionText(ts, checker, types, fn, abs, imports);
                if (!t) { ok = false; report.push(`${fname}.${key}: type not writable [${unionText.why}]`); break; }
                local.push(...t.local);
                lines.push(`    ${key}${missing ? '?' : ''}: ${t.text};`);
            }
            if (!ok) continue;
            if (fn.parameters.length > 1 && fn.parameters.slice(1).some((p) => !p.type)) { report.push(`${fname}: forwardRef ref untyped`); }
            let iname = `${fname}Props`;
            if (declared.has(iname)) { report.push(`${fname}: ${iname} exists`); continue; }
            declared.add(iname);
            let stmt = fn; while (stmt.parent && stmt.parent !== sf) stmt = stmt.parent;
            const indentStart = stmt.getStart(sf);
            edits.push({ start: indentStart, end: indentStart, text: `interface ${iname} {\n${lines.join('\n')}\n}\n\n`, interfaceFor: fname });
            edits.push({ start: first.name.getEnd(), end: first.name.getEnd(), text: `: ${iname}` });
            if (lines.some((l) => l.includes('React.'))) local.push(['React', null]);
            for (const l of local) imports.set(l[0], l[1]);
            report.push(`${fname}: props typed (${names.length})`);
            continue;
        }
        // Plain function: per position.
        const posEdits = []; let ok = true;
        fn.parameters.forEach((p, i) => {
            if (!ok || p.type) return;
            if (p.dotDotDotToken || !ts.isIdentifier(p.name)) { ok = false; report.push(`${fname}#${i}: rest/destructured`); return; }
            const types = []; let missing = !!p.initializer || !!p.questionToken;
            for (const s of sites) {
                if (s.kind !== 'args') { ok = false; return; }
                if (i < s.types.length && s.types[i]) types.push(s.types[i]);
                else if (!s.contextual) missing = true;
            }
            if (p.initializer) types.push(checker.getTypeAtLocation(p.initializer));
            if (!types.length) { ok = false; report.push(`${fname}#${i}: no argument seen`); return; }
            const t = unionText(ts, checker, types, fn, abs, imports);
            if (!t) { ok = false; report.push(`${fname}#${i}: type not writable [${unionText.why}]`); return; }
            local.push(...t.local);
            const opt = missing && !p.initializer ? '?' : '';
            // `x = 1` keeps its initializer: `x: number = 1`.
            posEdits.push({ start: p.name.getEnd(), end: p.name.getEnd(), text: `${opt}: ${t.text}`, arrowParen: ts.isArrowFunction(fn) && fn.parameters.length === 1 && !fn.getChildren(sf).some((c) => c.kind === ts.SyntaxKind.OpenParenToken) ? p : null });
        });
        if (!ok || !posEdits.length) continue;
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
