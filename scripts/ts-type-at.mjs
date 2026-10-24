#!/usr/bin/env node
// Ask the checker for a type, or for the best replacement of an explicit `any`,
// without reading the files around it.
//
//   node scripts/ts-type-at.mjs src/a.ts:12:7             type at line:col (1-based)
//   node scripts/ts-type-at.mjs src/a.ts --symbol api     every declaration named `api` in the file
//   node scripts/ts-type-at.mjs src/a.ts --anys           every explicit `any` with a replacement
//   node scripts/ts-type-at.mjs src/a.ts --deps-from-callsite UseFooOptions [--apply]
//   node scripts/ts-type-at.mjs --anys --files src/a.ts,src/b.ts   (or --list files.txt): ONE language service for all
//   options: --root <dir>  directory with the tsconfig.json (default agent-hub)
//            --no-verify   (--anys) skip the typecheck of each replacement (much faster)
//            --files a,b / --list f.txt   (--anys) several files in one run, one language service
//                          (a new service costs 10-20 s; reuse is what keeps a loop under the timeout)
//            --apply       (--deps-from-callsite) write the suggested interface into the file
//                          (not written when it adds diagnostics, unless --force)
//
// Type mode prints the checker's type (NoTruncation), the declaration site, and,
// when the value is (a field of) the result of a call, the `ReturnType<typeof fn>['key']`
// spelling when that is shorter than the printed type.
//
// --anys candidates, in order: the initializer's type (`const x: any = init`),
// inferFromUsage (the editor quick fix on the unannotated slot), the types the
// call sites pass (like ts-callsite-types), and for a cast `e as any` the type
// of `e` (the cast is removed). Each is checked: the replacement is written in
// memory and the diagnostics of the file and of every file referencing the slot
// are compared; `typechecks: true` means no NEW diagnostic. `best` is the first
// candidate that does not fail the check and is not overfit; `bestTypechecks` says
// whether that one was verified (true), failed (false) or not checked (null, --no-verify).
// A candidate gets `overfit` when it is an inline object literal type over 120
// characters, or a union where the declared type was a named type (the call sites
// show what happens to be passed, not what the slot should accept): prefer the
// named type, or write the type by hand.
//
// --deps-from-callsite: for an interface or type literal whose fields are `any`
// and whose object is built where the function taking it is called, prints each
// field's type as read from the call site(s), and a ready interface text. A field
// whose call-site type is overfit (see above) keeps its declared named type in the
// suggestion and carries an `overfit` note. --apply writes the interface into the
// file, hoists `import("x").N` types to `import type` lines and adds an
// `import type` for each `typeof useX` (found through the call site's imports).
//
// Output is JSON. The language service is TypeScript 6's (agent-hub devDependency);
// the typecheck that decides stays `npm run typecheck` (tsc 7).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createService } from './ts-convert-codefix.mjs';
import { loadTs } from './ts-fix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'agent-hub');
const FORMAT = { indentSize: 4, tabSize: 4, convertTabsToSpaces: true, semicolons: 'insert' };
const PREFS = { quotePreference: 'single', importModuleSpecifierPreference: 'relative' };
const isTest = (f) => /\.(test|spec)\.[cm]?[jt]sx?$|\/__tests__\/|\/test-utils?\/|\/testUtils\//.test(f);

/** One language service for `file` (or several files: use `focus` to work on each). */
export function openProject(ts, root, file) {
    const overrides = new Map();
    const list = (Array.isArray(file) ? file : [file]).map((f) => path.resolve(f));
    for (const abs of list) overrides.set(abs, fs.readFileSync(abs, 'utf8'));
    const svc = createService(ts, overrides, { configPath: path.join(root, 'tsconfig.json'), baseDir: root, includeTests: false });
    const abs = list[0];
    const ctx = { ts, root, svc, abs, overrides, original: overrides.get(abs) };
    ctx.rel = (f) => path.relative(root, f);
    return ctx;
}

/** The same service, aimed at another file given to openProject. */
export function focus(c, file) {
    const abs = path.resolve(file);
    if (!c.overrides.has(abs)) throw new Error(`${abs} was not given to openProject`);
    return { ...c, abs, original: c.overrides.get(abs) };
}

const program = (c) => c.svc.service.getProgram();
const checker = (c) => program(c).getTypeChecker();
const sourceOf = (c, f = c.abs) => program(c).getSourceFile(f);

function typeText(c, type, enclosing) {
    const { ts } = c;
    return checker(c).typeToString(type, enclosing, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseSingleQuotesForStringLiteralType);
}

const widen = (c, type) => checker(c).getBaseTypeOfLiteralType(type);
const lineCol = (sf, pos) => { const p = sf.getLineAndCharacterOfPosition(pos); return `${p.line + 1}:${p.character + 1}`; };

