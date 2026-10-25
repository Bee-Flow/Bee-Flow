#!/usr/bin/env node
/**
 * Widen the initializers that strictNullChecks narrows too far.
 *
 *   let timer = null;          ... timer = setTimeout(...)     -> /** @type {NodeJS.Timeout | null} *\/ (null)
 *   const state = { rows: [] } ... state.rows.push(row)        -> rows: /** @type {Row[]} *\/ ([])
 *
 * Under strictNullChecks `null` is the type of the first and `never[]` of the second, so every later
 * assignment or push is an error (TS2322, TS2345 on 'never'). The type to write is already in the file:
 * what is assigned to the variable (or property) later, what is pushed into the array. The checker
 * (TypeScript 6 language service) reads those types; the edit wraps the initializer in a JSDoc cast, which adds
 * a comment and a pair of parentheses and nothing else, so the compiled program stays the same.
 * An edit stays only when the file's diagnostics at the strict level do not rise (the checker confirms);
 * a type that mentions any, never or is longer than 120 characters is not written.
 *
 *   node scripts/jsdoc-widen-initializers.mjs --files server/a.js,server/b.js [--write]
 *   node scripts/jsdoc-widen-initializers.mjs --batch list.txt [--write]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';
import { keepHarmless, openServer } from './lib/server-service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /\.(?:test|spec)\.[cm]?js$|\.testkit\.|\.testutil\./;
const MAX_TYPE = 120;

/** A type text that can be written into a comment, or false. */
export function writableType(text) {
    return Boolean(text) && text.length <= MAX_TYPE && !/\b(any|never|unknown)\b|\{\s*\}|\.\.\./.test(text);
}

/** `T`, `U` -> `T | U` without duplicates and without null/undefined (the caller adds its own). */
export function unionText(parts) {
    const set = new Set(parts.filter((p) => p && p !== 'null' && p !== 'undefined'));
    return [...set].join(' | ');
}

/**
 * Replace edits ({ start, end, text }) -> insert pairs the keepHarmless helper takes: it works on
 * { at, text } inserts, so a wrap is an open insert and a close insert that stand or fall together.
 */
export function wrapEdits(initStart, initEnd, type) {
    return [{ at: initStart, text: `/** @type {${type}} */ (` }, { at: initEnd, text: ')' }];
}

