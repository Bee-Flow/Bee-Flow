/**
 * datasetAccess.isUploaderOf — the one rule on whose a genome file is.
 *
 * The routes and the query paths that use it are tested through it
 * (routes/studioAppDatasets.mount.test.js, appStudio/datasetQueryStep.test.js,
 * appStudio/actionExecutor.ai.test.js). These are the edges: who counts as
 * "nobody", and ids that differ only in type.
 *
 * Run: cd server && node --test appStudio/datasetAccess.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isUploaderOf } = require('./datasetAccess');

const ds = { id: 'ds-1', ownerId: 'owner-1', uploaderId: 'alice' };

test('the uploader, and only the uploader', () => {
    assert.equal(isUploaderOf(ds, 'alice'), true);
    assert.equal(isUploaderOf(ds, 'bob'), false);
    assert.equal(isUploaderOf(ds, 'owner-1'), false, 'owning the app is not uploading the file');
});

test('a caller that names nobody is nobody\'s uploader', () => {
    for (const nobody of [undefined, null, '']) {
        assert.equal(isUploaderOf(ds, nobody), false, `userId ${JSON.stringify(nobody)}`);
    }
    // And a row without an uploader answers to no one, not to every caller.
    assert.equal(isUploaderOf({ ...ds, uploaderId: null }, 'alice'), false);
    assert.equal(isUploaderOf({ ...ds, uploaderId: undefined }, undefined), false);
    assert.equal(isUploaderOf(null, 'alice'), false);
});

test('ids compare as text: the manifest column is TEXT, a session id may be a number', () => {
    assert.equal(isUploaderOf({ ...ds, uploaderId: '42' }, 42), true);
    assert.equal(isUploaderOf({ ...ds, uploaderId: '42' }, 420), false);
});