function at(c, node) {
    const sf = node.getSourceFile();
    return `${c.rel(sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
}

/** Innermost token (identifier, keyword, literal) containing `pos`. */
export function tokenAt(ts, sf, pos) {
    let found = sf;
    const visit = (n) => {
        if (pos >= n.getStart(sf) && pos < n.getEnd()) { found = n; ts.forEachChild(n, visit); }
    };
    ts.forEachChild(sf, visit);
    return found;
}

/** Text of an entity name usable after `typeof` (a, a.b), or null. */
function entityName(ts, e) {
    if (ts.isIdentifier(e)) return e.text;
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) { const l = entityName(ts, e.expression); return l && `${l}.${e.name.text}`; }
    return null;
}

/** `ReturnType<typeof fn>` plus key path when `node` is a call, or a (destructured) variable initialised by one. */
export function returnTypeAlt(c, node) {
    const { ts } = c;
    const chk = checker(c);
    const unwrap = (e) => { let awaited = false; while (e && (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))) { if (ts.isAwaitExpression(e)) awaited = true; e = e.expression; } return { e, awaited }; };
    const fromCall = (init, keys) => {
        const { e, awaited } = unwrap(init);
        if (!e || !ts.isCallExpression(e)) return null;
        const name = entityName(ts, e.expression);
        if (!name) return null;
        // A generic or overloaded callee has no single return type to name.
        const sym = chk.getSymbolAtLocation(ts.isPropertyAccessExpression(e.expression) ? e.expression.name : e.expression);
        const target = sym && sym.flags & ts.SymbolFlags.Alias ? chk.getAliasedSymbol(sym) : sym;
        const decls = (target?.declarations || []).filter((d) => ts.isFunctionLike(d) || ts.isVariableDeclaration(d));
        if (decls.length !== 1) return null;
        const d = decls[0];
        const fn = ts.isVariableDeclaration(d) ? d.initializer : d;
        if (!fn || !ts.isFunctionLike(fn) || (fn.typeParameters && fn.typeParameters.length)) return null;
        let t = `ReturnType<typeof ${name}>`;
        if (awaited) t = `Awaited<${t}>`;
        for (const k of keys) t += /^[A-Za-z_$][\w$]*$/.test(k) ? `[${JSON.stringify(k).replace(/"/g, "'")}]` : `[${JSON.stringify(k)}]`;
        return { callee: name, expression: t };
    };
    if (ts.isCallExpression(node) || ts.isAwaitExpression(node)) return fromCall(node, []);
    const sym = node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ? chk.getShorthandAssignmentValueSymbol(node.parent) : chk.getSymbolAtLocation(node);
    const decl = sym?.declarations?.[0];
    if (!decl) return null;
    if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isIdentifier(decl.name)) {
        const r = fromCall(decl.initializer, []);
        if (r) return r;
    }
    if (ts.isBindingElement(decl)) {
        const keys = [];
        let n = decl;
        while (n && ts.isBindingElement(n)) {
            if (n.dotDotDotToken || ts.isArrayBindingPattern(n.parent)) return null;
            keys.unshift(n.propertyName ? (ts.isIdentifier(n.propertyName) || ts.isStringLiteral(n.propertyName) ? n.propertyName.text : null) : n.name.text);
            if (keys[0] === null) return null;
            n = n.parent.parent;
        }
        if (n && ts.isVariableDeclaration(n) && n.initializer) return fromCall(n.initializer, keys);
    }
    // x.key where x was initialised by a call
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const xs = chk.getSymbolAtLocation(node.expression)?.declarations?.[0];
        if (xs && ts.isVariableDeclaration(xs) && xs.initializer) return fromCall(xs.initializer, [node.name.text]);
    }
    return null;
}

function describeNode(c, node) {
    const { ts } = c;
    const chk = checker(c);
    const type = chk.getTypeAtLocation(node);
    const printed = typeText(c, type, node);
    let sym = chk.getSymbolAtLocation(node);
    if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = chk.getAliasedSymbol(sym); } catch { /* keep alias */ } }
    const decl = sym?.valueDeclaration || sym?.declarations?.[0];
    const out = { text: node.getText().slice(0, 80), type: printed, declaredAt: decl ? at(c, decl) : null, kind: ts.SyntaxKind[node.kind] };
    const alt = returnTypeAlt(c, node);
    if (alt) { out.from = alt.callee; out.returnTypeForm = alt.expression; out.useReturnType = alt.expression.length < printed.length; }
    return out;
}

// ---------------------------------------------------------------- type mode

export function typeAtPosition(c, line, col) {
    const sf = sourceOf(c);
    const pos = sf.getPositionOfLineAndCharacter(line - 1, col - 1);
    let node = tokenAt(c.ts, sf, pos);
    if (node === sf) return { error: 'no token at that position' };
    const { ts } = c;
    // Climb to the expression the token names: x in x.key stays x, key becomes x.key.
    if (ts.isIdentifier(node) && node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) node = node.parent;
    return { file: c.rel(c.abs), position: `${line}:${col}`, ...describeNode(c, node) };
}

const DECL_KINDS = (ts) => [ts.isVariableDeclaration, ts.isParameter, ts.isFunctionDeclaration, ts.isClassDeclaration, ts.isInterfaceDeclaration, ts.isTypeAliasDeclaration, ts.isPropertySignature, ts.isPropertyDeclaration, ts.isBindingElement, ts.isMethodDeclaration, ts.isEnumDeclaration, ts.isMethodSignature];

