/**
 * What the App Studio CRUD and import routes tell the client when the store
 * fails (routes/studioApps/crud.js, routes/studioApps/appImport.js).
 *
 * Each handler used to log and answer its own 500 ("Failed to list apps").
 * They now let the error reach the terminal handler, which answers a generic
 * 500 with a correlationId and no text from the failure.
 *
 * Run: cd server && node --test routes/studioApps.errors.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../testUtils/routeHarness');
const { APP_FORMAT, APP_SCHEMA_VERSION } = require('../appStudio/appPortability');
const { emptyDefinition } = require('../appStudio/componentSpecs');

const LEAKS = /terminating|db-primary|5432/;
let failing = false;
const { api } = h.routeUnderTest(test, '/api/studio-apps', () => require('./studioApps'), {
    answer: (sql) => {
        if (failing && /^\s*(INSERT|UPDATE|DELETE|SELECT)\b/i.test(sql)) {
            throw Object.assign(new Error('terminating connection on db-primary.internal:5432'), { code: '57P01' });
        }
        return undefined;
    },
});
test.afterEach(() => { failing = false; });

function assertGeneric500(res) {
    assert.strictEqual(res.status, 500, res.text);
    assert.strictEqual(res.body.error, 'Internal server error');
    assert.ok(res.body.correlationId, 'the client can quote a correlationId');
    assert.doesNotMatch(res.text, LEAKS);
}

test('a store failure on the CRUD routes is the generic 500', async () => {
    failing = true;
    assertGeneric500(await api.call('GET', '/api/studio-apps/mine'));
    assertGeneric500(await api.call('GET', '/api/studio-apps/app1'));
    assertGeneric500(await api.call('DELETE', '/api/studio-apps/app1'));
});

test('a store failure on import is the generic 500', async () => {
    failing = true;
    assertGeneric500(await api.call('POST', '/api/studio-apps/import', {
        body: {
            format: APP_FORMAT,
            schemaVersion: APP_SCHEMA_VERSION,
            app: { name: 'Requests' },
            template: { definition: emptyDefinition('Requests') },
        },
    }));
});
