// @typecheck
/**
 * A published app whose shared_groups cannot be parsed is hidden (fail closed),
 * never shown as if it had no group restriction. The owner of an app still sees
 * it. (Module "apps"; the same rule for agents: sharedGroups.failClosed.test.js.)
 *
 * Run: cd server && node --test stores/sharedGroups.failClosed.apps.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../testUtils/stubRequire');

const ORG = 'org-1';
const apps = [
    { id: 'p-open', created_by: 'u-owner', organization_id: ORG, shared_groups: '[]' },
    { id: 'p-broken', created_by: 'u-owner', organization_id: ORG, shared_groups: '{not json' },
];
const db = {
    async exec() {}, async run() { return { rowCount: 0, rows: [] }; }, async getOne() { return null; },
    async getAll(sql) {
        if (/FROM apps WHERE is_published = TRUE/.test(sql)) return apps.map(r => ({ ...r }));
        return [];
    },
};

const restore = installResolveStub({
    '../db': db,
    './lib/storeInit': { makeStoreInit: () => async () => {} },
});
const { getPublishedAppsForUser } = require('./appStore');
test.after(restore);

test('an app with unreadable shared_groups is hidden from others, still shown to its owner', async () => {
    const other = (await getPublishedAppsForUser(new Set([ORG]), [], 'u-other')).map(a => a.id);
    assert.deepEqual(other, ['p-open']);
    const owner = (await getPublishedAppsForUser(new Set([ORG]), [], 'u-owner')).map(a => a.id).sort();
    assert.deepEqual(owner, ['p-broken', 'p-open']);
});
