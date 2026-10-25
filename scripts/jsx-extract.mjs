#!/usr/bin/env node
// jsx-extract: shorten a React component over 200 lines by lifting its largest JSX blocks into
// components of their own, with the TypeScript language service doing the work:
//
//   1. "Extract to function in module scope" on the largest JSX child of the returned tree (the
//      service works out the parameter list and its types);
//   2. "Convert parameters to destructured object" on the new function;
//   3. the call `{newFunction({ a, b })}` becomes `<AnchorRole a={a} b={b} />`.
//
//   node scripts/jsx-extract.mjs [files...] [--max N] [--report out.json]
//
// With no files it takes the ones `count-ratchet long-function agent-hub --list` names.
// Refused, and the file left as it was, when the block:
//   - calls a hook (a hook cannot follow a conditional render boundary),
//   - needs more than 12 props,
//   - needs a prop called `key` or `ref` (React takes those),
//   - passes a spread or a computed property, or the service finds no extraction.
// Up to 4 blocks per component, until the component is 200 lines or less. The result is kept only
// when the language service reports no new diagnostic in the file; otherwise the file is restored.
// Nothing is written until a file passes. Run the tests that import the file afterwards.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createService, loadTs } from './lib/ts-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 200;
const MAX_PROPS = 12;
const MAX_BLOCKS = 4;
const TAG_ROLE = { header: 'Header', footer: 'Footer', nav: 'Nav', aside: 'Sidebar', section: 'Section', table: 'Table', ul: 'List', ol: 'List', form: 'Form', main: 'Main', dialog: 'Dialog', article: 'Article', thead: 'Head', tbody: 'Rows', details: 'Details' };

const lineOf = (sf, pos) => sf.getLineAndCharacterOfPosition(pos).line;

