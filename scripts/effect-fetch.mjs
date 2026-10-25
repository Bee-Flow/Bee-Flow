#!/usr/bin/env node
/**
 * Does a file make a network call inside a useEffect?
 *
 * The `authfetch-effect` metric asks a narrower question: does the file mention
 * `authFetch` and `useEffect` at all. A fetch moved into an api/ helper
 * (`mutate`, `request`, a thin reader) and still called from the effect drops out
 * of that count without the effect changing. This one follows the call:
 *
 *   - a call inside a useEffect callback to `authFetch`, `fetch`, or any value
 *     imported from an api/ module (a type-only import is not a call);
 *   - or to a function of the same file (declaration, const arrow, useCallback)
 *     whose body makes such a call, up to three hops deep.
 *
 * Hooks (`use*`) are not calls into the network even when an api/ module exports
 * them: a useQuery hook is the replacement, not the pattern.
 *
 * Used by `node scripts/count-ratchet.mjs fetch-in-effect agent-hub`.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let tsCache;
/** The TypeScript 6 compiler API: the root's `typescript-api` alias, else agent-hub's own copy. */
function loadTs() {
    if (tsCache) return tsCache;
    try {
        tsCache = createRequire(path.join(ROOT, 'package.json'))('typescript-api');
    } catch {
        tsCache = createRequire(path.join(ROOT, 'agent-hub', 'package.json'))('typescript');
    }
    return tsCache;
}

const API_MODULE = /(^|\/)api(\/|$)/;
const HOOK = /^use[A-Z]/;

/**
 * @param {string} text source of one .ts/.tsx/.js/.jsx file
 * @param {string} [file] its name; the extension picks the parser
 * @returns {0 | 1}
 */
export function fetchInEffect(text, file = 'x.tsx') {
    if (!/\buseEffect\b/.test(text)) return 0;
    const ts = loadTs();
    const kind = /\.(t|j)sx$/.test(file) ? ts.ScriptKind.TSX : (/\.jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);

    const net = new Set(['authFetch', 'fetch']);
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !API_MODULE.test(st.moduleSpecifier.text)) continue;
        const c = st.importClause;
        if (!c || c.isTypeOnly) continue;
        if (c.name) net.add(c.name.text);
        const b = c.namedBindings;
        if (b && ts.isNamespaceImport(b)) net.add(b.name.text);
        if (b && ts.isNamedImports(b)) for (const el of b.elements) if (!el.isTypeOnly) net.add(el.name.text);
    }

    /** The name a call goes through: `f()` -> f, `ns.f()` -> ns; and the called member for the hook test. */
    const calleeOf = (call) => {
        const e = call.expression;
        if (ts.isIdentifier(e)) return { base: e.text, member: e.text };
        if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) return { base: e.expression.text, member: e.name.text };
        return null;
    };
    const callsNet = (node) => {
        let hit = false;
        const walk = (n) => {
            if (hit) return;
            if (ts.isCallExpression(n)) {
                const c = calleeOf(n);
                if (c && net.has(c.base) && !HOOK.test(c.member)) { hit = true; return; }
            }
            ts.forEachChild(n, walk);
        };
        walk(node);
        return hit;
    };

    // Local functions that reach the network join the set; three passes cover a
    // helper that calls a helper that fetches.
    for (let pass = 0; pass < 3; pass++) {
        const visit = (n) => {
            let name = null;
            let body = null;
            if (ts.isFunctionDeclaration(n) && n.name) { name = n.name.text; body = n.body; }
            else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) { name = n.name.text; body = n.initializer; }
            const fnLike = body && (ts.isArrowFunction(body) || ts.isFunctionExpression(body) || ts.isCallExpression(body) || ts.isBlock(body));
            if (name && fnLike && !net.has(name) && !HOOK.test(name) && callsNet(body)) net.add(name);
            ts.forEachChild(n, visit);
        };
        visit(sf);
    }

    let found = false;
    const visit = (n) => {
        if (found) return;
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'useEffect' && n.arguments[0] && callsNet(n.arguments[0])) {
            found = true;
            return;
        }
        ts.forEachChild(n, visit);
    };
    visit(sf);
    return found ? 1 : 0;
}
