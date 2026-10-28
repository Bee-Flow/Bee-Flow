// @typecheck
'use strict';

/**
 * A document picker with neither documentIds nor a folder can never offer a
 * document (the access pool only holds what the builder named), so the builder
 * gets a warning; a picker that names either is fine.
 *
 * Run: node --test appStudio/validate/documentPicker.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { checkDocumentPicker } = require('./documentPicker');

/** @param {Record<string, unknown>} props */
function warningsFor(props) {
    /** @type {Array<{ code: string, path: string }>} */
    const warnings = [];
    const ctx = /** @type {import('./shared').ValidationCtx} */ (/** @type {unknown} */ ({ pushW: (/** @type {{ code: string, path: string }} */ w) => warnings.push(w) }));
    checkDocumentPicker(props, 'screens[0].children[1]', ctx);
    return warnings;
}

test('a picker with no documents and no folder is flagged on its documentIds', () => {
    for (const props of [{}, { documentIds: [] }, { documentIds: ['', null] }, { folderId: '' }]) {
        const w = warningsFor(props);
        assert.strictEqual(w.length, 1, JSON.stringify(props));
        assert.strictEqual(w[0].code, 'component.document_picker_empty');
        assert.strictEqual(w[0].path, 'screens[0].children[1].props.documentIds');
    }
});

test('a picker that names documents or a folder is fine', () => {
    assert.deepStrictEqual(warningsFor({ documentIds: ['doc_1'] }), []);
    assert.deepStrictEqual(warningsFor({ folderId: 'fld_1' }), []);
});
