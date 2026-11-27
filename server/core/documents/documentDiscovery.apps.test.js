'use strict';
/**
 * The App Studio half of documentDiscovery.test.js: the builder's `app_list_documents`
 * (appStudio/builderTools/dataTools.js) over the same document store. Owned by the apps module.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../testUtils/stubRequire');

let listResult = [];
const restore = installResolveStub({ '../../stores/documentStore': { listTemplates: async () => listResult, getDocument: async () => null } });
test.after(restore);

test('app_list_documents is built from an explicit allow-list of fields', async () => {
    const { applyListDocuments } = require('../../appStudio/builderTools/dataTools');
    listResult = [{ id: 'd1', name: 'Quote', docType: 'letter', kind: 'document', versionId: 'v1',
        userId: 'other-user', updatedBy: 'other-user', projectId: 'p1', htmlSize: 9, schemaVersion: 2,
        parameters: [{ key: 'a' }], sections: [{ id: 's', title: 'Full section' }],
        placeholders: [{ key: 'a', kind: 'text' }] }];
    const out = await applyListDocuments({ userId: 'owner' });
    assert.deepEqual(out.documents, [{ documentId: 'd1', name: 'Quote', docType: 'letter', kind: 'document', versionId: 'v1', placeholders: [{ key: 'a', kind: 'text' }] }]);
});