/** Component-like functions (a capitalised name) whose braces span more than LIMIT lines. */
export function longComponents(ts, sf) {
    const out = [];
    const nameOf = (n) => {
        if (n.name && ts.isIdentifier(n.name)) return n.name.text;
        const p = n.parent;
        if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
        if (p && ts.isCallExpression(p) && p.parent && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text; // memo(() => …)
        return null;
    };
    const visit = (n) => {
        if ((ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.body && ts.isBlock(n.body)) {
            const name = nameOf(n);
            const span = lineOf(sf, n.body.getEnd()) - lineOf(sf, n.body.getStart(sf)) + 1;
            if (name && /^[A-Z]/.test(name) && span > LIMIT && ts.isSourceFile(topParent(n).parent)) out.push({ node: n, name, span });
        }
        ts.forEachChild(n, visit);
    };
    const topParent = (n) => { let p = n; while (p.parent && !ts.isSourceFile(p.parent)) p = p.parent; return p; };
    visit(sf);
    return out;
}

/** Statements of the function's own body (not nested functions) that return JSX: the root element. */
function returnedJsx(ts, fn) {
    let root = null;
    const visit = (n) => {
        if (n !== fn && ts.isFunctionLike(n)) return;
        if (ts.isReturnStatement(n) && n.expression) {
            let e = n.expression;
            while (ts.isParenthesizedExpression(e)) e = e.expression;
            if (ts.isJsxElement(e) || ts.isJsxFragment(e)) root = e;
        }
        ts.forEachChild(n, visit);
    };
    ts.forEachChild(fn.body, visit);
    return root;
}

/** Direct JSX element children of the root, largest first (a JsxExpression child is not extracted). */
function candidates(ts, sf, root) {
    const kids = (root.children || []).filter((c) => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c) || ts.isJsxFragment(c));
    const size = (c) => lineOf(sf, c.getEnd()) - lineOf(sf, c.getStart(sf)) + 1;
    // the root itself is a one-child wrapper: look one level down
    const all = kids.length === 1 && size(kids[0]) > 30 ? (kids[0].children || []).filter((c) => ts.isJsxElement(c) || ts.isJsxFragment(c) || ts.isJsxSelfClosingElement(c)).concat(kids) : kids;
    return all.map((c) => ({ node: c, lines: size(c) })).filter((c) => c.lines >= 12).sort((a, b) => b.lines - a.lines);
}

const tagName = (ts, sf, el) => {
    const open = ts.isJsxElement(el) ? el.openingElement : ts.isJsxSelfClosingElement(el) ? el : null;
    return open ? open.tagName.getText(sf) : '';
};

function roleOf(ts, sf, el) {
    const tag = tagName(ts, sf, el);
    if (TAG_ROLE[tag]) return TAG_ROLE[tag];
    if (/^[A-Z]/.test(tag)) return tag.replace(/\..*/, '');
    return 'Section';
}

function hasHookCall(ts, node) {
    let hit = false;
    const visit = (n) => {
        if (hit) return;
        if (ts.isCallExpression(n) && ((ts.isIdentifier(n.expression) && /^use[A-Z0-9]/.test(n.expression.text)) || (ts.isPropertyAccessExpression(n.expression) && /^use[A-Z0-9]/.test(n.expression.name.text)))) { hit = true; return; }
        ts.forEachChild(n, visit);
    };
    visit(node);
    return hit;
}

const fmt = (ts) => ({ ...ts.getDefaultFormatCodeSettings(), indentSize: 4, tabSize: 4, convertTabsToSpaces: true, semicolons: ts.SemicolonPreference.Insert });

/**
 * Extract one block of `componentName` in `file`. Works on the service's overlay; returns
 * { ok, reason, name, props } and leaves the overlay changed only when ok.
 */
export function extractOne(svc, file, componentName, taken) {
    const ts = svc.ts;
    const ls = svc.ls;
    const text = svc.read(file);
    const sf = ls.getProgram().getSourceFile(file);
    const comp = longComponents(ts, sf).find((c) => c.name === componentName);
    if (!comp) return { ok: false, reason: 'component not over the limit any more' };
    const root = returnedJsx(ts, comp.node);
    if (!root) return { ok: false, reason: 'no returned JSX tree' };
    const cands = candidates(ts, sf, root);
    if (!cands.length) return { ok: false, reason: 'no JSX block of 12+ lines' };
    let lastReason = 'no block can be extracted';
    for (const cand of cands) {
        if (hasHookCall(ts, cand.node)) { lastReason = 'the block calls a hook'; continue; }
        const range = { pos: cand.node.getStart(sf), end: cand.node.getEnd() };
        const refs = ls.getApplicableRefactors(file, range, {}, undefined, undefined);
        const ext = refs.find((r) => r.name === 'Extract Symbol');
        const act = ext && ext.actions.filter((a) => a.name.startsWith('function_scope') && !a.notApplicableReason).pop();
        if (!act) { lastReason = 'the language service offers no module-scope extraction'; continue; }
        const edits = ls.getEditsForRefactor(file, fmt(ts), range, 'Extract Symbol', act.name, {});
        if (!edits) { lastReason = 'no edits'; continue; }
        const before = text;
        svc.applyChanges(edits.edits);
        const restore = () => svc.set(file, before);
        let sf2 = ls.getProgram().getSourceFile(file);
        let decl = null;
        const find = (n) => { if (ts.isFunctionDeclaration(n) && n.name && /^newFunction/.test(n.name.text)) decl = n; ts.forEachChild(n, find); };
        find(sf2);
        if (!decl) { restore(); lastReason = 'the extracted function was not found'; continue; }
        const oldName = decl.name.text;
        const n = decl.parameters.length;
        if (n > MAX_PROPS) { restore(); lastReason = `${n} props, over ${MAX_PROPS}`; continue; }
        const pnames = decl.parameters.map((p) => p.name.getText(sf2));
        if (pnames.some((p) => p === 'key' || p === 'ref')) { restore(); lastReason = 'a prop would be called key or ref'; continue; }
        if (n > 1 || n === 1) {
            const d = ls.getEditsForRefactor(file, fmt(ts), decl.name.getStart(sf2), 'Convert parameters to destructured object', 'Convert parameters to destructured object', {});
            if (!d) { restore(); lastReason = 'the parameters cannot be destructured'; continue; }
            svc.applyChanges(d.edits);
        }
        // Name it and turn the calls into elements.
        let name = `${comp.name}${roleOf(ts, sf, cand.node)}`;
        for (let i = 2; taken.has(name) || new RegExp(`\\b${name}\\b`).test(svc.read(file)); i++) name = `${comp.name}${roleOf(ts, sf, cand.node)}${i}`;
        sf2 = ls.getProgram().getSourceFile(file);
        const cur = svc.read(file);
        const edits2 = [];
        let bad = null;
        const visit = (node) => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === oldName) {
                const arg = node.arguments[0];
                const inJsx = node.parent && ts.isJsxExpression(node.parent);
                if (!inJsx) { bad = 'the call is not directly a JSX child'; return; }
                let attrs = '';
                if (arg) {
                    if (!ts.isObjectLiteralExpression(arg)) { bad = 'the argument is not an object literal'; return; }
                    for (const p of arg.properties) {
                        if (ts.isShorthandPropertyAssignment(p)) attrs += ` ${p.name.text}={${p.name.text}}`;
                        else if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) attrs += ` ${p.name.text}={${p.initializer.getText(sf2)}}`;
                        else { bad = 'spread or computed property'; return; }
                    }
                }
                edits2.push({ start: node.parent.getStart(sf2), end: node.parent.getEnd(), text: `<${name}${attrs} />` });
                return;
            }
            if (ts.isFunctionDeclaration(node) && node.name && node.name.text === oldName) {
                edits2.push({ start: node.name.getStart(sf2), end: node.name.getEnd(), text: name });
            }
            ts.forEachChild(node, visit);
        };
        visit(sf2);
        if (bad || !edits2.length) { restore(); lastReason = bad || 'no call found'; continue; }
        let out = cur;
        for (const e of [...edits2].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
        svc.set(file, out);
        taken.add(name);
        return { ok: true, name, props: n };
    }
    return { ok: false, reason: lastReason };
}

