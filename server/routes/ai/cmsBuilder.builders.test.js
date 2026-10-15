'use strict';
// Characterisation of the pure prompt/payload builders of the CMS builder.
// Goes through the route's `_test` surface, so it pins the same output
// before and after the builders moved to cmsBuilderMessages.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./cmsBuilder')._test;
const { BLOCK_TYPE_IDS } = require('../../i18n/defaults/cmsDefaults');

test('machine-message prefixes are frozen', () => {
    assert.equal(T.VALIDATION_NOTE_PREFIX, '[VALIDATION REPORT — machine-generated, not from the human user]');
    assert.equal(T.DRAFT_STATE_PREFIX, "[SITE STATE — machine-generated: the site's current pages and blocks with their REAL ids]");
    assert.equal(T.EDITOR_CONTEXT_PREFIX, '[EDITOR CONTEXT — machine-generated: what the user is looking at]');
    assert.equal(T.BLOCK_FEEDBACK_PREFIX, '[BLOCK FEEDBACK — machine-generated]');
});

test('renderValidationNote', () => {
    assert.equal(
        T.renderValidationNote({ errors: [{ code: 'a', path: 'p' }], warnings: [{ code: 'w1' }, { code: 'w1' }, { code: 'w2' }, null] }),
        `${T.VALIDATION_NOTE_PREFIX}\nFix every error below before you finish. Each record has {code, path, message, hint}; the hint tells you what to do next.\n[{"code":"a","path":"p"}]\nwarnings(4): w1, w2`,
    );
    assert.equal(
        T.renderValidationNote({ errors: 'x' }),
        `${T.VALIDATION_NOTE_PREFIX}\nFix every error below before you finish. Each record has {code, path, message, hint}; the hint tells you what to do next.\n[]`,
    );
});

test('renderBlockFeedbackNote', () => {
    assert.equal(
        T.renderBlockFeedbackNote(['foo', 'foo', 'bar']),
        `${T.BLOCK_FEEDBACK_PREFIX}\nYour cms_add_blocks call included unknown block type(s): "foo", "bar" — those blocks were DROPPED and are NOT on the page. Re-add that content using only the valid types: ${BLOCK_TYPE_IDS.join(', ')}.`,
    );
});

test('editor context: sanitize + render', () => {
    assert.equal(T.sanitizeEditorContext(null), null);
    assert.equal(T.sanitizeEditorContext([]), null);
    assert.equal(T.sanitizeEditorContext({ activePageId: '' }), null);
    assert.deepEqual(T.sanitizeEditorContext({ activePageId: 'p', activeBlockId: 5, activeLocale: 'nl', x: 1 }), { activePageId: 'p', activeLocale: 'nl' });
    assert.equal(T.renderEditorContextNote(null), null);
    assert.equal(
        T.renderEditorContextNote({ activePageId: 'p', activeBlockId: 'b', activeLocale: 'nl' }),
        `${T.EDITOR_CONTEXT_PREFIX}\nopen page: p\nselected block: b\nviewing locale: nl\nWhen the user says "this"/"here", they most likely mean the ids above.`,
    );
});

test('sanitizeHistory', () => {
    assert.deepEqual(T.sanitizeHistory(null), []);
    const many = Array.from({ length: 50 }, (_, i) => ({ role: 'user', content: `m${i}`, extra: 1 }));
    const out = T.sanitizeHistory([
        { role: 'system', content: 's' },
        { role: 'user', content: `${T.VALIDATION_NOTE_PREFIX} x` },
        { role: 'user', content: `${T.DRAFT_STATE_PREFIX} x` },
        { role: 'assistant', content: `${T.EDITOR_CONTEXT_PREFIX} x` },
        { role: 'assistant', content: `${T.BLOCK_FEEDBACK_PREFIX} x` },
        { role: 'assistant', content: 5 },
        ...many,
    ]);
    assert.equal(out.length, 40);
    assert.deepEqual(out[0], { role: 'user', content: 'm10' });
    assert.deepEqual(out[39], { role: 'user', content: 'm49' });
});

