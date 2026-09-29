/**
 * sidebars.ts ↔ docs/ — the check `npm run build` would do, without a build.
 *
 * Docusaurus FAILS the build on a sidebar id that names no document, and this
 * repo carries no docs/node_modules and no docs CI workflow, so a broken id
 * would only be found on the GitHub Pages deploy. This test is the stand-in:
 * dependency-free, so it runs with a bare `node --test docs/sidebars.test.mjs`
 * from anywhere.
 *
 * It reads sidebars.ts as TEXT rather than importing it — the file is
 * TypeScript with a `@docusaurus/plugin-content-docs` type import, which node
 * cannot load on its own. Every quoted `'a/b'` and every `id: '…'` is treated
 * as a document id; that over-collects rather than under-collects, which is
 * the safe direction for a check whose whole job is "nothing is missing".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOCS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGES = path.join(DOCS_ROOT, 'docs');
const EXTS = ['.md', '.mdx'];

const source = fs.readFileSync(path.join(DOCS_ROOT, 'sidebars.ts'), 'utf8');

/** Every document id sidebars.ts names, in either shape. */
function sidebarIds() {
    const ids = new Set();
    for (const m of source.matchAll(/'([A-Za-z0-9._/-]+\/[A-Za-z0-9._-]+)'/g)) ids.add(m[1]);
    for (const m of source.matchAll(/id:\s*'([^']+)'/g)) ids.add(m[1]);
    return [...ids].sort();
}

/** Does `<id>.md(x)` or `<id>/index.md(x)` exist? */
function resolves(id) {
    const base = path.join(PAGES, id);
    return EXTS.some((e) => fs.existsSync(base + e))
        || EXTS.some((e) => fs.existsSync(path.join(base, `index${e}`)));
}

test('every sidebar id resolves to a file under docs/docs', () => {
    const ids = sidebarIds();
    assert.ok(ids.length > 50, `expected the full sidebar, parsed only ${ids.length} ids`);
    const missing = ids.filter((id) => !resolves(id));
    assert.deepEqual(missing, [], `sidebars.ts names documents that do not exist: ${missing.join(', ')}`);
});

// The twelve sections of agent-hub/src/components/admin/Studio/studioApps.jsx
// that have (or share) a page. These five got one in Track Z4b and are the ids
// most likely to be dropped by a later edit of the Studio category.
const STUDIO_PAGES = [
    'studio/datatables',
    'studio/webpages',
    'studio/forms',
    'studio/solutions',
    'studio/runs',
];

test('the five Studio section pages exist and are listed in the sidebar', () => {
    const ids = new Set(sidebarIds());
    for (const id of STUDIO_PAGES) {
        assert.ok(resolves(id), `${id}.md is missing`);
        assert.ok(ids.has(id), `${id} is not listed in sidebars.ts`);
    }
});

test('every Studio page opens with front matter carrying a title', () => {
    const dir = path.join(PAGES, 'studio');
    const files = fs.readdirSync(dir).filter((f) => EXTS.includes(path.extname(f)));
    assert.ok(files.length >= 12, `expected the Studio pages, found ${files.length}`);
    for (const file of files) {
        const head = fs.readFileSync(path.join(dir, file), 'utf8').slice(0, 400);
        // `[^\\S\\r\\n]*`, not `\\s*`: \\s matches a newline, so `title:` followed by a
        // BLANK value would still match against the closing `---` on the next line —
        // a green bite proof caught exactly that.
        assert.match(head, /^---\r?\ntitle:[^\S\r\n]*\S/, `${file} has no front-matter title`);
    }
});
