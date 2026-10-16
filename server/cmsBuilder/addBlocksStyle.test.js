// @typecheck
/**
 * cms_add_blocks accepts a per-entry `style` (same closed key set as
 * cms_update_block's stylePatch) instead of silently dropping it.
 *
 * Run: node --test cmsBuilder/addBlocksStyle.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('../stores/cmsStore.testkit');

installCmsStoreMocks();

const cmsStore = require('../stores/cmsStore');
const { applyToolCall, TOOL_SCHEMAS } = require('./builderTools');

async function makeDraft() {
    const created = await cmsStore.createProject({ name: 'Style site' });
    const site = await cmsStore.getProject(created.id);
    const pages = new Map();
    for (const entry of site.pages) pages.set(entry.id, await cmsStore.getPage(created.id, entry.id));
    return {
        siteId: created.id, userId: 'u1', orgId: 'orgA', builderSessionId: 'cms_test', site, pages,
        defaultLocale: 'en', locales: [], createdPageIds: [], touchedPageIds: new Set(),
    };
}

test('cms_add_blocks: a per-entry style lands on the block', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const r = await applyToolCall(draft, 'cms_add_blocks', {
        pageId: home,
        blocks: [{ type: 'hero', style: { band: 'dark', rhythm: 'spacious', colorOverrides: { accent: '#ff0000' } } }, { type: 'cta' }],
    });
    assert.ok(!r.error, JSON.stringify(r));
    const [hero, cta] = draft.pages.get(home).blocks;
    assert.strictEqual(hero.style.band, 'dark');
    assert.strictEqual(hero.style.rhythm, 'spacious');
    assert.deepStrictEqual(hero.style.colorOverrides, { accent: '#ff0000' });
    assert.deepStrictEqual(cta.style, {});
});

test('cms_add_blocks: unknown style keys are reported in warnings, bad values drop that entry', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const r = await applyToolCall(draft, 'cms_add_blocks', {
        pageId: home,
        blocks: [{ type: 'hero', style: { bogus: 1, band: 'tint' } }, { type: 'cta', style: { band: 'neon' } }],
    });
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(r.warnings.some((w) => w.includes('bogus')), JSON.stringify(r.warnings));
    assert.deepStrictEqual(r.dropped.map((d) => d.reason), ['invalid-style']);
    assert.strictEqual(draft.pages.get(home).blocks.length, 1);
    assert.strictEqual(draft.pages.get(home).blocks[0].style.band, 'tint');
});

test('cms_add_blocks: when every entry is dropped for a bad style, the error names the style, not the type', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const r = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'hero', style: { band: 'neon' } }] });
    assert.ok(r.error, JSON.stringify(r));
    assert.doesNotMatch(r.error, /unknown or missing types/);
    assert.match(r.error, /style/i);
    assert.match(r._fixHint, /band/);
    assert.doesNotMatch(r._fixHint, /Valid block types/);
});

test('cms_add_blocks: an unknown type still gets the type hint when all entries are dropped', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const r = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'nope' }] });
    assert.match(r.error, /unknown or missing types/);
    assert.match(r._fixHint, /Valid block types/);
});

test('cms_add_blocks schema documents the style property', () => {
    const add = TOOL_SCHEMAS.find((t) => t.function.name === 'cms_add_blocks');
    const props = add && add.function.parameters.properties.blocks.items.properties;
    assert.ok(props && props.style, 'style is part of the entry schema');
});
