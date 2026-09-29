/**
 * The one error shape every source kind answers with: status + code for the
 * routes, errorClass for the runner, `safe` for the App Studio refusal — and
 * the registry of code → errorClass each kind fills in at load.
 *
 * Run: cd server && node --test core/dataEngine/sources/mirror/errors.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { SourceError, registerErrorClasses, isSourceError, MAX_DETAIL, SOURCE_ERROR_NAMES } = require('./errors');

test('a SourceError carries the three properties every caller reads, and only the extras it was given', () => {
    const e = new SourceError(409, 'some_conflict', 'moved', { ref: { fileId: 'f' }, detail: 'd', datatableId: 'tbl_1' });
    assert.ok(e instanceof Error);
    assert.equal(e.name, 'SourceError');
    assert.equal(e.status, 409);
    assert.equal(e.code, 'some_conflict');
    assert.equal(e.safe, true);
    assert.equal(e.errorClass, 'datatable_source_error', 'unregistered code → the generic class');
    assert.deepEqual(e.ref, { fileId: 'f' });
    assert.equal(e.detail, 'd');
    assert.equal(e.datatableId, 'tbl_1');
    const bare = new SourceError(404, 'x', 'y');
    assert.equal('ref' in bare, false);
    assert.equal('detail' in bare, false);
    assert.equal('datatableId' in bare, false);
});

test('a kind registers its code → errorClass map; an explicit errorClass wins', () => {
    registerErrorClasses({ zz_test_code: 'datatable_not_found' });
    assert.equal(new SourceError(404, 'zz_test_code', 'm').errorClass, 'datatable_not_found');
    assert.equal(new SourceError(404, 'zz_test_code', 'm', { errorClass: 'datatable_forbidden' }).errorClass, 'datatable_forbidden');
});

test('isSourceError recognises every kind\'s subclass by name — the integration fakes set the name only', () => {
    assert.equal(isSourceError(new SourceError(500, 'x', 'y')), true);
    for (const name of SOURCE_ERROR_NAMES) {
        const fake = Object.assign(new Error('fake'), { name });
        assert.equal(isSourceError(fake), true, name);
    }
    assert.equal(isSourceError(new Error('plain')), false);
    assert.equal(isSourceError(null), false);
    const { NextcloudSourceError } = require('../nextcloudTable/errors');
    assert.equal(isSourceError(new NextcloudSourceError(403, 'nextcloud_forbidden', 'no')), true);
    assert.ok(new NextcloudSourceError(403, 'nextcloud_forbidden', 'no') instanceof SourceError);
    assert.equal(MAX_DETAIL, 200);
});