export function typeOfSymbol(c, name) {
    const { ts } = c;
    const sf = sourceOf(c);
    const kinds = DECL_KINDS(ts);
    const out = [];
    const visit = (n) => {
        if (kinds.some((k) => k(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === name) out.push({ line: sf.getLineAndCharacterOfPosition(n.name.getStart(sf)).line + 1, ...describeNode(c, n.name) });
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return { file: c.rel(c.abs), symbol: name, declarations: out };
}

// ---------------------------------------------------------------- references and diagnostics

function referenceNodes(c, nameNode) {
    const { svc } = c;
    const refs = svc.service.findReferences(c.abs, nameNode.getStart()) || [];
    const out = [];
    for (const group of refs) {
        for (const r of group.references) {
            if (isTest(r.fileName) || r.fileName.includes('/node_modules/')) continue;
            const sf = program(c).getSourceFile(r.fileName);
            if (!sf) continue;
            const node = tokenAt(c.ts, sf, r.textSpan.start);
            out.push({ node, def: !!r.isDefinition, file: r.fileName });
        }
    }
    return out;
}

function diagKeys(c, files) {
    const keys = new Map();
    for (const f of files) {
        for (const d of [...c.svc.service.getSyntacticDiagnostics(f), ...c.svc.service.getSemanticDiagnostics(f)]) {
            const k = `${c.rel(f)}|${d.code}|${c.ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
            keys.set(k, (keys.get(k) || 0) + 1);
        }
    }
    return keys;
}

const newKeys = (before, after) => [...after].filter(([k, n]) => n > (before.get(k) || 0)).map(([k]) => k.split('|').slice(1).join(' '));

/** Try `edit` ({start,end,text} in c.abs) in memory; return the new diagnostics in `files`, restore afterwards. */
function tryEdit(c, edit, files, baseline) {
    const text = c.original;
    c.svc.update(c.abs, text.slice(0, edit.start) + edit.text + text.slice(edit.end));
    try { return newKeys(baseline, diagKeys(c, files)); } finally { c.svc.update(c.abs, text); }
}

// ---------------------------------------------------------------- --anys

function slotOfAny(ts, a) {
    const p = a.parent;
    if (!p) return { kind: 'nested' };
    if (ts.isParameter(p) && p.type === a) return { kind: 'parameter', decl: p, name: p.name };
    if (ts.isVariableDeclaration(p) && p.type === a) return { kind: 'variable', decl: p, name: p.name };
    if ((ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) && p.type === a) return { kind: 'property', decl: p, name: p.name };
    if (ts.isFunctionLike(p) && p.type === a) return { kind: 'return', decl: p, name: p.name };
    if (ts.isAsExpression(p) && p.type === a) return { kind: 'cast', decl: p };
    if (ts.isTypeAssertionExpression(p) && p.type === a) return { kind: 'cast', decl: p };
    // any inside Promise<any>, any[], unions, function types: name the slot it sits in.
    for (let n = p; n; n = n.parent) {
        if (ts.isParameter(n) || ts.isVariableDeclaration(n) || ts.isPropertySignature(n) || ts.isPropertyDeclaration(n)) return { kind: 'nested', in: n.name?.getText?.() };
        if (ts.isFunctionLike(n)) return { kind: 'nested', in: `${n.name?.getText?.() ?? 'function'} (return/signature)` };
        if (ts.isStatement(n)) break;
    }
    return { kind: 'nested' };
}

/** Annotation `: any` range (colon included) for a slot, to remove it. */
function annotationRange(ts, sf, slot) {
    const t = slot.decl.type;
    const end = t.getEnd();
    let start = t.getStart(sf);
    const text = sf.text;
    while (start > 0 && /\s/.test(text[start - 1])) start--;
    if (text[start - 1] === ':') start--;
    return { start, end };
}

function inferFromUsageType(c, slot, sf) {
    const { ts, svc } = c;
    const nameNode = slot.name;
    if (!nameNode || !ts.isIdentifier(nameNode)) return null;
    const range = annotationRange(ts, sf, slot);
    svc.update(c.abs, c.original.slice(0, range.start) + c.original.slice(range.end));
    try {
        const sf2 = sourceOf(c);
        const start = nameNode.getStart(sf);
        const diags = [...svc.service.getSemanticDiagnostics(c.abs), ...svc.service.getSuggestionDiagnostics(c.abs)].filter((d) => d.start !== undefined && d.start >= start && d.start <= nameNode.getEnd());
        for (const d of diags) {
            let fixes;
            try { fixes = svc.service.getCodeFixesAtPosition(c.abs, d.start, d.start + d.length, [d.code], FORMAT, PREFS); } catch { continue; }
            const fix = fixes.find((f) => f.fixId === 'inferFromUsage');
            const ch = fix?.changes.flatMap((x) => x.textChanges)[0];
            if (ch && ch.newText.trim().startsWith(':')) return ch.newText.trim().replace(/^:\s*/, '');
        }
        // A return type and an evolving `let` have no fix: ask for the plain inferred type.
        void sf2;
        return null;
    } finally { svc.update(c.abs, c.original); }
}

function inferredWithoutAnnotation(c, slot, sf) {
    const { ts, svc } = c;
    const range = annotationRange(ts, sf, slot);
    svc.update(c.abs, c.original.slice(0, range.start) + c.original.slice(range.end));
    try {
        const sf2 = sourceOf(c);
        const chk = checker(c);
        if (slot.kind === 'return') {
            const fn = tokenAt(ts, sf2, slot.decl.getStart(sf));
            for (let n = fn; n; n = n.parent) if (ts.isFunctionLike(n) && n.getStart(sf2) === slot.decl.getStart(sf)) { const sig = chk.getSignatureFromDeclaration(n); return sig ? typeText(c, chk.getReturnTypeOfSignature(sig), n) : null; }
            return null;
        }
        const tok = tokenAt(ts, sf2, slot.name.getStart(sf));
        const t = chk.getTypeAtLocation(tok);
        return typeText(c, widen(c, t), tok);
    } finally { svc.update(c.abs, c.original); }
}

function callSiteTypes(c, fnNode, index) {
    const { ts } = c;
    const chk = checker(c);
    let nameNode = fnNode.name;
    if (!nameNode && fnNode.parent && ts.isVariableDeclaration(fnNode.parent)) nameNode = fnNode.parent.name;
    if (!nameNode || !ts.isIdentifier(nameNode)) return null;
    const seen = new Map();
    let sites = 0;
    for (const r of referenceNodes(c, nameNode)) {
        if (r.def) continue;
        const call = r.node.parent;
        if (!call || !ts.isCallExpression(call) || call.expression !== r.node) continue;
        sites++;
        const arg = call.arguments[index];
        if (!arg) { seen.set('undefined', true); continue; }
        const t = widen(c, chk.getTypeAtLocation(arg));
        const s = typeText(c, t, arg);
        if (s === 'any' || /\bany\b/.test(s)) continue;
        seen.set(s, true);
    }
    if (!sites) return null;
    const list = [...seen.keys()];
    return list.length ? { types: list, sites } : null;
}

const OVERFIT_LENGTH = 120;
const isNamedType = (t) => /^[A-Za-z_$][\w$.]*(<.*>)?(\[\])?$/s.test(t.trim()) && !/^(any|unknown|string|number|boolean|object|void|null|undefined|never)$/.test(t.trim());

/** Top-level `|` in a type text (not inside brackets, braces or generics). */
function hasTopLevelUnion(t) {
    let depth = 0;
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if ('{[(<'.includes(ch)) depth++;
        else if ('}])'.includes(ch)) depth--;
        else if (ch === '>' && t[i - 1] !== '=') depth--;
        else if (ch === '|' && depth === 0) return true;
    }
    return false;
}

/** Why a suggested type is probably the call site's accident, not the slot's contract; null when fine. */
export function overfitReason(replacement, declared) {
    const r = replacement.trim();
    if (/^\{/.test(r) && r.length > OVERFIT_LENGTH) return `inline object type of ${r.length} characters (over ${OVERFIT_LENGTH}): it describes what the call site passes; name a type instead`;
    if (declared && isNamedType(declared) && hasTopLevelUnion(r)) return `a union where the declared type is the named ${declared.trim()}: prefer the named type`;
    return null;
}

export function analyseAnys(c, { verify = true } = {}) {
    const { ts } = c;
    const sf = sourceOf(c);
    const anys = [];
    const visit = (n) => { if (n.kind === ts.SyntaxKind.AnyKeyword) anys.push(n); ts.forEachChild(n, visit); };
    visit(sf);
    const depsCache = new Map();
    const results = [];
    for (const a of anys) {
        const slot = slotOfAny(ts, a);
        const entry = { line: sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1, kind: slot.kind, context: (slot.decl ? slot.decl.getText(sf) : a.parent.getText(sf)).replace(/\s+/g, ' ').slice(0, 100) };
        if (slot.in) entry.in = slot.in;
        const cands = [];
        if (slot.kind === 'cast') {
            const inner = slot.decl.expression;
            const t = checker(c).getTypeAtLocation(inner);
            const s = typeText(c, t, inner);
            // The whole cast goes away: `e as any` -> `e`.
            if (s !== 'any') cands.push({ source: 'cast operand', replacement: s, edit: { start: slot.decl.getStart(sf), end: slot.decl.getEnd(), text: inner.getText(sf) }, note: `remove the cast; \`${inner.getText(sf).slice(0, 40)}\` is ${s}` });
        } else if (slot.kind === 'variable' || slot.kind === 'parameter' || slot.kind === 'return' || slot.kind === 'property') {
            const aEdit = (s) => ({ start: a.getStart(sf), end: a.getEnd(), text: s });
            if (slot.kind === 'variable' && slot.decl.initializer) {
                const s = inferredWithoutAnnotation(c, slot, sf);
                if (s && s !== 'any') cands.push({ source: 'initializer', replacement: s, edit: aEdit(s) });
            }
            if (slot.kind === 'return') {
                const s = inferredWithoutAnnotation(c, slot, sf);
                if (s && s !== 'any') cands.push({ source: 'inferred return', replacement: s, edit: aEdit(s) });
            }
            if (slot.kind === 'parameter' || (slot.kind === 'variable' && !slot.decl.initializer)) {
                const u = inferFromUsageType(c, slot, sf);
                if (u && !/\bany\b/.test(u)) cands.push({ source: 'inferFromUsage', replacement: u, edit: aEdit(u) });
            }
            if (slot.kind === 'parameter' && ts.isFunctionLike(slot.decl.parent)) {
                const idx = slot.decl.parent.parameters.indexOf(slot.decl);
                const cs = callSiteTypes(c, slot.decl.parent, idx);
                if (cs) { const s = cs.types.length === 1 ? cs.types[0] : cs.types.join(' | '); cands.push({ source: `call sites (${cs.sites})`, replacement: s, edit: aEdit(s) }); }
            }
            if (slot.kind === 'property' && ts.isPropertySignature(slot.decl) && ts.isIdentifier(slot.name)) {
                const owner = slot.decl.parent;
                const oname = ts.isInterfaceDeclaration(owner) ? owner.name.text : ts.isTypeLiteralNode(owner) && ts.isTypeAliasDeclaration(owner.parent) ? owner.parent.name.text : null;
                if (oname) {
                    if (!depsCache.has(oname)) depsCache.set(oname, depsFromCallsite(c, oname));
                    const f = depsCache.get(oname).fields?.find((x) => x.name === slot.name.text);
                    if (f?.fromCallSite && f.fromCallSite !== 'any') cands.push({ source: depsCache.get(oname).exactlyOne ? 'the one call site' : `call sites (${depsCache.get(oname).callSites.length})`, replacement: f.fromCallSite, edit: aEdit(f.fromCallSite) });
                }
            }
        }
        // An any inside a function-typed or generic field (`cb: (x: any) => Promise<any>`): offer the whole field type from the call site.
        if (!cands.length && (slot.kind === 'nested' || slot.kind === 'parameter' || slot.kind === 'return')) {
            let ps = a.parent;
            while (ps && !ts.isPropertySignature(ps)) ps = ps.parent;
            const owner = ps?.parent;
            const oname = owner && (ts.isInterfaceDeclaration(owner) ? owner.name.text : ts.isTypeLiteralNode(owner) && ts.isTypeAliasDeclaration(owner.parent) ? owner.parent.name.text : null);
            if (oname && ps.type && ts.isIdentifier(ps.name)) {
                if (!depsCache.has(oname)) depsCache.set(oname, depsFromCallsite(c, oname));
                const f = depsCache.get(oname).fields?.find((x) => x.name === ps.name.text);
                if (f?.fromCallSite && !/\bany\b/.test(f.fromCallSite)) cands.push({ source: 'call site, whole field type', replacement: f.shortForm || f.fromCallSite, declared: ps.type.getText(sf), edit: { start: ps.type.getStart(sf), end: ps.type.getEnd(), text: f.fromCallSite } });
            }
        }
        if (!cands.length && slot.kind === 'nested') entry.note = 'any nested in a larger type; type the whole slot by hand';
        if (cands.length && verify) {
            const files = new Set([c.abs]);
            if (slot.name && slot.kind !== 'cast') for (const r of referenceNodes(c, slot.name)) files.add(r.file);
            if (slot.kind === 'return' && slot.decl.name) for (const r of referenceNodes(c, slot.decl.name)) files.add(r.file);
            const base = diagKeys(c, files);
            for (const cand of cands) {
                const errs = tryEdit(c, cand.edit, files, base);
                cand.typechecks = errs.length === 0;
                if (errs.length) cand.newErrors = errs.slice(0, 3);
            }
        }
        for (const cand of cands) {
            const why = overfitReason(cand.replacement, cand.declared);
            if (why) cand.overfit = why;
        }
        entry.candidates = cands.map(({ edit, declared, ...rest }) => rest);
        const usable = entry.candidates.filter((x) => x.typechecks !== false);
        const bestCand = usable.find((x) => !x.overfit) ?? usable[0];
        entry.best = bestCand?.replacement ?? null;
        if (bestCand) entry.bestTypechecks = bestCand.typechecks ?? null;
        if (bestCand?.overfit) entry.bestOverfit = bestCand.overfit;
        results.push(entry);
    }
    const summary = { total: results.length, withReplacement: results.filter((r) => r.best).length };
    return { file: c.rel(c.abs), summary, anys: results };
}

// ---------------------------------------------------------------- --deps-from-callsite

function findNamedType(c, name) {
    const { ts } = c;
    const sf = sourceOf(c);
    let found = null;
    const visit = (n) => {
        if (found) return;
        if (ts.isInterfaceDeclaration(n) && n.name.text === name) found = { node: n, members: n.members };
        else if (ts.isTypeAliasDeclaration(n) && n.name.text === name && ts.isTypeLiteralNode(n.type)) found = { node: n, members: n.type.members };
        else ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
}

export function depsFromCallsite(c, name) {
    const { ts } = c;
    const chk = checker(c);
    const sf = sourceOf(c);
    const decl = findNamedType(c, name);
    if (!decl) return { error: `no interface or object type alias named ${name} in ${c.rel(c.abs)}` };
    const fields = decl.members.filter((m) => ts.isPropertySignature(m) && m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)));
    // Where is the object built: calls of a function whose parameter is typed `name`, or an annotated object literal.
    const sites = [];
    for (const r of referenceNodes(c, decl.node.name)) {
        if (r.def) continue;
        const ref = r.node;
        const tr = ref.parent;
        if (!tr || !ts.isTypeReferenceNode(tr)) continue;
        const p = tr.parent;
        if (p && ts.isParameter(p) && p.type === tr && ts.isFunctionLike(p.parent)) {
            const fn = p.parent;
            const idx = fn.parameters.indexOf(p);
            let nameNode = fn.name;
            if (!nameNode && fn.parent && ts.isVariableDeclaration(fn.parent)) nameNode = fn.parent.name;
            if (!nameNode || !ts.isIdentifier(nameNode)) continue;
            const fsf = nameNode.getSourceFile();
            const tmp = { ...c, abs: fsf.fileName };
            for (const fr of referenceNodes(tmp, nameNode)) {
                if (fr.def) continue;
                const call = fr.node.parent;
                if (call && ts.isCallExpression(call) && call.expression === fr.node && call.arguments[idx]) sites.push({ arg: call.arguments[idx], via: `${nameNode.text}()` });
            }
        } else if (p && ts.isVariableDeclaration(p) && p.type === tr && p.initializer) {
            sites.push({ arg: p.initializer, via: `annotated ${p.name.getText()}` });
        }
    }
    const out = { interface: name, declaredAt: at(c, decl.node), callSites: sites.map((s) => ({ at: at(c, s.arg), via: s.via })), exactlyOne: sites.length === 1, fields: [] };
    for (const f of fields) {
        const fname = f.name.text;
        const declared = f.type ? typeText(c, chk.getTypeFromTypeNode(f.type), f.type) : 'any';
        const row = { name: fname, optional: !!f.questionToken, declared, fromCallSite: null };
        if (f.type) Object.defineProperty(row, 'declaredText', { value: f.type.getText(sf), enumerable: false });
        const seen = new Set();
        let missing = 0;
        for (const s of sites) {
            const t = chk.getTypeAtLocation(s.arg);
            const prop = chk.getPropertyOfType(t, fname);
            if (!prop) { missing++; continue; }
            const pt = chk.getTypeOfSymbolAtLocation(prop, s.arg);
            seen.add(typeText(c, widen(c, pt), s.arg));
        }
        if (seen.size) row.fromCallSite = [...seen].join(' | ');
        // The value is (a field of) a hook result: ReturnType<typeof useX> is usually far shorter than the printed type.
        if (sites.length === 1 && ts.isObjectLiteralExpression(sites[0].arg)) {
            const pa = sites[0].arg.properties.find((x) => x.name && x.name.getText() === fname);
            const valueNode = pa && (ts.isShorthandPropertyAssignment(pa) ? pa.name : ts.isPropertyAssignment(pa) ? pa.initializer : null);
            const alt = valueNode && returnTypeAlt(c, valueNode);
            if (alt && row.fromCallSite && alt.expression.length < row.fromCallSite.length) row.shortForm = alt.expression;
        }
        if (missing && seen.size) row.note = `absent at ${missing} of ${sites.length} call sites: make it optional`;
        if (row.fromCallSite && !/\bany\b/.test(row.fromCallSite)) {
            const why = overfitReason(row.shortForm || row.fromCallSite, f.type ? f.type.getText(sf) : null);
            if (why) row.overfit = why;
        }
        if (row.fromCallSite && /\bany\b/.test(row.fromCallSite)) row.note = `${row.note ? `${row.note}; ` : ''}the call site value is itself any/contains any`;
        out.fields.push(row);
    }
    const spelled = (r) => {
        if (!(/\bany\b/.test(r.declared) && r.fromCallSite && !/\bany\b/.test(r.fromCallSite))) return r.declared;
        // Overfit and the field was declared with a named type (`Foo<any>`): keep it.
        if (r.overfit && r.declaredText && isNamedType(r.declaredText)) return r.declaredText;
        return r.shortForm || r.fromCallSite;
    };
    for (const r of out.fields) Object.defineProperty(r, 'suggested', { value: spelled(r), enumerable: false, writable: true });
    Object.defineProperty(out, 'sites', { value: sites, enumerable: false });
    const lines = out.fields.map((r) => `    ${/^[A-Za-z_$][\w$]*$/.test(r.name) ? r.name : JSON.stringify(r.name)}${r.optional || /absent/.test(r.note || '') ? '?' : ''}: ${spelled(r)};`);
    const overfit = out.fields.filter((r) => r.overfit);
    if (overfit.length) out.warnings = overfit.map((r) => `${r.name}: ${r.overfit}`);
    out.suggestion = `interface ${name} {\n${lines.join('\n')}\n}`;
    return out;
}


