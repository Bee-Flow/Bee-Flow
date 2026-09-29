// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * Repo-wide token hygiene: every `var(--x)` a component reads must be a
 * custom property that actually exists. An undeclared var() substitutes to
 * NOTHING (or to its hex fallback), so `var(--color-warning, #f59e0b)` is
 * not a themed colour — it is a hex literal with extra steps, and it is why
 * a section can stay sky-blue under every organisation accent and fail in
 * one theme that nobody develops on.
 *
 * Promoted from DatatablesStudio.hygiene.test.jsx:110-122, which guarded one
 * folder, non-recursively. This file walks all of agent-hub/src, so the next
 * invented token is caught the day it is written. When it surfaced the
 * pre-existing strays (2026-09-03: 18 tokens in 25 files) they were fixed at
 * the call site, not silenced here — there is no allowlist.
 *
 * What counts as declared:
 *   1. a `--x:` declaration in any .css under src/ — index.css above all
 *      (app-tokens.css, marketing/tokens.css and the rest count too);
 *   2. a property a component SETS from script — `el.style.setProperty('--x', …)`
 *      or a `'--x': value` key in a style object / `vars['--x'] = …`. That is a
 *      token with a runtime source of truth: --announce-height, --pill-tint,
 *      --cms-cols and the --app-* theme vars are deliberately never in CSS,
 *      because an ABSENT property is what makes their `var(--x, fallback)`
 *      fall back (marketing.css:3448 says so in as many words);
 *   3. a Tailwind arbitrary PROPERTY class that sets it on the element,
 *      `[--x:var(--type-ai)]` (Builder/ndv/familyVar.ts sets `--fam` this way,
 *      so one class per family paints a whole header without a style object).
 *
 * What is skipped: template stubs that end in `-` (`var(--type-${group})` in
 * nodeTypeColors.js, `var(--radius-${size})` in utils/radius.ts — their
 * expansions are checked by their own tests), and comments (block comments
 * and whole-line // comments): docs describe `var(--token, …)` as a pattern,
 * not as a token.
 */

const SRC = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_EXT = /\.(jsx?|tsx?)$/;
const TEST_FILE = /\.test\.[jt]sx?$/;

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
}

const FILES = walk(SRC);
const CSS_FILES = FILES.filter(f => f.endsWith('.css'));
const SOURCE_FILES = FILES.filter(f => SOURCE_EXT.test(f) && !TEST_FILE.test(f));

const declared = new Set();
for (const f of CSS_FILES) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) declared.add(m[1]);
}

const setFromScript = new Set();
for (const f of SOURCE_FILES) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/setProperty\(\s*['"](--[a-zA-Z0-9_-]+)['"]/g)) setFromScript.add(m[1]);
    for (const m of src.matchAll(/['"](--[a-zA-Z0-9_-]+)['"]\s*(?::|\]\s*=)/g)) setFromScript.add(m[1]);
    for (const m of src.matchAll(/\[(--[a-zA-Z0-9_-]+):/g)) setFromScript.add(m[1]);
}

describe('src/index.css — token hygiene, repo-wide', () => {
    it('the scan actually saw the tree (a broken walk would pass vacuously)', () => {
        expect(SOURCE_FILES.length).toBeGreaterThan(300);
        expect(CSS_FILES.some(f => path.basename(f) === 'index.css')).toBe(true);
        expect(declared.has('--accent-primary')).toBe(true);
        expect(declared.has('--kind-app')).toBe(true);
        expect(declared.has('--kind-compliance')).toBe(true);
        expect(declared.has('--success-ink')).toBe(true);
        expect(setFromScript.has('--announce-height')).toBe(true);
        expect(setFromScript.has('--pill-tint')).toBe(true);
    });

    it('every var(--x) read under src/ is declared in a stylesheet or set from script', () => {
        const missing = new Map();
        for (const f of SOURCE_FILES) {
            const src = stripComments(fs.readFileSync(f, 'utf8'));
            for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
                const token = m[1];
                if (token.endsWith('-')) continue; // template stub, see header
                if (declared.has(token) || setFromScript.has(token)) continue;
                if (!missing.has(token)) missing.set(token, new Set());
                missing.get(token).add(path.relative(SRC, f).replace(/\\/g, '/'));
            }
        }
        const report = [...missing]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([token, files]) => `${token}  <-  ${[...files].sort().join(', ')}`);
        expect(report, 'undeclared custom properties (declare in index.css or use the existing token)').toEqual([]);
    });

    it('no component reads a --color-* or --status-* token: agent-hub never declared one', () => {
        // The two families the artboards and older sections reached for by
        // habit. The repo's names are --success/--warning/--error (+ the
        // --*-ink pair for chip text) and --accent-primary.
        const offenders = [];
        for (const f of SOURCE_FILES) {
            const src = stripComments(fs.readFileSync(f, 'utf8'));
            for (const m of src.matchAll(/var\(\s*(--(?:color|status)-[a-z-]+)/g)) {
                offenders.push(`${path.relative(SRC, f).replace(/\\/g, '/')}: ${m[1]}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
