/**
 * A published agent or app whose shared_groups cannot be parsed is hidden
 * (fail closed), never shown as if it had no group restriction. The owner of
 * an app still sees it.
 *
 * Run: cd server && node --test stores/sharedGroups.failClosed.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../testUtils/stubRequire');

const ORG = 'org-1';
const rows = {
    agents: [
        { id: 'a-open', owner_id: 'u-owner', organization_id: ORG, shared_groups: '[]', is_published: true },
        { id: 'a-group', owner_id: 'u-owner', organization_id: ORG, shared_groups: '["g-1"]', is_published: true },
        { id: 'a-broken', owner_id: 'u-owner', organization_id: ORG, shared_groups: '{not json', is_published: true },
    ],
    apps: [
        { id: 'p-open', created_by: 'u-owner', organization_id: ORG, shared_groups: '[]' },
        { id: 'p-broken', created_by: 'u-owner', organization_id: ORG, shared_groups: '{not json' },
    ],
};
const db = {
    async exec() {}, async run() { return { rowCount: 0, rows: [] }; }, async getOne() { return null; },
    async getAll(sql) {
        if (/FROM agents a WHERE a\.is_published = TRUE/.test(sql)) return rows.agents.map(r => ({ ...r }));
        if (/FROM apps WHERE is_published = TRUE/.test(sql)) return rows.apps.map(r => ({ ...r }));
        return [];
    },
};

const restore = installResolveStub({
    '../../db': db,
    '../db': db,
    './initSchema': { initDB: async () => {} },
    './agentTools': { getAgentToolsBatch: async () => new Map(), getAgentToolsWithParamsBatch: async () => new Map() },
    './lib/storeInit': { makeStoreInit: () => async () => {} },
});
const { getPublishedAgentsForUser } = require('./agent/agentPublishing');
const { getPublishedAppsForUser } = require('./appStore');
test.after(restore);

test('an agent with unreadable shared_groups is hidden; valid restrictions still apply', async () => {
    const member = (await getPublishedAgentsForUser(['g-1'], null, new Set([ORG]))).map(a => a.id).sort();
    assert.deepEqual(member, ['a-group', 'a-open']);
    const outsider = (await getPublishedAgentsForUser([], null, new Set([ORG]))).map(a => a.id);
    assert.deepEqual(outsider, ['a-open']);
});

test('an app with unreadable shared_groups is hidden from others, still shown to its owner', async () => {
    const other = (await getPublishedAppsForUser(new Set([ORG]), [], 'u-other')).map(a => a.id);
    assert.deepEqual(other, ['p-open']);
    const owner = (await getPublishedAppsForUser(new Set([ORG]), [], 'u-owner')).map(a => a.id).sort();
    assert.deepEqual(owner, ['p-broken', 'p-open']);
});
