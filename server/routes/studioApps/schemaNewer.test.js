/**
 * An app definition written by a newer install (a schemaVersion above what
 * this one reads) on the Studio app routes: a save, a check, a publish and an
 * import are refused with 422 `schema_newer` and write nothing; the read
 * routes keep serving the stored bytes and say so with `schemaNewer: true`.
 *
 * Run: cd server && node --test routes/studioApps/schemaNewer.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'validation-test-session-secret-000000';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');
const { APP_FORMAT, APP_SCHEMA_VERSION } = require('../../appStudio/appPortability');
const { emptyDefinition, SCHEMA_VERSION_CURRENT } = require('../../appStudio/componentSpecs');

const APP_ID = '5b0a7c1e-0000-4000-8000-000000000001';
const BASE = `/api/studio-apps/${APP_ID}`;

/** A definition this install must not touch: one version ahead, with a key it does not know. */
const newerDefinition = () => ({ ...emptyDefinition('From the future'), schemaVersion: SCHEMA_VERSION_CURRENT + 1, futureKey: { keep: 'me' } });

let stored = newerDefinition();
const isWrite = (sql) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql);

const { db, api } = h.routeUnderTest(test, '/api/studio-apps', () => require('../studioApps'), {
    gates: { resolveUserOrgIds: async () => new Set(['org1']) },
    answer: (sql) => {
        if (/^\s*SELECT\b/i.test(sql) && /FROM studio_apps\b/i.test(sql)) {
            return {
                rows: [{
                    id: APP_ID, user_id: h.USER.id, organization_id: 'org1', name: 'From the future',
                    definition: stored, definition_version: 4,
                    published_definition: stored, published_version: 2, is_published: true, shared_groups: [],
                }],
            };
        }
        return undefined;
    },
});
test.beforeEach(() => { stored = newerDefinition(); });

const writes = () => db.all.filter((q) => isWrite(typeof q === 'string' ? q : q.sql || ''));
const assertSchemaNewer = (res) => {
    assert.strictEqual(res.status, 422, JSON.stringify(res.body));
    assert.strictEqual(res.body.code, 'schema_newer');
    assert.match(res.body.error, /newer version/);
};

test('save: a newer definition is refused with 422 schema_newer and nothing is written', async () => {
    const res = await api.call('PUT', `${BASE}/definition`, { body: { definition: newerDefinition(), baseVersion: 4 } });
    assertSchemaNewer(res);
    assert.deepStrictEqual(writes(), []);
});

test('save: a definition tagged with the newest known version is not refused', async () => {
    const res = await api.call('PUT', `${BASE}/definition`, {
        body: { definition: { ...emptyDefinition('Current'), schemaVersion: SCHEMA_VERSION_CURRENT }, baseVersion: 4 },
    });
    assert.notStrictEqual(res.body && res.body.code, 'schema_newer');
});

test('check and publish: refused with 422 schema_newer, nothing is frozen', async () => {
    assertSchemaNewer(await api.call('POST', `${BASE}/check`, { body: {} }));
    assertSchemaNewer(await api.call('PATCH', `${BASE}/publish`, { body: { isPublished: true } }));
    assert.deepStrictEqual(writes(), []);
});

test('read: the stored bytes are served untouched, with schemaNewer: true', async () => {
    const owner = await api.call('GET', BASE);
    assert.strictEqual(owner.status, 200, JSON.stringify(owner.body));
    assert.strictEqual(owner.body.schemaNewer, true);
    assert.deepStrictEqual(owner.body.app.definition, stored);

    const draft = await api.call('GET', `${BASE}/runtime?draft=1`);
    assert.strictEqual(draft.status, 200, JSON.stringify(draft.body));
    assert.strictEqual(draft.body.schemaNewer, true);
    assert.deepStrictEqual(draft.body.definition, stored);

    const published = await api.call('GET', `${BASE}/runtime`);
    assert.strictEqual(published.status, 200, JSON.stringify(published.body));
    assert.strictEqual(published.body.schemaNewer, true);
    assert.deepStrictEqual(published.body.definition, stored);
});

test('read: a definition this install knows carries no flag', async () => {
    stored = emptyDefinition('Today');
    const owner = await api.call('GET', BASE);
    assert.strictEqual(owner.status, 200);
    assert.strictEqual('schemaNewer' in owner.body, false);
    const draft = await api.call('GET', `${BASE}/runtime?draft=1`);
    assert.strictEqual('schemaNewer' in draft.body, false);
    const published = await api.call('GET', `${BASE}/runtime`);
    assert.strictEqual('schemaNewer' in published.body, false);
});

test('import: an archive that carries a newer definition creates no app', async () => {
    const res = await api.call('POST', '/api/studio-apps/import', {
        body: { format: APP_FORMAT, schemaVersion: APP_SCHEMA_VERSION, app: { name: 'Future' }, template: { definition: newerDefinition() } },
    });
    assert.ok(res.status === 400 || res.status === 422, `status ${res.status}`);
    assert.match(JSON.stringify(res.body), /newer version/);
    assert.deepStrictEqual(writes(), []);
});
