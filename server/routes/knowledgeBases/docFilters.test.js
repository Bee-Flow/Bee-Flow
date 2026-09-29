/**
 * documents.js and sources.js filter a document list on `status`/`pii`
 * against the SAME store vocabulary (stores/knowledgeBases.js's
 * DOC_STATUSES / PII_STATUSES). Each file carried its own copy of the two
 * helpers and the two `.refine()` checks — same behaviour today, but two
 * places that can drift apart tomorrow. This pins that there is one
 * implementation (./docFilters) and that both routers use it instead of a
 * local redefinition.
 *
 * Run: cd server && node --test routes/knowledgeBases/docFilters.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { statusFilter, piiFilter, docStatuses, piiFilters } = require('./docFilters');

test('docFilters exports the status/pii schema builders and the vocabularies they read', () => {
    assert.strictEqual(typeof statusFilter, 'function');
    assert.strictEqual(typeof piiFilter, 'function');
    assert.strictEqual(typeof docStatuses, 'function');
    assert.strictEqual(typeof piiFilters, 'function');
    // Built from the real store, not a fixture — same source of truth the
    // two routers read.
    const kbStore = require('../../stores/knowledgeBases');
    assert.deepStrictEqual(docStatuses(), kbStore.DOC_STATUSES || []);
});

// Read through a helper rather than inline: the point below is one compound
// claim per file (import the shared module, don't redefine its helpers),
// not three separate text matches.
function readRouterSource(file) {
    return fs.readFileSync(path.join(__dirname, file), 'utf8');
}

test('documents.js and sources.js both import the shared filters instead of redefining them', () => {
    for (const file of ['documents.js', 'sources.js']) {
        const contents = readRouterSource(file);
        const sharesImplementation = /require\(['"]\.\/docFilters['"]\)/.test(contents)
            && !/const\s+docStatuses\s*=/.test(contents)
            && !/const\s+piiFilters\s*=/.test(contents);
        assert.ok(
            sharesImplementation,
            `${file} must import ./docFilters rather than redefining docStatuses/piiFilters locally`,
        );
    }
});
