'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const sqls = [];
let shareDeleteError = null;
const restore = installResolveStub({
    '../../db': {
        run: async (sql) => {
            sqls.push(sql);
            if (/DELETE FROM project_shares/.test(sql) && shareDeleteError) throw shareDeleteError;
            return { rowCount: 1 };
        },
        getOne: async () => null,
        getAll: async () => [],
    },
    './schema': { initDB: async () => {} },
    '../lib/groupShareRevoke': { revokeGroupShares: async () => {} },
});
test.after(() => restore());

const { deleteGroup } = require('./groups');

test('a failed project-share cleanup stops the group delete (a reused id would re-grant)', async () => {
    sqls.length = 0;
    shareDeleteError = new Error('connection reset');
    await assert.rejects(deleteGroup('g1'), /connection reset/);
    assert.ok(!sqls.some((s) => /DELETE FROM groups/.test(s)), 'the group row is not deleted');
});

test('a missing project_shares table does not block the delete', async () => {
    sqls.length = 0;
    shareDeleteError = Object.assign(new Error('relation "project_shares" does not exist'), { code: '42P01' });
    assert.strictEqual(await deleteGroup('g1'), true);
});
