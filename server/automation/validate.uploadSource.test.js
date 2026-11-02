// @typecheck strict
/**
 * An upload step (Nextcloud, Google Drive) takes the file from `sourceHandle`
 * OR from `content`; the tool refuses a call with both. Flagged at save time
 * on `content`, so the step keeps the original bytes (BFSF-490: an attachment
 * upload bound both and failed on every run). A handle read from the wrong
 * field of a "run once per item" row is the existing foreach.item_field_missing.
 *
 * Run: cd server && node --test automation/validate.uploadSource.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition } = require('./validate');

const CODE = 'integration_action.upload_source_and_content';
const lit = (/** @type {unknown} */ value) => ({ kind: 'literal', value });
const HANDLE = { kind: 'ref', path: 'loop.r.output.sourceHandle' };
const CONTENT = { kind: 'expr', expr: 'join(steps.read.output.results[*].output.content, ", ")' };

const withUpload = (/** @type {string} */ tool, /** @type {any} */ inputs) => ({
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'search', type: 'integration_action', tool: 'gmail_search', inputs: { query: lit('has:attachment') } },
        {
            id: 'read', type: 'integration_action', tool: 'gmail_read_attachment',
            forEach: { overRef: 'steps.search.output.results', itemVar: 'm', maxIterations: 10 },
            inputs: { messageId: { kind: 'ref', path: 'loop.m.id' }, attachmentId: { kind: 'ref', path: 'loop.m.id' } },
        },
        {
            id: 'up', type: 'integration_action', tool,
            forEach: { overRef: 'steps.read.output.results', itemVar: 'r', maxIterations: 10 },
            inputs: tool === 'drive_upload_file' ? { name: lit('bon.pdf'), ...inputs } : { path: lit('/Inkoop/bon.pdf'), ...inputs },
        },
    ],
    edges: [{ from: 'trg', to: 'search' }, { from: 'search', to: 'read' }, { from: 'read', to: 'up' }],
});
const found = (/** @type {any} */ r) => [...r.errors, ...r.warnings].filter((/** @type {any} */ e) => e.code === CODE);

test('an upload step that binds both Source handle and Content is flagged on Content', () => {
    for (const tool of ['nextcloud_upload_file', 'drive_upload_file']) {
        const r = validateDefinition(withUpload(tool, { sourceHandle: HANDLE, content: CONTENT }));
        const hits = found(r);
        assert.equal(hits.length, 1, tool);
        assert.equal(hits[0].severity, 'warning');
        assert.equal(hits[0].path, 'steps[up].inputs.content');
        assert.match(hits[0].message, /not both/);
    }
});

test('one source, an empty Source handle or another tool is not flagged', () => {
    for (const inputs of [{ sourceHandle: HANDLE }, { content: CONTENT }, { sourceHandle: lit(''), content: CONTENT }, { sourceHandle: null, content: CONTENT }, { sourceHandle: HANDLE, content: lit(null) }]) {
        assert.deepEqual(found(validateDefinition(withUpload('nextcloud_upload_file', inputs))), [], JSON.stringify(inputs));
    }
    assert.deepEqual(found(validateDefinition(withUpload('nextcloud_write_file', { sourceHandle: HANDLE, content: CONTENT }))), []);
});

test('an empty-text Content next to a handle is still flagged: the tool refuses any string there', () => {
    assert.equal(found(validateDefinition(withUpload('nextcloud_upload_file', { sourceHandle: HANDLE, content: lit('') }))).length, 1);
});

test('a handle read from the row instead of its output is already flagged on the field', () => {
    const r = validateDefinition(withUpload('nextcloud_upload_file', { sourceHandle: { kind: 'ref', path: 'loop.r.sourceHandle' } }));
    const w = /** @type {any} */ (r.warnings.find((/** @type {any} */ e) => e.code === 'foreach.item_field_missing'));
    assert.ok(w, JSON.stringify(r.warnings));
    assert.match(w.message, /loop\.r\.output\.sourceHandle/);
});