// ---------------------------------------------------------------- --apply

const exportedMod = (ts, n) => !!n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** Extension-less specifier of `target` as written in a file in `fromDir`. */
function relativeSpec(fromDir, target) {
    let r = path.relative(fromDir, target).split(path.sep).join('/').replace(/\.d\.ts$/, '').replace(/\.(?:tsx?|jsx?|mts|cts)$/, '');
    if (r.endsWith('/index')) r = r.slice(0, -'/index'.length);
    return r.startsWith('.') ? r : `./${r}`;
}

/** Where `typeof name` can be imported from, read from the imports of the files that build the object. */
function findTypeofImport(c, name, siteFiles) {
    const { ts } = c;
    const chk = checker(c);
    for (const sf of siteFiles) {
        for (const st of sf.statements) {
            if (!ts.isImportDeclaration(st) || !st.importClause) continue;
            const cl = st.importClause;
            let local = null; let imported = null; let def = false; let node = null;
            if (cl.name && cl.name.text === name) { local = name; def = true; node = cl.name; }
            else if (cl.namedBindings && ts.isNamedImports(cl.namedBindings)) {
                const el = cl.namedBindings.elements.find((e) => e.name.text === name);
                if (el) { local = name; imported = (el.propertyName || el.name).text; node = el.name; }
            }
            if (!local) continue;
            let sym = chk.getSymbolAtLocation(node);
            if (sym && sym.flags & ts.SymbolFlags.Alias) { try { sym = chk.getAliasedSymbol(sym); } catch { /* keep */ } }
            const target = sym?.declarations?.[0]?.getSourceFile().fileName;
            if (!target || /\/node_modules\//.test(target)) {
                if (!st.moduleSpecifier.text.startsWith('.')) return { spec: st.moduleSpecifier.text, def, imported };
                continue;
            }
            return { spec: relativeSpec(path.dirname(c.abs), target), def, imported };
        }
    }
    return null;
}

