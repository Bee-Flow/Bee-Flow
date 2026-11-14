// @typecheck
/**
 * The organisation's view of its group sync (usecases/orgAzureSyncView.js): the
 * fields it is built from, and when the directory counts as connected.
 *
 * Run: cd server && node --test usecases/orgAzureSyncView.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { groupSyncView } = require('./orgAzureSyncView');

const TENANT = '22222222-2222-2222-2222-222222222222';
const BINDING = { syncOrganizationId: 'orgA', syncTenantId: TENANT };
const MICROSOFT = { clientId: 'app-id', clientSecret: 'app-secret', tenantId: TENANT };

/** @param {Partial<Parameters<typeof groupSyncView>[0]>} over */
const view = (over = {}) => groupSyncView({ orgId: 'orgA', status: null, settings: null, binding: BINDING, microsoft: MICROSOFT, ...over });

test('the directory is connected when the application has an id and a secret and the sync is bound to this org', () => {
    assert.strictEqual(view().directoryConfigured, true);
    assert.strictEqual(view({ microsoft: { ...MICROSOFT, tenantId: 'common' } }).directoryConfigured, true, 'a tenant alias does not contradict the binding');
});

test('the directory is not connected without a secret, without a binding, or bound elsewhere', () => {
    assert.strictEqual(view({ microsoft: { clientId: 'app-id' } }).directoryConfigured, false);
    assert.strictEqual(view({ microsoft: null }).directoryConfigured, false);
    assert.strictEqual(view({ binding: null }).directoryConfigured, false);
    assert.strictEqual(view({ binding: { syncOrganizationId: 'orgB', syncTenantId: TENANT } }).directoryConfigured, false);
    assert.strictEqual(view({ binding: { syncOrganizationId: 'orgA', syncTenantId: 'common' } }).directoryConfigured, false);
    assert.strictEqual(view({ microsoft: { ...MICROSOFT, tenantId: '33333333-3333-3333-3333-333333333333' } }).directoryConfigured, false,
        'a sign-in tenant that differs from the bound one fails the run, so it is not connected');
});

test('only the listed fields come through, whatever the stored rows carry', () => {
    const v = view({
        status: { lastSyncAt: '2026-11-10T10:00:00.000Z', lastSyncResult: 'partial', syncedGroups: 2, syncedUsers: 5, errors: ['x', 'y'], tenantId: TENANT },
        settings: { destructiveSync: true, autoActivateUsers: false, periodicSync: true, syncIntervalHours: 12, clientSecret: 'stray' },
    });
    assert.deepStrictEqual(v, {
        directoryConfigured: true,
        status: { lastSyncAt: '2026-11-10T10:00:00.000Z', lastSyncResult: 'partial', syncedGroups: 2, syncedUsers: 5, errorCount: 2 },
        settings: { destructiveSync: true, autoActivateUsers: false, periodicSync: true, syncIntervalHours: 12 },
    });
});

test('a never-run sync reads as empty status and the default settings', () => {
    assert.deepStrictEqual(view({ binding: null }), {
        directoryConfigured: false,
        status: { lastSyncAt: null, lastSyncResult: null, syncedGroups: 0, syncedUsers: 0, errorCount: 0 },
        settings: { destructiveSync: false, autoActivateUsers: true, periodicSync: false, syncIntervalHours: 6 },
    });
});
