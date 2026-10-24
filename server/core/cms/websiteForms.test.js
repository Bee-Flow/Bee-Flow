'use strict';

require('../../boot/featureModules'); // core looks feature modules up by name (core/featureModules.js)
const test = require('node:test');
const assert = require('node:assert');
const { declaredFields, consentOf, findFormBlock, webhookTriggerId, validateSubmission } = require('./websiteForms');
const { renderBlocks } = require('../seo/renderBlocks');
const { BLOCK_DEFAULTS, BLOCK_TYPE_IDS } = require('../../i18n/defaults/cmsDefaults');

test('the form block is a registered type with defaults a new block can start from', () => {
    assert.ok(BLOCK_TYPE_IDS.includes('form'));
    const d = BLOCK_DEFAULTS.form;
    assert.strictEqual(d.automationId, '', 'a new form names no automation');
    assert.ok(declaredFields(d).length >= 2);
    assert.strictEqual(consentOf(d).required, true);
});

test('declaredFields keeps the website subset, in order, named by the block field id', () => {
    const fields = declaredFields({
        fields: [
            { id: 'email', type: 'email', label: 'Email', required: true },
            { id: 'upload', type: 'file' },
            { id: 'bad id', type: 'text' },
            { id: 'topic', type: 'select', options: [{ value: 'a', label: 'A' }] },
        ],
    });
    assert.deepStrictEqual(fields.map((f) => [f.name, f.type]), [['email', 'email'], ['topic', 'select']]);
});

test('consent is only required when enabled and worded', () => {
    assert.deepStrictEqual(consentOf({ consent: { enabled: true, text: ' Yes ' } }), { required: true, text: 'Yes' });
    assert.strictEqual(consentOf({ consent: { enabled: true, text: '' } }).required, false);
    assert.strictEqual(consentOf({ consent: { enabled: false, text: 'x' } }).required, false);
    assert.strictEqual(consentOf({}).required, false);
});

test('findFormBlock only finds an enabled form block with a sane id', () => {
    const snap = { pages: { p1: { blocks: [{ id: 'blk_a', type: 'form' }, { id: 'blk_b', type: 'form', enabled: false }, { id: 'blk_c', type: 'faq' }] } } };
    assert.strictEqual(findFormBlock(snap, 'blk_a').pageId, 'p1');
    assert.strictEqual(findFormBlock(snap, 'blk_b'), null);
    assert.strictEqual(findFormBlock(snap, 'blk_c'), null);
    assert.strictEqual(findFormBlock(snap, '../x'), null);
    assert.strictEqual(findFormBlock(null, 'blk_a'), null);
});

test('webhookTriggerId finds the webhook trigger among several', () => {
    const automation = { definition: { trigger: { id: 't0', kind: 'manual' }, triggers: [{ id: 't1', kind: 'webhook' }] } };
    assert.strictEqual(webhookTriggerId(automation), 't1');
    assert.strictEqual(webhookTriggerId({ definition: { trigger: { id: 't0', kind: 'manual' } } }), null);
});

test('validateSubmission reads declared fields only and demands consent when asked', () => {
    const content = { fields: [{ id: 'email', type: 'email', required: true }], consent: { enabled: true, text: 'OK' } };
    const ok = validateSubmission(content, { email: 'a@example.test', other: 'x', consent: true });
    assert.deepStrictEqual(ok, { values: { email: 'a@example.test' }, errors: [] });
    const bad = validateSubmission(content, { email: 'nope' });
    assert.deepStrictEqual(bad.errors.map((e) => e.field).sort(), ['consent', 'email']);
});

test('the server-rendered page carries the form heading and lead for crawlers, not its fields', () => {
    const html = renderBlocks([{ id: 'blk_a', type: 'form', content: { title: 'Request a demo', lead: 'Tell us more.', fields: [{ id: 'email', type: 'email', label: 'Secret label' }], automationId: 'abc' } }]);
    assert.match(html, /<h1>Request a demo<\/h1>/);
    assert.match(html, /Tell us more\./);
    assert.doesNotMatch(html, /Secret label|abc/);
});

test('consentFor prefers the visitor\'s locale override and says where the text came from', () => {
    const { consentFor, formBlocksOf } = require('./websiteForms');
    const block = { id: 'b1', type: 'form', content: { consent: { enabled: true, text: 'Base' } } };
    const snapshot = { pageLocaleOverrides: { p1: { nl: { blocks: { b1: { content: { consent: { text: ' Dutch ' } } } } } } } };
    const found = { block, pageId: 'p1' };
    assert.deepStrictEqual(consentFor(snapshot, found, 'nl'), { required: true, text: 'Dutch', locale: 'nl' });
    assert.deepStrictEqual(consentFor(snapshot, found, 'de'), { required: true, text: 'Base', locale: 'default' });
    assert.deepStrictEqual(consentFor(snapshot, found, '../x'), { required: true, text: 'Base', locale: 'default' });
    assert.deepStrictEqual(consentFor(null, found, undefined), { required: true, text: 'Base', locale: 'default' });

    const pages = [{ id: 'p1', title: 'Contact', blocks: [block, { id: 'b2', type: 'faq' }, { id: 'b3', type: 'form', content: { automationId: ' a1 ' } }] }];
    assert.deepStrictEqual(formBlocksOf(pages), [
        { blockId: 'b1', pageId: 'p1', pageTitle: 'Contact', automationId: '' },
        { blockId: 'b3', pageId: 'p1', pageTitle: 'Contact', automationId: 'a1' },
    ]);
});