/**
 * Write the field types of a depsFromCallsite result into the file, on top of the
 * declaration (comments and generics stay): changed types and `?` on the fields
 * missing at some call site; `import("x").N` become `N` plus an `import type`;
 * `typeof useX` gets an `import type` found through the call site's imports.
 * Returns { text, changedFields, imports, warnings } and does not write.
 */
export function applyDeps(c, name, out) {
    const { ts } = c;
    const warnings = [];
    if (out.error) return { error: out.error };
    const decl = findNamedType(c, name);
    const sf = sourceOf(c);
    const node = decl.node;
    const text = c.original;
    const members = new Map(decl.members.filter((m) => ts.isPropertySignature(m) && m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))).map((m) => [m.name.text, m]));
    const edits = [];
    const changedFields = [];
    const need = new Map(); // module -> Set(import type specifier text)
    const needDefault = new Map(); // local -> module
    const want = (mod, spec) => { if (!need.has(mod)) need.set(mod, new Set()); need.get(mod).add(spec); };
    const hoisted = new Map(); // local name -> module it came from
    const siteFiles = [...new Set((out.sites || []).map((s) => s.arg.getSourceFile()))];
    for (const r of out.fields) {
        const m = members.get(r.name);
        if (!m) continue;
        let t = r.suggested ?? r.declared;
        // Hoist import("x").N
        t = t.replace(/import\("([^"]+)"\)\.([A-Za-z_$][\w$]*)/g, (whole, spec, n) => {
            let mod = spec;
            if (path.isAbsolute(spec)) mod = relativeSpec(path.dirname(c.abs), spec);
            if (hoisted.has(n) && hoisted.get(n) !== mod) { warnings.push(`${r.name}: ${n} comes from two modules; left as import("${spec}").${n}`); return whole; }
            hoisted.set(n, mod); want(mod, n);
            return n;
        });
        for (const tn of new Set([...t.matchAll(/typeof ([A-Za-z_$][\w$]*)/g)].map((x) => x[1]))) {
            const found = findTypeofImport(c, tn, siteFiles);
            if (!found) { warnings.push(`${r.name}: no import found for typeof ${tn}; add it by hand`); continue; }
            if (found.def) needDefault.set(tn, found.spec); else want(found.spec, found.imported && found.imported !== tn ? `${found.imported} as ${tn}` : tn);
        }
        const wantOptional = !m.questionToken && (/absent/.test(r.note || ''));
        const same = m.type && m.type.getText(sf) === t;
        if (same && !wantOptional) continue;
        const keyEnd = m.name.getEnd();
        if (m.type) edits.push({ start: wantOptional ? keyEnd : m.type.getStart(sf), end: m.type.getEnd(), text: wantOptional ? `?: ${t}` : t });
        else edits.push({ start: keyEnd + (m.questionToken ? 1 : 0), end: keyEnd + (m.questionToken ? 1 : 0), text: `${wantOptional ? '?' : ''}: ${t}` });
        changedFields.push(r.name);
    }
    let next = edits.sort((x, y) => y.start - x.start).reduce((tx, e) => tx.slice(0, e.start) + e.text + tx.slice(e.end), text);

    // Imports, on the parsed new text.
    const sf2 = ts.createSourceFile(c.abs, next, ts.ScriptTarget.Latest, true, /\.tsx$/.test(c.abs) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const bound = new Set();
    const imports = [];
    for (const st of sf2.statements) {
        if (ts.isImportDeclaration(st)) {
            imports.push(st);
            const cl = st.importClause;
            if (cl?.name) bound.add(cl.name.text);
            if (cl?.namedBindings) { if (ts.isNamespaceImport(cl.namedBindings)) bound.add(cl.namedBindings.name.text); else for (const e of cl.namedBindings.elements) bound.add(e.name.text); }
        } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) bound.add(st.name.text);
        else if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) bound.add(d.name.text);
    }
    const localOf = (spec) => spec.split(' as ').pop();
    const importEdits = [];
    const newLines = [];
    const added = [];
    for (const [mod, specs] of need) {
        const missing = [...specs].filter((sp) => !bound.has(localOf(sp)));
        if (!missing.length) continue;
        const existing = imports.find((st) => st.moduleSpecifier.text === mod && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings));
        if (existing) {
            const nb = existing.importClause.namedBindings;
            const typeOnly = existing.importClause.isTypeOnly;
            const items = [...nb.elements.map((e) => e.getText(sf2)), ...missing.map((sp) => (typeOnly ? sp : `type ${sp}`))];
            const multi = nb.getText(sf2).includes('\n');
            importEdits.push({ start: nb.getStart(sf2), end: nb.getEnd(), text: multi ? `{\n    ${items.join(',\n    ')},\n}` : `{ ${items.join(', ')} }` });
        } else newLines.push(`import type { ${missing.join(', ')} } from '${mod}';`);
        added.push(...missing.map(localOf));
    }
    for (const [n, mod] of needDefault) if (!bound.has(n)) { newLines.push(`import type ${n} from '${mod}';`); added.push(n); }
    if (newLines.length) {
        const last = imports[imports.length - 1];
        if (last) importEdits.push({ start: last.getEnd(), end: last.getEnd(), text: `\n${newLines.join('\n')}` });
        else importEdits.push({ start: 0, end: 0, text: `${newLines.join('\n')}\n\n` });
    }
    next = importEdits.sort((x, y) => y.start - x.start).reduce((tx, e) => tx.slice(0, e.start) + e.text + tx.slice(e.end), next);
    return { text: next, changedFields, imports: added, warnings };
}

