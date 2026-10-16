// @typecheck
/**
 * Authoring-quality warnings (issue #266): content element kinds, style keys
 * in content, placeholder list items, columns on trust-band, integrations
 * without a logo.
 *
 * Run: node --test cmsBuilder/blockQuality.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { BLOCK_DEFAULTS } = require('../i18n/defaults/cmsDefaults');
const { validateSiteDraft } = require('./validate');

/**
 * @param {string} type
 * @param {Record<string, unknown>} content
 * @param {Record<string, unknown>} [style]
 */
function warningsFor(type, content, style) {
    const block = { id: 'b1', type, content, ...(style ? { style } : {}) };
    return validateSiteDraft({
        site: { pages: [{ id: 'p1', slug: 'home', title: 'Home' }] },
        pages: new Map([['p1', { blocks: [block] }]]),
    }).warnings;
}

/** @param {Array<{ code: string }>} ws @param {string} code */
const has = (ws, code) => ws.some((w) => w.code === code);

const contentWith = (/** @type {Array<Record<string, unknown>>} */ elements) => ({
    columnLayout: '1', columns: [{ id: 'c1', elements }],
});

test('content: an element kind the renderer does not know is a warning that lists the kinds', () => {
    const ws = warningsFor('content', contentWith([{ kind: 'banner' }]));
    const w = ws.find((x) => x.code === 'unknown_element_kind');
    assert.ok(w);
    assert.match(String(w.hint), /text, image, video, iframe, cta/);
});

test('content: button and link are accepted aliases of cta', () => {
    const ws = warningsFor('content', contentWith([{ kind: 'button' }, { kind: 'link' }, { kind: 'cta' }]));
    assert.ok(!has(ws, 'unknown_element_kind'));
});

test('a style key placed in content is flagged with a move-to-style hint', () => {
    const ws = warningsFor('trust-band', { ...BLOCK_DEFAULTS['trust-band'], labelStyle: 'plain' });
    const w = ws.find((x) => x.code === 'style_key_in_content');
    assert.ok(w);
    assert.match(String(w.hint), /style/);
});

test('content keys that the block really has are not flagged (content.columns)', () => {
    assert.ok(!has(warningsFor('content', BLOCK_DEFAULTS.content), 'style_key_in_content'));
});

test('steps and security items still holding the seeded text are placeholder_content', () => {
    assert.ok(has(warningsFor('steps', BLOCK_DEFAULTS.steps), 'placeholder_content'));
    assert.ok(has(warningsFor('security', BLOCK_DEFAULTS.security), 'placeholder_content'));
});

test('written steps are not placeholders', () => {
    const items = [{ number: '1', title: 'Connect', body: 'Link your tools.' }];
    assert.ok(!has(warningsFor('steps', { ...BLOCK_DEFAULTS.steps, items }), 'placeholder_content'));
});

test('style.columns is reported on a block without a column grid, not on trust-band', () => {
    const ws = warningsFor('faq', BLOCK_DEFAULTS.faq, { columns: 4 });
    assert.ok(has(ws, 'style_columns_unused'));
    assert.ok(!has(warningsFor('trust-band', BLOCK_DEFAULTS['trust-band'], { columns: 4 }), 'style_columns_unused'));
    assert.ok(!has(warningsFor('features', BLOCK_DEFAULTS.features, { columns: 3 }), 'style_columns_unused'));
});

test('integration tiles with neither logoId nor logoSrc are flagged', () => {
    const categories = [{ title: 'Tools', items: [{ label: 'Alpha', logoId: 'maps' }, { label: 'Beta', icon: 'Star' }] }];
    const ws = warningsFor('integrations', { ...BLOCK_DEFAULTS.integrations, categories });
    const hits = ws.filter((x) => x.code === 'integration_without_logo');
    assert.strictEqual(hits.length, 1);
    assert.match(hits[0].path, /items\[1\]/);
});

test('a content key the block type does not have is flagged as unknown_content_key', () => {
    const ws = warningsFor('faq', { ...BLOCK_DEFAULTS.faq, bogusOption: 1 });
    const hits = ws.filter((x) => x.code === 'unknown_content_key');
    assert.strictEqual(hits.length, 1);
    assert.match(hits[0].path, /content\.bogusOption$/);
});

test('default keys, common design keys and style-in-content keys are not unknown_content_key', () => {
    const content = { ...BLOCK_DEFAULTS.faq, backgroundVariant: 'surface', titleStyle: {}, leadAlign: 'center', labelStyle: 'mono' };
    const ws = warningsFor('faq', content);
    assert.ok(!has(ws, 'unknown_content_key'));
    assert.ok(has(ws, 'style_key_in_content'));
});

test('customer-support and form defaults store no backgroundVariant, so band default can flatten them', () => {
    assert.ok(!('backgroundVariant' in BLOCK_DEFAULTS['customer-support']));
    assert.ok(!('backgroundVariant' in BLOCK_DEFAULTS.form));
});
