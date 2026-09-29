/**
 * routes/automation/versionHistory.js — the Versions tab endpoints over a real
 * Express app, with the store and the access guard injected (no module mocking).
 *
 * Proven:
 *   - the list carries savedBy, isLive/liveSince, isEditing and runs per version;
 *     a run-count failure leaves runs null rather than failing the tab;
 *   - one version reads by number, 'live', 'working' or row id; the working
 *     version reads the working copy (a drag without a version shows);
 *   - the field diff of vN against 'live' names each change, with stepIds and
 *     a description; unknown versions are 404 with a code;
 *   - naming a version needs edit; bad bodies are 400 by name;
 *   - a stranger gets the guard's 403.
 *
 * Run: cd server && node --test routes/automation/versionHistory.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { makeVersionHistoryHandlers } = require('./versionHistory');
const { serve } = require('../../core/http/routeHarness');
const { accessByRole } = require('./testing/accessByRole');

const V1 = {
    trigger: { id: 't', kind: 'manual' },
    steps: [{ id: 'read', type: 'integration_action', tool: 'nextcloud_list_files', label: 'Read invoice', inputs: { folder: { kind: 'literal', value: '/Invoices' } } }],
    edges: [{ from: 't', to: 'read' }],
};
const V2 = JSON.parse(JSON.stringify(V1));
V2.steps[0].inputs.folder.value = '/Invoices/2026';
const WORKING = JSON.parse(JSON.stringify(V2));
WORKING.steps[0].position = { x: 500, y: 20 }; // a drag after v2, no version

const automation = {
    id: 'a1', userId: 'owner', version: 2, liveVersion: 1, liveAt: '2026-09-20T08:00:00.000Z', pendingChanges: 1,
    definition: WORKING,
};
Object.defineProperty(automation, 'liveDefinition', { value: V1, enumerable: false });

const ROWS = {
    1: { id: 'row-1', automationId: 'a1', version: 1, definition: V1, savedByUserId: 'owner', savedByName: 'Olga', savedAt: '2026-09-20T07:00:00.000Z', name: null, description: 'Created', descriptionJson: [{ code: 'created', params: {} }], isLayoutOnly: false },
    2: { id: 'row-2', automationId: 'a1', version: 2, definition: V2, savedByUserId: 'owner', savedByName: 'Olga', savedAt: '2026-09-28T10:55:00.000Z', name: null, description: 'Folder changed in "Read invoice"', descriptionJson: [{ code: 'setting_changed', params: { setting: 'Folder', settingKey: 'folder', step: 'Read invoice' } }], isLayoutOnly: false },
};

let runsFail = false;
const renamed = [];
const store = {
    async getAutomation(id) { return id === 'a1' ? automation : null; },
    async listVersions() { return [ROWS[2], ROWS[1]].map((r) => { const { definition, ...rest } = r; return rest; }); },
    async getVersion(id) { return Object.values(ROWS).find((r) => r.id === id) || null; },
    async getVersionByNumber(aid, n) { return aid === 'a1' ? ROWS[n] || null : null; },
    async renameVersion(aid, n, name) {
        if (!ROWS[n]) return null;
        renamed.push([n, name]);
        return { id: ROWS[n].id, version: n, name };
    },
    async countRunsByVersion() {
        if (runsFail) throw new Error('db down');
        return new Map([[1, { total: 36, failed: 1 }]]);
    },
};

const access = accessByRole({ owner: 'owner', viewer: 'view', runner: 'run' });

let api;
const quiet = { warn() {}, error() {} };

before(() => {
    const h = makeVersionHistoryHandlers({ store, access, log: quiet, resolveNames: async () => ({ agent: {} }) });
    const router = express.Router();
    router.get('/:id/versions', h.list);
    router.get('/:id/versions/:versionId', h.getOne);
    router.get('/:id/versions/:versionId/fielddiff/:other', h.diff);
    router.put('/:id/versions/:versionId/name', h.rename);
    api = serve('/', router);
});
after(() => api.close());

const call = (method, path, body, user = 'owner') => api.call(method, path, { body, user: { id: user } });

test('the list: savedBy, live and editing flags, runs per version', async () => {
    const { status, body } = await call('GET', '/a1/versions');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.liveVersion, 1);
    assert.strictEqual(body.workingVersion, 2);
    assert.strictEqual(body.pendingChanges, 1);
    const [v2, v1] = body.versions;
    assert.deepStrictEqual(
        { version: v2.version, savedBy: v2.savedBy, isLive: v2.isLive, liveSince: v2.liveSince, isEditing: v2.isEditing, runs: v2.runs },
        { version: 2, savedBy: { id: 'owner', name: 'Olga' }, isLive: false, liveSince: null, isEditing: true, runs: { total: 0, failed: 0 } },
    );
    assert.deepStrictEqual(
        { isLive: v1.isLive, liveSince: v1.liveSince, isEditing: v1.isEditing, runs: v1.runs, descriptionJson: v1.descriptionJson },
        { isLive: true, liveSince: '2026-09-20T08:00:00.000Z', isEditing: false, runs: { total: 36, failed: 1 }, descriptionJson: [{ code: 'created', params: {} }] },
    );
});

test('run counts that cannot be read leave runs null, the list still answers', async () => {
    runsFail = true;
    try {
        const { status, body } = await call('GET', '/a1/versions');
        assert.strictEqual(status, 200);
        assert.strictEqual(body.versions[0].runs, null);
    } finally { runsFail = false; }
});

test('one version reads by number, live, working or row id; working shows the latest drag', async () => {
    const byNumber = await call('GET', '/a1/versions/1');
    assert.strictEqual(byNumber.status, 200);
    assert.strictEqual(byNumber.body.version.version, 1);
    assert.strictEqual(byNumber.body.version.isLive, true);
    assert.strictEqual(byNumber.body.version.readOnly, true);
    assert.deepStrictEqual((await call('GET', '/a1/versions/live')).body.version.definition, V1);
    const working = await call('GET', '/a1/versions/working');
    assert.deepStrictEqual(working.body.version.definition.steps[0].position, { x: 500, y: 20 });
    assert.strictEqual(working.body.version.isEditing, true);
    assert.strictEqual((await call('GET', '/a1/versions/row-2')).body.version.version, 2);
    const missing = await call('GET', '/a1/versions/9');
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.body.code, 'version_not_found');
});

test('the field diff of the working version against live, positions ignored', async () => {
    const { status, body } = await call('GET', '/a1/versions/2/fielddiff/live');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.version, 2);
    assert.strictEqual(body.other, 1);
    assert.deepStrictEqual(body.changes, [{
        stepId: 'read', stepNumber: 2, stepLabel: 'Read invoice', change: 'changed',
        setting: 'folder', settingLabel: 'Folder', path: 'inputs.folder', before: '/Invoices', after: '/Invoices/2026',
    }]);
    assert.deepStrictEqual(body.stepIds, { added: [], removed: [], changed: ['read'] });
    assert.strictEqual(body.description, 'Folder changed in "Read invoice"');
    assert.strictEqual(body.layoutOnly, false);
    const same = await call('GET', '/a1/versions/1/fielddiff/1');
    assert.deepStrictEqual(same.body.changes, []);
    assert.strictEqual(same.body.layoutOnly, true);
});

test('naming: edit only, null clears, bad bodies and unknown versions are refused by name', async () => {
    const ok = await call('PUT', '/a1/versions/1/name', { name: '  Go-live  ' });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(ok.body.version, { id: 'row-1', version: 1, name: 'Go-live', isLive: true, liveSince: '2026-09-20T08:00:00.000Z', isEditing: false });
    const cleared = await call('PUT', '/a1/versions/1/name', { name: '' });
    assert.strictEqual(cleared.body.version.name, null);
    assert.deepStrictEqual(renamed.slice(-2), [[1, 'Go-live'], [1, null]]);
    const tooLong = await call('PUT', '/a1/versions/1/name', { name: 'x'.repeat(81) });
    assert.strictEqual(tooLong.status, 400);
    assert.strictEqual(tooLong.body.code, 'invalid_request');
    const extra = await call('PUT', '/a1/versions/1/name', { name: 'a', color: 'red' });
    assert.strictEqual(extra.status, 400);
    const unknown = await call('PUT', '/a1/versions/9/name', { name: 'a' });
    assert.strictEqual(unknown.status, 404);
    const viewer = await call('PUT', '/a1/versions/1/name', { name: 'a' }, 'viewer');
    assert.strictEqual(viewer.status, 403);
    assert.strictEqual(viewer.body.need, 'edit');
});

test('run-only and strangers cannot read the history', async () => {
    assert.strictEqual((await call('GET', '/a1/versions', undefined, 'runner')).status, 403);
    assert.strictEqual((await call('GET', '/a1/versions/2/fielddiff/live', undefined, 'nobody')).status, 403);
    assert.strictEqual((await call('GET', '/zz/versions')).status, 404);
});