test('labelForTool + summariseToolResult', () => {
    assert.equal(T.labelForTool('cms_add_blocks'), 'Added blocks');
    assert.equal(T.labelForTool('zzz'), 'zzz');
    const s = T.summariseToolResult;
    assert.equal(s('x', {}, { error: 'bad   thing' }), 'bad thing');
    assert.equal(s('x', {}, { error: 'e'.repeat(200) }), `${'e'.repeat(140)}…`);
    assert.equal(s('cms_list_site', {}, { pages: [1, 2] }), '2 page(s) on the site');
    assert.equal(s('cms_list_site', {}, null), '0 page(s) on the site');
    assert.equal(s('cms_get_page', { pageId: 'p1' }, { meta: { slug: 'a' } }), 'Read page /a');
    assert.equal(s('cms_get_page', { pageId: 'p1' }, {}), 'Read page p1');
    assert.equal(s('cms_create_page', { title: 'T' }, { slug: 's' }), 'Created "T" at /s');
    assert.equal(s('cms_update_page_meta', { pageId: 'p1' }, { page: { slug: 'q' } }), 'Updated settings for /q');
    assert.equal(s('cms_update_page_seo', { pageId: 'p1' }, {}), 'Updated SEO for p1');
    assert.equal(s('cms_add_blocks', {}, { blockIds: [1, 2], dropped: [1] }), 'Added 2 block(s), 1 dropped (unknown type)');
    assert.equal(s('cms_add_blocks', {}, {}), 'Added 0 block(s)');
    assert.equal(s('cms_update_block', { blockId: 'b' }, { type: 'hero', enabled: false }), 'Edited hero b (hidden)');
    assert.equal(s('cms_update_block', { blockId: 'b' }, {}), 'Edited block b');
    assert.equal(s('cms_remove_block', { blockId: 'b' }, {}), 'Removed block b');
    assert.equal(s('cms_reorder_blocks', {}, { order: [1, 2, 3] }), 'Reordered 3 block(s)');
    assert.equal(s('cms_set_homepage', { pageId: 'p' }, {}), 'Homepage is now p');
    assert.equal(s('cms_reorder_pages', {}, {}), 'Reordered 0 page(s)');
    assert.equal(s('cms_update_header_nav', {}, { navCount: 3 }), '3 menu item(s) in the header');
    assert.equal(s('cms_update_header_nav', {}, {}), '0 menu item(s) in the header');
    assert.equal(s('cms_update_design', {}, {}), 'Design updated');
    assert.equal(s('cms_update_design', {}, { summary: 'ok' }), 'ok');
    assert.equal(s('unknown', {}, {}), '');
});

test('parseToolArgs + truncateJson', () => {
    const p = T.parseToolArgs;
    assert.deepEqual(p({ a: 1 }, 'x'), { args: { a: 1 }, truncated: false });
    assert.deepEqual(p(5, 'x'), { args: {}, truncated: false });
    assert.deepEqual(p(' {} ', 'x'), { args: {}, truncated: false });
    assert.deepEqual(p('{"a":1}', 'x'), { args: { a: 1 }, truncated: false });
    assert.deepEqual(p('{"a":', 'x'), { args: {}, truncated: true });
    assert.deepEqual(p('{"a":', 'cms_list_site'), { args: {}, truncated: false });
    assert.equal(T.truncateJson({ a: 1 }), '{"a":1}');
    assert.equal(T.truncateJson(undefined), 'null');
    const circ = {}; circ.c = circ;
    assert.equal(T.truncateJson(circ), '{"error":"unserializable tool result"}');
    assert.deepEqual(JSON.parse(T.truncateJson({ s: 'x'.repeat(300) }, 250)), { _truncated: true, preview: `{"s":"${'x'.repeat(44)}` });
});