/** applyDeps plus the typecheck of the result (new diagnostics in the file and in the call-site files). */
export function applyDepsChecked(c, name, out) {
    const r = applyDeps(c, name, out);
    if (r.error || r.text === c.original) return r;
    const files = new Set([c.abs, ...(out.sites || []).map((s) => s.arg.getSourceFile().fileName)]);
    const base = diagKeys(c, files);
    c.svc.update(c.abs, r.text);
    try { r.newErrors = newKeys(base, diagKeys(c, files)); } finally { c.svc.update(c.abs, c.original); }
    r.typechecks = r.newErrors.length === 0;
    return r;
}

// ---------------------------------------------------------------- cli

function arg(name, fallback) { const i = process.argv.indexOf(name); return i === -1 ? fallback : process.argv[i + 1]; }

export function resolveFile(f, root) {
    for (const cand of [path.resolve(f), path.resolve(root, f)]) if (fs.existsSync(cand)) return cand;
    return null;
}

/** `a,b` and/or a file with one path per line (blank lines and # comments skipped). */
export function fileList(filesArg, listArg) {
    const out = [];
    if (filesArg) out.push(...filesArg.split(',').map((x) => x.trim()).filter(Boolean));
    if (listArg) out.push(...fs.readFileSync(listArg, 'utf8').split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('#')));
    return [...new Set(out)];
}

