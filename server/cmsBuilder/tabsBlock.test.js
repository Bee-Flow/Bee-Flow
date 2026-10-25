// @typecheck noImplicitAny
/**
 * The `tabs` block (issue #238): catalogue entry, seeded defaults, the
 * validator's warnings and the server-rendered (pre-hydration) HTML.
 *
 * Run: node --test cmsBuilder/tabsBlock.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { BLOCK_DEFAULTS, BLOCK_TYPE_IDS, TABS_MIN, TABS_MAX } = require('../i18n/defaults/cmsDefaults');
const { validateSiteDraft } = require('./validate');
const { renderBlocks } = require('../core/seo/renderBlocks');

/** @param {Record<string, unknown>} content */
function draftWith(content) {
    // A partial draft: the validator reads only the page list and the blocks.
    return /** @type {Parameters<typeof validateSiteDraft>[0]} */ ({
        site: { pages: [{ id: 'p1', slug: 'home', title: 'Home' }] },
        pages: new Map([['p1', { blocks: [{ id: 'b1', type: 'tabs', content }] }]]),
    });
}

/** @param {Record<string, unknown>} content */
const codes = (content) => validateSiteDraft(draftWith(content)).warnings.map((w) => w.code);

const tab = (/** @type {string} */ id, /** @type {string} */ label) => ({ tabId: id, label, title: `${label} heading`, body: `${label} body` });

test('tabs is in the catalogue and seeds two tabs with stable ids', () => {
    assert.ok(BLOCK_TYPE_IDS.includes('tabs'));
    const items = BLOCK_DEFAULTS.tabs.items;
    assert.strictEqual(items.length, TABS_MIN);
    assert.strictEqual(new Set(items.map((i) => i.tabId)).size, items.length);
    assert.ok(items.every((i) => i.cta === null));
});

test('the seeded defaults validate clean', () => {
    assert.deepStrictEqual(codes(BLOCK_DEFAULTS.tabs), []);
});

test('one tab, or more than the maximum, is a warning (never an error)', () => {
    assert.ok(codes({ items: [tab('a', 'A')] }).includes('tabs_count'));
    const many = Array.from({ length: TABS_MAX + 1 }, (_, i) => tab(`t${i}`, `T${i}`));
    assert.ok(codes({ items: many }).includes('tabs_count'));
    assert.strictEqual(validateSiteDraft(draftWith({ items: many })).ok, true);
});

test('an empty label and a repeated tabId are reported', () => {
    const c = codes({ items: [tab('a', 'A'), { ...tab('a', ''), label: ' ' }] });
    assert.ok(c.includes('tabs_empty_label'));
    assert.ok(c.includes('tabs_duplicate_id'));
});

test('every tab\'s text is in the server-rendered HTML, escaped, with an internal CTA as a link', () => {
    const html = renderBlocks([{
        type: 'tabs',
        content: {
            title: 'For every team',
            items: [
                { ...tab('it', 'IT'), body: 'Runs <b>on</b> your servers', cta: { label: 'Read more', link: { href: '/security' } } },
                tab('legal', 'Legal'),
            ],
        },
    }]);
    assert.match(html, /<h2>For every team<\/h2>|<h1>For every team<\/h1>/);
    for (const text of ['IT', 'IT heading', 'Legal', 'Legal heading', 'Legal body']) {
        assert.ok(html.includes(`>${text}<`), `${text} is rendered`);
    }
    assert.match(html, /Runs &lt;b&gt;on&lt;\/b&gt; your servers/);
    assert.match(html, /<a href="\/security">Read more<\/a>/);
    assert.ok(!html.includes('tab-1') && !html.includes('"it"'), 'tabId is structural, not prose');
});
