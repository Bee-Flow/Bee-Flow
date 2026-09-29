// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Policy guard for `// @vitest-environment node`.
 *
 * ~187 pure-logic suites opt out of jsdom with that pragma on line 1. jsdom
 * construction is roughly 100s of CPU across them, so the opt-out is worth
 * having — but the pragma encodes "this file needs no DOM", and it silently
 * buys a SECOND property it does not name: under node, src/test/setup.js
 * deliberately skips `await ensureI18nDefaults()`. "DOM-free" and "needs no
 * catalogue" are different predicates. This file pins the second one.
 *
 * 1. NO node-env suite may reach src/hooks/useTranslation.tsx through its
 *    import closure. That module holds the DEFAULTS object at module scope
 *    and only ensureI18nDefaults() fills it, so under node t() would resolve
 *    against an EMPTY catalogue and hand back raw keys — the exact bug class
 *    i18n/i18nGuard.test.js exists to stop, arriving through the back door.
 *    Today this crashes loudly instead (utils/helpers.js reads window.location
 *    at module scope), so there are 0 violations either side of the pragma
 *    rollout — that is the point. This is a tripwire for the day helpers.js is
 *    made node-safe and the crash turns into a silent empty catalogue. Do not
 *    delete it when you fix helpers.js.
 *    A test that imports src/i18n/en-defaults DIRECTLY is not at risk and is
 *    not flagged: it gets the real catalogue. useTranslation.tsx is the only
 *    sentinel that matters.
 * 2. An erosion FLOOR on how many suites carry the pragma, in the same idiom
 *    as the frontend CI job's warning budget: a budget to shrink, not
 *    a target. It stops a mass revert or a bad merge quietly handing ~100s of
 *    CPU per run back to jsdom.
 * 3. There is deliberately NO static "does this file touch the DOM" scan here,
 *    and none should be added. The full suite already IS that check: a file
 *    carrying the pragma that touches the DOM fails immediately with
 *    `ReferenceError: window is not defined`. A static version would be a
 *    heuristic, and a heuristic that fails a build turns a false positive into
 *    a blocked PR (see scripts/find-dom-free-tests.mjs, which exists for
 *    exactly that reason and is deliberately not wired into CI).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const TRANSLATION_HOOK = path.join(SRC, 'hooks', 'useTranslation.tsx');

// Same extension probe order as scripts/find-dom-free-tests.mjs.
const EXTS = [
    '', '.js', '.jsx', '.ts', '.tsx',
    '/index.js', '/index.jsx', '/index.ts', '/index.tsx',
];

const PRAGMA_RE = /^\s*\/\/\s*@vitest-environment\s+node\s*$/m;
// Matches static import/export-from, require() and import() with a literal.
const IMPORT_RE = /(?:import|export)\s*(?:[\s\S]*?\s*from\s*)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules') continue;
            walk(p, out);
        } else {
            out.push(p);
        }
    }
    return out;
}

/**
 * Resolve only the specifiers that can reach first-party code: relative, '@/'
 * and '@shared/'. Bare package specifiers are ignored on purpose — no npm
 * package imports this app's own hook, so following them would cost a lot of
 * fs and find nothing.
 */
function resolveSpec(spec, fromFile) {
    let base;
    if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
    else if (spec.startsWith('@shared/')) base = path.join(SRC, 'shared', spec.slice('@shared/'.length));
    else if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
    else return null;
    for (const ext of EXTS) {
        const cand = base + ext;
        try { if (fs.statSync(cand).isFile()) return cand; } catch { /* keep probing */ }
    }
    return null;
}

/** Walk the import closure of `entry`; return the chain that reaches the
 *  translation hook, or null. */
function chainToTranslationHook(entry) {
    const seen = new Set();
    const stack = [[entry, [entry]]];
    while (stack.length) {
        const [file, chain] = stack.pop();
        if (seen.has(file)) continue;
        seen.add(file);
        if (file === TRANSLATION_HOOK) return chain;
        let src;
        try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
        IMPORT_RE.lastIndex = 0;
        let m;
        while ((m = IMPORT_RE.exec(src))) {
            const spec = m[1] || m[2] || m[3];
            if (!spec) continue;
            const resolved = resolveSpec(spec, file);
            if (resolved && !seen.has(resolved)) stack.push([resolved, [...chain, resolved]]);
        }
    }
    return null;
}

const testFiles = walk(SRC).filter((f) => /\.test\.(js|jsx|ts|tsx)$/.test(f));
const nodeEnvFiles = testFiles.filter(
    (f) => PRAGMA_RE.test(fs.readFileSync(f, 'utf8').slice(0, 400)),
);
const rel = (f) => path.relative(SRC, f);

describe('test-environment policy', () => {
    it('finds the node-environment suites at all', () => {
        // Sanity: if the scan itself broke, the other assertions would pass
        // vacuously and the guard would be worthless.
        expect(testFiles.length).toBeGreaterThan(1000);
        expect(nodeEnvFiles.length).toBeGreaterThan(0);
    });

    it('keeps every node-environment suite clear of the translation chain', () => {
        const violations = [];
        for (const file of nodeEnvFiles) {
            const chain = chainToTranslationHook(file);
            if (chain) violations.push(chain.map(rel).join(' -> '));
        }
        const why = 'These suites run under `// @vitest-environment node`, where '
            + 'src/test/setup.js deliberately skips `await ensureI18nDefaults()` — so '
            + 'the DEFAULTS object in src/hooks/useTranslation.tsx stays EMPTY and t() '
            + 'returns raw keys instead of English. Either drop the pragma from the '
            + 'file (it pays jsdom + catalogue setup, which is the correct price for a '
            + 'suite that translates), or stop importing the translation chain. Do not '
            + '"fix" this by loading the catalogue under node: 187 suites would pay for '
            + 'it and none of them needs it.\n'
            + `Import chains:\n  ${violations.join('\n  ')}`;
        expect(violations, why).toEqual([]);
    });

    it('does not let the node-environment set erode', () => {
        // A FLOOR, not a cap — raise it as more pure-logic suites opt in.
        // It exists so a mass revert or a bad merge cannot quietly hand ~100s
        // of CPU per run back to jsdom.
        //
        // Honest about its reach: this does NOT catch a single new DOM-free
        // file written without the pragma. That case is covered by the
        // CONTRIBUTING pull-request checklist, not by a test, and pretending
        // otherwise would be a guard that lies about what it checks.
        expect(
            nodeEnvFiles.length,
            'Fewer suites carry `// @vitest-environment node` than expected. If you '
            + 'removed the pragma from files because they genuinely need a DOM, lower '
            + 'this floor in the same commit and say why. If this dropped by dozens, '
            + 'something reverted the opt-out and the suite just got ~100s of CPU '
            + 'slower per run.',
        ).toBeGreaterThanOrEqual(185);
    });
});