export function planFile(project, file) {
    const { ts } = project;
    const program = project.svc.service.getProgram();
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(file);
    const fmt = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope;
    const typeText = (node) => {
        const t = checker.getBaseTypeOfLiteralType(checker.getTypeAtLocation(node));
        return checker.typeToString(t, node, fmt);
    };

    // The initializer node a declaration of `symbol` gives, if it is `null` or `[]`.
    const initializersOf = (symbol, kind) => {
        const out = [];
        for (const d of symbol?.declarations || []) {
            if (d.getSourceFile() !== sf) continue;
            let init = null;
            if (ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d)) init = d.initializer;
            else if (ts.isBinaryExpression(d) && d.operatorToken.kind === ts.SyntaxKind.EqualsToken) init = d.right;
            if (!init) continue;
            if (kind === 'null' && init.kind === ts.SyntaxKind.NullKeyword) out.push(init);
            if (kind === 'array' && ts.isArrayLiteralExpression(init) && init.elements.length === 0) out.push(init);
        }
        return out;
    };
    const symbolOf = (node) => {
        let n = node;
        if (ts.isPropertyAccessExpression(n)) return checker.getSymbolAtLocation(n.name);
        return checker.getSymbolAtLocation(n);
    };

    // Every `target = value` assignment and `target.push(...)` call in the file, by target symbol.
    const assigned = new Map();
    const pushed = new Map();
    const note = (map, sym, text) => { if (sym) (map.get(sym) || map.set(sym, []).get(sym)).push(text); };
    const visit = (n) => {
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.right.kind !== ts.SyntaxKind.NullKeyword) {
            note(assigned, symbolOf(n.left), typeText(n.right));
        } else if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && /^(push|unshift)$/.test(n.expression.name.text)) {
            const sym = symbolOf(n.expression.expression);
            for (const a of n.arguments) note(pushed, sym, ts.isSpreadElement(a) ? '' : typeText(a));
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);

    const edits = [];
    const done = new Set();
    for (const d of project.diagnostics(file)) {
        if (d.start === undefined) continue;
        const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
        const token = ts.getTokenAtPosition(sf, d.start);
        // The node the diagnostic spans exactly (`this.x`, `state.rows`), else the token.
        let target = token;
        while (target.parent && !(target.getStart(sf) === d.start && target.getEnd() === d.start + d.length)) target = target.parent;
        if (target.kind === ts.SyntaxKind.SourceFile) target = token;
        let kind = null;
        let sym = null;
        if (d.code === 2322 && /to type 'null'/.test(msg)) { kind = 'null'; sym = symbolOf(target); }
        else if (d.code === 2345 && /parameter of type 'never'/.test(msg)) {
            let call = token;
            while (call && !ts.isCallExpression(call)) call = call.parent;
            if (call && ts.isPropertyAccessExpression(call.expression)) { kind = 'array'; sym = symbolOf(call.expression.expression); }
        }
        if (!kind || !sym || done.has(sym)) continue;
        const inits = initializersOf(sym, kind);
        if (inits.length !== 1) continue;
        const parts = kind === 'null' ? assigned.get(sym) : pushed.get(sym);
        const t = unionText(parts || []);
        if (!writableType(t)) continue;
        const type = kind === 'null' ? `${t.includes('|') || t.includes('=>') ? `(${t})` : t} | null` : `${t.includes('|') || t.includes('=>') ? `(${t})` : t}[]`;
        if (!writableType(type)) continue;
        done.add(sym);
        edits.push(...wrapEdits(inits[0].getStart(sf), inits[0].getEnd(), type));
    }
    return edits;
}

export function run({ files, write = false, serverDir } = {}) {
    const abs = files.map((f) => path.resolve(ROOT, f)).filter((f) => !TEST_FILE.test(f));
    const project = openServer(abs, { serverDir, level: 'strict' });
    const report = [];
    for (const f of abs) {
        const edits = planFile(project, f);
        if (edits.length === 0) continue;
        const original = project.text(f);
        const count = (text) => { project.update(f, text); return project.diagnostics(f).length; };
        // A wrap is two inserts; they are tried as pairs so a half is never written.
        const pairs = [];
        for (let i = 0; i < edits.length; i += 2) pairs.push([edits[i], edits[i + 1]]);
        let text = original;
        let kept = 0;
        let now = count(original);
        for (const [open, close] of pairs.sort((a, b) => b[0].at - a[0].at)) {
            const candidate = text.slice(0, close.at) + close.text + text.slice(close.at);
            const withOpen = candidate.slice(0, open.at) + open.text + candidate.slice(open.at);
            const n = count(withOpen);
            if (n < now) { text = withOpen; now = n; kept++; }
        }
        project.update(f, text);
        if (write && kept) fs.writeFileSync(f, text);
        report.push({ file: path.relative(ROOT, f), planned: pairs.length, kept, dropped: pairs.length - kept });
    }
    return report;
}

export { keepHarmless };

if (isEntryPoint(import.meta.url)) {
    const args = process.argv.slice(2);
    const val = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
    const files = val('--files') ? val('--files').split(',') : val('--batch') ? fs.readFileSync(val('--batch'), 'utf8').split('\n').filter(Boolean) : [];
    if (files.length === 0) {
        console.error('jsdoc-widen-initializers: pass --files a,b or --batch list.txt');
        process.exit(2);
    }
    const report = run({ files, write: args.includes('--write') });
    const sum = (k) => report.reduce((n, r) => n + r[k], 0);
    console.log(JSON.stringify({ planned: sum('planned'), kept: sum('kept'), dropped: sum('dropped'), files: report }, null, 1));
}
