// @typecheck
/**
 * cms_add_blocks seeds an empty steps items / security cards list (with a
 * warning) instead of the editor's example text; a given list is kept.
 *
 * Run: node --test cmsBuilder/addBlocksSeeding.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('../stores/cmsStore.testkit');

installCmsStoreMocks();

const cmsStore = require('../stores/cmsStore');
const { applyToolCall } = require('./builderTools');

async function makeDraft() {
    const created = await cmsStore.createProject({ name: 'Seeding site' });
    const site = await cmsStore.getProject(created.id);
    const pages = new Map();
    for (const entry of site.pages) pages.set(entry.id, await cmsStore.getPage(created.id, entry.id));
    return {
        siteId: created.id, userId: 'u1', orgId: 'orgA', builderSessionId: 'cms_test', site, pages,
        defaultLocale: 'en', locales: [], createdPageIds: [], touchedPageIds: new Set(),
    };
}

test('a steps/security block without its own list gets an empty list and a hint, not example items', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const r = await applyToolCall(draft, 'cms_add_blocks', {
        pageId: home,
        blocks: [
            { type: 'steps', content: { title: 'How it works' } },
            { type: 'steps', content: { items: [{ number: '1', title: 'Connect', body: 'Link your tools.' }] } },
            { type: 'security', content: {} },
        ],
    });
    assert.ok(!r.error, JSON.stringify(r));
    const blocks = draft.pages.get(home).blocks;
    assert.deepStrictEqual(blocks[0].content.items, []);
    assert.strictEqual(blocks[1].content.items.length, 1, 'own items kept');
    assert.deepStrictEqual(blocks[2].content.cards, []);
    assert.strictEqual(r.warnings.filter((w) => /no items|no cards|empty/i.test(w)).length, 2);
});
