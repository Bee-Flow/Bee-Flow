/**
 * Restoring a published snapshot (POST /:id/versions/:versionId/restore): the
 * snapshot goes back verbatim and the answer carries what the definition gate
 * found; only a snapshot written by a newer install is refused (409), and then
 * nothing is written.
 *
 * Run: cd server && node --test routes/studioApps/versionRestoreGate.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'validation-test-session-secret-000000';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');
const { emptyDefinition, SCHEMA_VERSION_CURRENT } = require('../../appStudio/componentSpecs');

const APP_ID = '5b0a7c1e-0000-4000-8000-000000000002';
const VERSION_ID = '5b0a7c1e-0000-4000-8000-0000000000aa';
const URL = `/api/studio-apps/${APP_ID}/versions/${VERSION_ID}/restore`;

let snapshot = emptyDefinition('Snapshot');
/** Statements that change an app or its snapshots (the stores' own schema bookkeeping is not what is asked here). */
const isAppWrite = (sql) => {
    const s = sql.trimStart().toUpperCase();
    return (s.startsWith('INSERT') || s.startsWith('UPDATE') || s.startsWith('DELETE')) && s.includes('STUDIO_APP');
};

const { db, api } = h.routeUnderTest(test, '/api/studio-apps', () => require('../studioApps'), {
    gates: { resolveUserOrgIds: async () => new Set(['org1']) },
    answer: (sql) => {
        const s = sql.trimStart().toUpperCase();
        if (s.startsWith('SELECT') && sql.includes('FROM studio_app_versions')) {
            return { rows: [{ id: VERSION_ID, app_id: APP_ID, user_id: h.USER.id, version: 1, definition: snapshot }] };
        }
        if (s.startsWith('SELECT') && sql.includes('FROM studio_apps')) {
            return { rows: [{ id: APP_ID, user_id: h.USER.id, organization_id: 'org1', project_id: null, name: 'App', definition: emptyDefinition('Now'), definition_version: 4 }] };
        }
        if (s.startsWith('UPDATE STUDIO_APPS')) {
            return { rows: [{ id: APP_ID, user_id: h.USER.id, organization_id: 'org1', name: 'App', definition: snapshot, definition_version: 5 }] };
        }
        return undefined;
    },
});
const writes = () => db.calls.filter((c) => isAppWrite(c.sql));

test('a snapshot written by a newer install is refused with 409 schema_newer and nothing is written', async () => {
    snapshot = { ...emptyDefinition('Later'), schemaVersion: SCHEMA_VERSION_CURRENT + 1 };
    const res = await api.call('POST', URL, { body: {} });
    assert.strictEqual(res.status, 409, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'schema_newer');
    assert.match(res.body.error, /newer version/);
    assert.deepStrictEqual(writes(), []);
});

test('a snapshot with validator errors is restored verbatim and the findings come back', async () => {
    snapshot = { schemaVersion: 2, actions: {} };
    const res = await api.call('POST', URL, { body: {} });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.version, 5);
    assert.ok(res.body.findings.errors.some((e) => e.code === 'screens.missing'), JSON.stringify(res.body.findings));
    assert.ok(Array.isArray(res.body.findings.warnings) && Array.isArray(res.body.findings.repairs));
    const [update] = writes();
    assert.ok(update, 'the restore wrote');
    assert.strictEqual(update.params[0], JSON.stringify(snapshot), 'the snapshot bytes, not a canonicalized copy');
});

test('a clean snapshot restores with empty findings', async () => {
    snapshot = emptyDefinition('Snapshot');
    const res = await api.call('POST', URL, { body: {} });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.findings.errors, []);
});
