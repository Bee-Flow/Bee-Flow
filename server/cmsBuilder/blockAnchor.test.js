// @typecheck
/**
 * A block's anchor id (style.anchor): a validated slug, unique per page,
 * rendered as the section id so a link can target it.
 *
 * Run: node --test cmsBuilder/blockAnchor.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('../stores/cmsStore.testkit');

installCmsStoreMocks();

const cmsStore = require('../stores/cmsStore');
const { applyToolCall } = require('./builderTools');
const { validateStylePatch } = require('./blockStyle');
const { cleanAnchor, sanitizeBlockDesignStyle } = require('../i18n/defaults/blockStyleEnums');
const { renderBlocks } = require('../core/seo/renderBlocks');

async function makeDraft() {
    const created = await cmsStore.createProject({ name: 'Anchor site' });
    const site = await cmsStore.getProject(created.id);
    const pages = new Map();
    for (const entry of site.pages) pages.set(entry.id, await cmsStore.getPage(created.id, entry.id));
    return {
        siteId: created.id, userId: 'u1', orgId: 'orgA', builderSessionId: 'cms_test', site, pages,
        defaultLocale: 'en', locales: [], createdPageIds: [], touchedPageIds: new Set(),
    };
}

test('cleanAnchor accepts a slug and refuses anything a URL or selector would need escaping for', () => {
    assert.strictEqual(cleanAnchor(' Install '), 'install');
    assert.strictEqual(cleanAnchor('get-started-2'), 'get-started-2');
    for (const bad of ['', '2fast', 'a b', 'a_b', 'a--b', '-a', 'a-', 'x"y', '<b>', 'main', 'a'.repeat(65), 5, null]) {
        assert.strictEqual(cleanAnchor(bad), null, String(bad));
    }
});

test('the store drops an illegal anchor and keeps a legal one', () => {
    assert.strictEqual(sanitizeBlockDesignStyle({ anchor: 'a b' }).anchor, undefined);
    assert.strictEqual(sanitizeBlockDesignStyle({ anchor: 'Install' }).anchor, 'install');
});

test('stylePatch.anchor is validated and normalised', () => {
    assert.deepStrictEqual(validateStylePatch({ anchor: 'Install' }).style, { anchor: 'install' });
    const bad = validateStylePatch({ anchor: 'not a slug' });
    assert.ok(bad.error);
    assert.match(String(bad._fixHint), /lowercase/i);
});

test('cms_update_block sets an anchor, and refuses one another block on the page already has', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const added = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'cta' }, { type: 'cta' }] });
    assert.ok(!added.error, JSON.stringify(added));
    const [a, b] = draft.pages.get(home).blocks.slice(-2);
    const ok = await applyToolCall(draft, 'cms_update_block', { pageId: home, blockId: a.id, stylePatch: { anchor: 'install' } });
    assert.ok(!ok.error, JSON.stringify(ok));
    assert.strictEqual(draft.pages.get(home).blocks.find((x) => x.id === a.id).style.anchor, 'install');
    const dup = await applyToolCall(draft, 'cms_update_block', { pageId: home, blockId: b.id, stylePatch: { anchor: 'install' } });
    assert.match(String(dup.error), /already/i);
    assert.strictEqual(draft.pages.get(home).blocks.find((x) => x.id === b.id).style.anchor, undefined);
    const same = await applyToolCall(draft, 'cms_update_block', { pageId: home, blockId: a.id, stylePatch: { anchor: 'install' } });
    assert.ok(!same.error, 'a block may keep its own anchor');
});

test('cms_add_blocks drops an entry whose anchor is taken, in the page or earlier in the batch', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const r = await applyToolCall(draft, 'cms_add_blocks', {
        pageId: home,
        blocks: [{ type: 'cta', style: { anchor: 'pricing' } }, { type: 'cta', style: { anchor: 'pricing' } }],
    });
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(r.dropped.map((d) => d.reason), ['invalid-style']);
    const anchors = draft.pages.get(home).blocks.map((x) => x.style.anchor).filter(Boolean);
    assert.deepStrictEqual(anchors, ['pricing']);
});

test('the crawler HTML carries the anchor as the section id', () => {
    const html = renderBlocks([{ type: 'cta', style: { anchor: 'install' }, content: { heading: 'Install it' } }]);
    assert.match(html, /<section id="install" data-block="cta">/);
});

test('validateSiteDraft warns about a duplicate anchor', async () => {
    const { validateSiteDraft } = require('./validate');
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const page = draft.pages.get(home);
    const mk = (id) => ({ id, type: 'cta', enabled: true, content: {}, style: { anchor: 'dup' } });
    page.blocks = [mk('b1'), mk('b2')];
    const res = validateSiteDraft(draft);
    assert.ok(res.warnings.some((w) => w.code === 'duplicate_anchor' && w.path.includes('blocks[1]')), JSON.stringify(res.warnings.map((w) => w.code)));
});

test('the store keeps an anchor on the first block of a page only', () => {
    const mk = (id) => ({ id, type: 'cta', enabled: true, content: {}, style: { anchor: 'dup' } });
    const { blocks } = cmsStore.sanitizeBlocks([mk('b1'), mk('b2')]);
    assert.deepStrictEqual(blocks.map((b) => b.style.anchor), ['dup', undefined]);
});