/** Extract blocks from every long component of a file; { ok, extracted: [{ component, name, props }], refused: [reasons] }. */
export function extractFile(svc, file) {
    const ts = svc.ts;
    const original = svc.read(file);
    const diag = () => {
        const m = new Map();
        for (const d of [...svc.ls.getSyntacticDiagnostics(file), ...svc.ls.getSemanticDiagnostics(file)]) {
            const t = ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 160);
            m.set(t, (m.get(t) ?? 0) + 1);
        }
        return m;
    };
    const baseline = diag();
    const extracted = [];
    const refused = [];
    const taken = new Set();
    const names = longComponents(ts, svc.ls.getProgram().getSourceFile(file)).map((c) => c.name);
    for (const comp of names) {
        for (let i = 0; i < MAX_BLOCKS; i++) {
            const r = extractOne(svc, file, comp, taken);
            if (!r.ok) { if (r.reason !== 'component not over the limit any more') refused.push(`${comp}: ${r.reason}`); break; }
            extracted.push({ component: comp, name: r.name, props: r.props });
        }
    }
    if (!extracted.length) { svc.set(file, original); return { ok: false, extracted, refused }; }
    const after = diag();
    const worse = [...after].find(([m, n]) => n > (baseline.get(m) ?? 0));
    if (worse) { svc.set(file, original); return { ok: false, extracted: [], refused: [...refused, `typecheck: ${worse[0]}`] }; }
    return { ok: true, extracted, refused };
}

export function longFunctionFiles(repo = ROOT) {
    const r = spawnSync('node', [path.join(ROOT, 'scripts', 'count-ratchet.mjs'), 'long-function', 'agent-hub', '--list'], { cwd: repo, encoding: 'utf8' });
    return r.stdout.split('\n').map((l) => /^\s+\d+\s+(\S+)$/.exec(l)?.[1]).filter((p) => p && /\.tsx$/.test(p)).map((p) => path.join(repo, 'agent-hub', p));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
    let files = args.filter((a, i) => !a.startsWith('--') && !['--max', '--report', '--pkg'].includes(args[i - 1])).map((f) => path.resolve(f));
    if (!files.length) files = longFunctionFiles();
    if (val('--max')) files = files.slice(0, Number(val('--max')));
    const pkgDir = val('--pkg') ? path.resolve(val('--pkg')) : path.join(ROOT, 'agent-hub');
    const svc = createService(pkgDir, loadTs());
    const report = { done: [], refused: [] };
    for (const f of files) {
        const r = extractFile(svc, f);
        const rel = path.relative(pkgDir, f);
        if (r.ok) {
            fs.writeFileSync(f, svc.read(f));
            report.done.push({ file: rel, extracted: r.extracted, refused: r.refused });
            console.error(`ok ${rel}: ${r.extracted.map((e) => e.name).join(', ')}`);
        } else {
            report.refused.push({ file: rel, reasons: r.refused });
            console.error(`no ${rel}: ${r.refused[0] ?? 'nothing to extract'}`);
        }
    }
    if (val('--report')) fs.writeFileSync(val('--report'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ done: report.done.length, refused: report.refused.length }));
}
