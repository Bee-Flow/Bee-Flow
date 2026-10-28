/**
 * cms_update_design: logo and favicon come from an uploaded image of the asset
 * store, validated like the other asset references (no invented keys, no
 * external URLs, images only). The store is real (cmsStore.testkit); only the
 * object-storage lookup is stubbed.
 *
 * Run: node --test cmsBuilder/builderToolsBrandAssets.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('../stores/cmsStore.testkit');

const { clone } = installCmsStoreMocks();

const cmsStore = require('../stores/cmsStore');
const { applyToolCall } = require('./builderTools');

async function makeDraft() {
    const created = await cmsStore.createProject({ name: 'Test site' });
    const site = await cmsStore.getProject(created.id);
    return {
        siteId: created.id,
        userId: 'u1',
        orgId: 'orgA',
        builderSessionId: 'cms_test',
        site,
        pages: new Map(),
        defaultLocale: 'en',
        locales: [],
        createdPageIds: [],
        touchedPageIds: new Set(),
    };
}

test('cms_update_design: logo and favicon accept only an existing uploaded image of the asset store', async () => {
    const storageStore = require('../stores/storageStore');
    const original = storageStore.headFile;
    const existing = new Set(['cms/1700000000000-mark.png', 'cms/1700000000001-clip.mp4']);
    storageStore.headFile = async (key) => {
        if (existing.has(key)) return { contentLength: 1, contentType: 'image/png' };
        const e = new Error('missing'); e.name = 'NoSuchKey'; throw e;
    };
    try {
        const draft = await makeDraft();
        const before = clone(draft.site.design);
        const ok = await applyToolCall(draft, 'cms_update_design', {
            favicon: '/api/cms/asset/cms/1700000000000-mark.png',
            logo: 'cms/1700000000000-mark.png',
            radius: 4,
        });
        assert.ok(!ok.error, JSON.stringify(ok));
        assert.strictEqual(draft.site.design.favicon, 'cms/1700000000000-mark.png', 'url normalised to the key');
        assert.strictEqual(draft.site.design.logo, 'cms/1700000000000-mark.png');
        assert.strictEqual(draft.site.design.colors.primary, before.colors.primary, 'patch keeps the rest');

        // A patch without logo/favicon leaves them alone; "" clears one.
        await applyToolCall(draft, 'cms_update_design', { radius: 8 });
        assert.strictEqual(draft.site.design.favicon, 'cms/1700000000000-mark.png');
        const cleared = await applyToolCall(draft, 'cms_update_design', { favicon: '' });
        assert.ok(!cleared.error, JSON.stringify(cleared));
        assert.strictEqual(draft.site.design.favicon, '');
        assert.strictEqual(draft.site.design.logo, 'cms/1700000000000-mark.png');

        const rejected = [
            ['invented key', { favicon: 'cms/1700000000002-invented.png' }, /does not exist/i],
            ['external url', { logo: 'https://example.com/a.png' }, /not an uploaded image/i],
            ['not an image', { logo: 'cms/1700000000001-clip.mp4' }, /not an uploaded image/i],
            ['path traversal', { logo: 'cms/../secret.png' }, /not an uploaded image/i],
            ['not a string', { favicon: 5 }, /must be a string/i],
        ];
        for (const [name, args, re] of rejected) {
            const r = await applyToolCall(draft, 'cms_update_design', { radius: 1, ...args });
            assert.ok(r.error, `${name}: expected a rejection`);
            assert.match(r.error, re, name);
            assert.ok(r._fixHint, `${name}: carries a fix hint`);
        }
        assert.notStrictEqual(draft.site.design.radius, 1, 'a rejected call persisted nothing');
    } finally {
        storageStore.headFile = original;
    }
});
