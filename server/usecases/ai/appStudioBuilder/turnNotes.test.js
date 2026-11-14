'use strict';

/**
 * The machine notes of a builder turn (./turnNotes.js): what the editor may tell the model about
 * where the person is. Pure, so tested here rather than through the route harness of
 * ../appStudioBuilder.test.js.
 *
 * Run: cd server && node --test usecases/ai/appStudioBuilder/turnNotes.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { sanitizeEditorContext } = require('./turnNotes');

test('sanitizeEditorContext whitelists, bounds and rejects junk', () => {
    assert.strictEqual(sanitizeEditorContext(undefined), null);
    assert.strictEqual(sanitizeEditorContext('nope'), null);
    assert.strictEqual(sanitizeEditorContext({}), null);
    assert.strictEqual(sanitizeEditorContext({ evil: 'x' }), null);

    const full = sanitizeEditorContext({
        screenId: 'scr_abc123',
        nodeId: 'cmp_x1',
        boundTableId: 'tbl_t1',
        templateId: 'crm-pipeline',
        selectedNodeIds: ['cmp_a', 'cmp_b', 42, 'x'.repeat(65), ...Array.from({ length: 30 }, (_, i) => `cmp_extra${i}`)],
        injected: 'dropped',
    });
    assert.strictEqual(full.screenId, 'scr_abc123');
    assert.strictEqual(full.templateId, 'crm-pipeline');
    assert.strictEqual(full.injected, undefined, 'unknown keys dropped');
    assert.strictEqual(full.selectedNodeIds.length, 20, 'selection capped at 20');
    assert.ok(!full.selectedNodeIds.includes(42) && !full.selectedNodeIds.some((s) => s.length > 64), 'non-strings/oversized dropped');

    // oversized scalar ids dropped
    assert.strictEqual(sanitizeEditorContext({ screenId: 'x'.repeat(65) }), null);
});