/** --anys over several files with ONE language service. A file that fails reports its error and the run goes on. */
export function analyseAnysMany(c, files, { verify = true, log = () => {} } = {}) {
    const results = [];
    for (const f of files) {
        log(`${c.rel(f)} ...`);
        try { results.push(analyseAnys(focus(c, f), { verify })); } catch (e) { results.push({ file: c.rel(f), error: String(e?.message || e) }); }
    }
    const ok = results.filter((r) => !r.error);
    return {
        summary: { files: results.length, failed: results.length - ok.length, total: ok.reduce((n, r) => n + r.summary.total, 0), withReplacement: ok.reduce((n, r) => n + r.summary.withReplacement, 0) },
        files: results,
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const root = path.resolve(arg('--root', HUB));
    const many = fileList(arg('--files'), arg('--list'));
    const first = process.argv[2];
    const hasFirst = first && !first.startsWith('--');
    if (!hasFirst && !many.length) {
        console.error('usage: ts-type-at.mjs <file>:<line>:<col> | <file> --symbol <name> | <file> --anys [--no-verify] | --anys --files a,b | --anys --list f.txt | <file> --deps-from-callsite <InterfaceName> [--apply]   [--root dir]');
        process.exit(2);
    }
    const m = hasFirst ? /^(.*):(\d+):(\d+)$/.exec(first) : null;
    if (many.length && process.argv.includes('--anys')) {
        const files = [...(hasFirst ? [first] : []), ...many].map((f) => resolveFile(f, root));
        const missing = files.findIndex((f) => !f);
        if (missing !== -1) { console.error(`file not found: ${[...(hasFirst ? [first] : []), ...many][missing]}`); process.exit(2); }
        const c = openProject(loadTs(root), root, files);
        console.log(JSON.stringify(analyseAnysMany(c, files, { verify: !process.argv.includes('--no-verify'), log: (x) => console.error(x) }), null, 1));
    } else {
        const file = hasFirst ? resolveFile(m ? m[1] : first, root) : null;
        if (!file) { console.error(`file not found: ${first}`); process.exit(2); }
        const c = openProject(loadTs(root), root, file);
        let result;
        if (process.argv.includes('--anys')) result = analyseAnys(c, { verify: !process.argv.includes('--no-verify') });
        else if (arg('--deps-from-callsite')) {
            const iface = arg('--deps-from-callsite');
            result = depsFromCallsite(c, iface);
            if (process.argv.includes('--apply')) {
                const r = applyDepsChecked(c, iface, result);
                if (r.error) result.applied = { error: r.error };
                else {
                    const { text, ...rest } = r;
                    if (r.typechecks === false && !process.argv.includes('--force')) rest.refused = 'not written: the result adds diagnostics (see newErrors)';
                    else if (text !== c.original) fs.writeFileSync(c.abs, text);
                    result.applied = rest;
                }
            }
        }
        else if (arg('--symbol')) result = typeOfSymbol(c, arg('--symbol'));
        else if (m) result = typeAtPosition(c, Number(m[2]), Number(m[3]));
        else { console.error('give file:line:col, or --symbol, --anys or --deps-from-callsite'); process.exit(2); }
        console.log(JSON.stringify(result, null, 1));
    }
}
