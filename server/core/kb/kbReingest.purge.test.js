'use strict';

// A deletion (strict) must not go on when the local chunks could not be removed.

const test = require('node:test');
const assert = require('node:assert');

const ingestPath = require.resolve('./localKBIngest');
let deleteImpl = async () => {};
require.cache[ingestPath] = {
    id: ingestPath, filename: ingestPath, loaded: true,
    exports: { deleteChunksLocally: (...a) => deleteImpl(...a) },
};
const { purgeDocumentChunks } = require('./kbReingest');

test('strict purge throws when the local chunk delete fails', async () => {
    deleteImpl = async () => { throw new Error('connection reset'); };
    await assert.rejects(purgeDocumentChunks('kb', 'doc', 't', { strict: true }), /local chunk cleanup failed for document doc/);
});

test('a missing kb_chunks table is not an error', async () => {
    deleteImpl = async () => { throw Object.assign(new Error('relation "kb_chunks" does not exist'), { code: '42P01' }); };
    await purgeDocumentChunks('kb', 'doc', 't', { strict: false });
});
