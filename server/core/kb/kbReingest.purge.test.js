'use strict';

// A deletion (strict) must not go on when the local chunks could not be removed.

const test = require('node:test');
const assert = require('node:assert');

const { purgeDocumentChunks } = require('./kbReingest');

test('strict purge throws when the local chunk delete fails', async () => {
    const deleteLocal = async () => { throw new Error('connection reset'); };
    await assert.rejects(purgeDocumentChunks('kb', 'doc', 't', { strict: true, deleteLocal }), /local chunk cleanup failed for document doc/);
});

test('a missing kb_chunks table is not an error', async () => {
    const deleteLocal = async () => { throw Object.assign(new Error('relation "kb_chunks" does not exist'), { code: '42P01' }); };
    await purgeDocumentChunks('kb', 'doc', 't', { strict: false, deleteLocal });
});
