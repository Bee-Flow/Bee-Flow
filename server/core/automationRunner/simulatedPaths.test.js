// @typecheck
const test = require('node:test');
const assert = require('node:assert/strict');
const { recordSimulatedWrite, isUnderSimulatedPath, isNotFoundError, normalisePath } = require('./simulatedPaths');

test('normalisePath trims and collapses slashes, rejects non-paths', () => {
    assert.equal(normalisePath('X//a/'), '/X/a');
    assert.equal(normalisePath('/'), null);
    assert.equal(normalisePath(''), null);
    assert.equal(normalisePath(5), null);
});

test('below is segment-wise: a prefix sibling is not below', () => {
    const ctx = { _simulatedPaths: new Set() };
    recordSimulatedWrite(ctx, 'nextcloud_upload_file', { path: '/X/a' });
    assert.equal(isUnderSimulatedPath(ctx, 'X/a/'), true);
    assert.equal(isUnderSimulatedPath(ctx, '/X/a/deep'), true);
    assert.equal(isUnderSimulatedPath(ctx, '/X/ab'), false);
    assert.equal(isUnderSimulatedPath(ctx, '/Y'), false);
});

test('move records the destination only; office creators also cover the appended extension', () => {
    const ctx = { _simulatedPaths: new Set() };
    recordSimulatedWrite(ctx, 'nextcloud_move', { source: '/s', destination: '/d/b' });
    recordSimulatedWrite(ctx, 'nextcloud_create_document', { path: '/doc' });
    assert.deepEqual([...ctx._simulatedPaths].sort(), ['/d/b', '/doc', '/doc.docx']);
});

test('record is a no-op without a shared set and for unknown tools', () => {
    const ctx = {};
    recordSimulatedWrite(ctx, 'nextcloud_upload_file', { path: '/X' });
    assert.equal(ctx._simulatedPaths, undefined);
    const withSet = { _simulatedPaths: new Set() };
    recordSimulatedWrite(withSet, 'nextcloud_read_file', { path: '/X' });
    assert.equal(withSet._simulatedPaths.size, 0);
});

test('not-found needs a nextcloud tool and a string error', () => {
    assert.equal(isNotFoundError('nextcloud_read_file', 'File not found: /x'), true);
    assert.equal(isNotFoundError('gmail_read', 'File not found: /x'), false);
    assert.equal(isNotFoundError('nextcloud_read_file', { message: 'not found' }), false);
    assert.equal(isNotFoundError('nextcloud_read_file', 'Nextcloud is not connected'), false);
});

test('an upload implies its parent folders: listing one falls back, but only that exact folder', () => {
    const ctx = { _simulatedPaths: new Set() };
    recordSimulatedWrite(ctx, 'nextcloud_upload_file', { path: '/R/deep/a b/new.txt' });
    recordSimulatedWrite(ctx, 'nextcloud_upload_file', { path: '/R/data.csv' });
    assert.equal(isUnderSimulatedPath(ctx, '/R'), true);
    assert.equal(isUnderSimulatedPath(ctx, '/R/deep'), true);
    assert.equal(isUnderSimulatedPath(ctx, '/R/deep/a b'), true);
    // not widened: a sibling or typo below an implied parent still fails
    assert.equal(isUnderSimulatedPath(ctx, '/R/other'), false);
    assert.equal(isUnderSimulatedPath(ctx, '/R/deep/typo'), false);
    assert.equal(isUnderSimulatedPath(ctx, '/Q'), false);
});

test('office creators imply parents too; move and create_folder do not', () => {
    const ctx = { _simulatedPaths: new Set() };
    recordSimulatedWrite(ctx, 'nextcloud_create_spreadsheet', { path: '/A/B/sheet' });
    recordSimulatedWrite(ctx, 'nextcloud_move', { source: '/s', destination: '/M/N/d' });
    recordSimulatedWrite(ctx, 'nextcloud_create_folder', { path: '/F/G' });
    assert.equal(isUnderSimulatedPath(ctx, '/A/B'), true);
    assert.equal(isUnderSimulatedPath(ctx, '/M/N'), false);
    assert.equal(isUnderSimulatedPath(ctx, '/F'), false);
});
