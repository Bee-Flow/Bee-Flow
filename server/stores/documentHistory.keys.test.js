'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDocumentHistory } = require('./documentHistory');

test('makeDocumentHistory exposes exactly the documented API, in order', () => {
    const h = makeDocumentHistory({ failure: (m) => new Error(m) });
    assert.deepEqual(Object.keys(h), [
        'listVersions', 'getVersion', 'createNamedVersion', 'nameVersion', 'restoreVersion', 'deleteVersion',
        'writeCollabBody', 'recordVersion', 'keepConflictCopy', 'pruneVersions', 'firstAuthorOf', 'revisionSeqOf',
    ]);
});
