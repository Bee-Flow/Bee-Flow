/**
 * The golden behaviour of studioAppStore, pinned before it was split into
 * stores/studioApp/* modules behind the `studioAppStore` barrel.
 *
 * `../db` is replaced by request string (as the other hermetic store tests do)
 * with a double that records every statement IN ORDER across the helper
 * functions and the transaction client; the lazily required collaborators
 * (per-app database, storage, automation-usage index, managed-write guard,
 * project membership) are preloaded under their real paths and record their
 * calls into the same trace. What is pinned: the exported keys and their
 * types, and per main path the trace and the value handed back. A pure move
 * must leave every one of them as is.
 *
 * Regenerate (only for an intended behaviour change):
 *   UPDATE_GOLDEN=1 node --test stores/studioAppStore.characterisation.test.js
 * Run: cd server && node --test stores/studioAppStore.characterisation.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createRecordingDb } = require('../testUtils/mockDb');
const { installResolveStub, preloadStubs } = require('../testUtils/stubRequire');

process.env.NODE_ENV = 'test';

const GOLDEN = path.join(__dirname, 'studioAppStore.characterisation.golden.json');
const TRACE = [];
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

// ── Fixtures ─────────────────────────────────────────────────────────
const T = '2026-01-01T00:00:00.000Z';
const appRow = (over = {}) => ({
    id: 'app-1', user_id: 'u1', organization_id: 'org1', project_id: null, name: 'One', description: '',
    icon: null, accent_color: null, category: null, definition: '{"schemaVersion":1,"theme":{"primary":"#112233"}}',
    definition_version: 4, published_definition: null, published_version: null,
    builder_session: '{"version":2,"messages":[]}', is_published: false, shared_groups: '[]',
    nextcloud_menu: false, published_at: null, created_at: T, updated_at: T,
    template_id: null, template_version: null, template_install_hash: null, ...over,
});
const tables = {
    studio_app_versions: [
        { id: 'v-1', app_id: 'app-1', user_id: 'u1', definition: '{"v":1}', summary: 'Published', created_at: T },
    ],
    studio_app_public_pages: [
        { id: 'tok-1', app_id: 'app-1', created_by: 'u1', created_at: T, last_seen_at: null, visits: 3 },
    ],
    studio_app_attachments: [
        { app_id: 'app-1', owner_user_id: 'u1', sha256: 'aa' },
        { app_id: 'app-1', owner_user_id: 'u1', sha256: 'aa' },
        { app_id: 'app-1', owner_user_id: 'u1', sha256: 'bb' },
    ],
    studio_apps: [
        appRow(),
        appRow({ id: 'app-2', user_id: 'u2', is_published: true, shared_groups: '["g1"]', project_id: 'p1', updated_at: '2026-01-02T00:00:00.000Z' }),
    ],
};
const seed = JSON.parse(JSON.stringify(tables));
const mock = createRecordingDb({ tables });
// The double holds on to `tables`: reseed its arrays in place.
function restoreSeed() {
    for (const k of Object.keys(seed)) {
        tables[k].length = 0;
        for (const r of JSON.parse(JSON.stringify(seed[k]))) tables[k].push(r);
    }
}
// emptyDefinition() mints random screen/section ids; the golden keeps the shape.
const scrub = (v) => JSON.parse(JSON.stringify(v ?? null).replace(/\b(scr|sec)_[a-z0-9]{6}\b/g, '$1_<id>'));

const rec = (ch) => async (sql, params = []) => {
    TRACE.push({ ch, sql: norm(sql), params: scrub(params) });
    return mock.dispatch(String(sql), params);
};
const client = {
    query: rec('tx'),
    release() { TRACE.push({ ch: 'release' }); },
};
const db = {
    run: rec('run'),
    getOne: async (sql, params) => (await rec('getOne')(sql, params)).rows[0] || null,
    getAll: async (sql, params) => (await rec('getAll')(sql, params)).rows,
    exec: async () => undefined,
    getClient: async () => { TRACE.push({ ch: 'getClient' }); return client; },
    withTransaction: (fn) => require('../testUtils/txFake').withTransactionVia(() => db.getClient())(fn),
    makeStoreInit: mock.db.makeStoreInit,
};

const note = (name) => (...args) => { TRACE.push({ ch: 'dep', name, args: JSON.parse(JSON.stringify(args)) }); };
let projectRole = null;
preloadStubs(require, {
    './studioAppDbStore': { reset: async (...a) => note('studioAppDbStore.reset')(...a) },
    './storageStore': {
        isAvailable: () => true,
        buildStudioAppAttachmentKey: (o, a, s) => `${o}/${a}/${s}`,
        deleteFile: async (...a) => note('storageStore.deleteFile')(...a),
    },
    '../appStudio/automationUsageSync': {
        reconcileAppAutomationUsageDetached: (...a) => note('reconcile')(...a),
        purgeAppAutomationUsage: async (...a) => note('purge')(...a),
    },
    './managedPartsDefault': {
        assertManagedWrite: async ({ kind, projectId, changedKeys, managedWrite, client: c }) =>
            note('assertManagedWrite')({ kind, projectId, changedKeys, managedWrite, onClient: !!c }),
        managedInfo: async (projectId) => { note('managedInfo')(projectId); return projectId ? { stage: 'dev' } : null; },
    },
    './projectStore': { listUserProjects: async (...a) => { note('listUserProjects')(...a); return [{ id: 'p1' }]; } },
    '../auth/projectAccess': { getProjectRole: async (...a) => { note('getProjectRole')(...a); return projectRole; } },
});
installResolveStub({ '../db': db });

let uuidN = 0;
const realUUID = crypto.randomUUID;
const realRandomBytes = crypto.randomBytes;
crypto.randomUUID = () => `uuid-${++uuidN}`;
crypto.randomBytes = (n) => Buffer.alloc(n, 7);
test.after(() => { crypto.randomUUID = realUUID; crypto.randomBytes = realRandomBytes; });

const store = require('./studioAppStore');

const results = {};
async function capture(name, fn) {
    restoreSeed();
    TRACE.length = 0;
    uuidN = 0;
    let value;
    try {
        value = await fn();
    } catch (e) {
        value = { threw: e.message, code: e.code || null };
    }
    // Detached reindexes fire synchronously inside the wrapper; let any
    // microtasks settle so their trace lands in this case.
    await new Promise((r) => setImmediate(r));
    results[name] = { value: value === undefined ? '<undefined>' : scrub(value), trace: [...TRACE] };
}

test('studioAppStore golden behaviour', async () => {
    await store.initDB();

    results.exports = Object.fromEntries(Object.keys(store).map((k) => {
        const d = Object.getOwnPropertyDescriptor(store, k);
        return [k, d.get ? 'getter' : (Array.isArray(d.value) ? 'array' : typeof d.value)];
    }));
    results.constants = {
        MAX_VERSIONS_PER_APP: store.MAX_VERSIONS_PER_APP,
        SNAPSHOT_MAX_BYTES: store.SNAPSHOT_MAX_BYTES,
        PINNED_SNAPSHOT_KEYS: store.PINNED_SNAPSHOT_KEYS,
        PINNED_frozen: Object.isFrozen(store.PINNED_SNAPSHOT_KEYS),
        SNAPSHOT_TRIM_MARKER: store.SNAPSHOT_TRIM_MARKER,
        MAX_NEXTCLOUD_MENU_APPS: store.MAX_NEXTCLOUD_MENU_APPS,
    };

    // Apps
    await capture('createStudioApp', () => store.createStudioApp({ userId: 'u1', organizationId: 'org1', name: 'New', templateId: 't', templateVersion: 2, templateInstallHash: 'h' }));
    await capture('createStudioApp.noUser', () => store.createStudioApp({}));
    await capture('createStudioApp.tooLarge', () => store.createStudioApp({ userId: 'u1', definition: { x: 'y'.repeat(3 * 1024 * 1024) } }));
    await capture('getStudioApp', () => store.getStudioApp('app-1'));
    await capture('getStudioAppsByUser', () => store.getStudioAppsByUser('u1'));
    await capture('getAccessibleStudioApps', () => store.getAccessibleStudioApps('u1', ['g1'], ['org1']));
    await capture('updateStudioApp', () => store.updateStudioApp('app-1', { name: 'Renamed', category: '', bogus: 1 }, 'u1'));
    await capture('updateStudioApp.noop', () => store.updateStudioApp('app-1', { bogus: 1 }, 'u1'));
    await capture('updateStudioApp.foreign', () => store.updateStudioApp('app-1', { name: 'x' }, 'u2'));
    await capture('setTemplateStamp', () => store.setTemplateStamp('app-1', 'u1', { templateVersion: 3, templateInstallHash: 'h3' }));
    await capture('setTemplateProvenance', () => store.setTemplateProvenance('app-1', 'u1', { templateId: 't', templateVersion: 'x' }));
    await capture('saveDefinition', () => store.saveDefinition('app-1', 'u1', { schemaVersion: 1 }, { expectedVersion: 4 }));
    await capture('saveDefinition.conflict', () => store.saveDefinition('app-1', 'u1', { schemaVersion: 1 }, { expectedVersion: 9 }));
    await capture('saveDefinition.notFound', () => store.saveDefinition('app-1', 'u9', { schemaVersion: 1 }));
    // Publication
    await capture('setStudioAppPublished.publish', () => store.setStudioAppPublished('app-1', true, 'u1', ['g1'], 'org1'));
    await capture('setStudioAppPublished.publishSnapshot', () => store.setStudioAppPublished('app-1', true, 'u1', undefined, undefined, { theme: { primary: '#abcdef' } }, 3));
    await capture('setStudioAppPublished.unpublish', () => store.setStudioAppPublished('app-1', false, 'u1'));
    await capture('setStudioAppPublished.foreign', () => store.setStudioAppPublished('app-1', true, 'u2'));
    await capture('setStudioAppAudience', () => store.setStudioAppAudience('app-1', 'u1', { isPublished: true, sharedGroups: [] }));
    await capture('publishDefinitionWith', () => store.publishDefinitionWith(client, 'app-1', { theme: { primary: '#00ff00' } }, 7, { managedWrite: { deploymentId: 'd1' } }));
    await capture('publishDefinitionWith.missing', () => store.publishDefinitionWith(client, 'nope', {}, 1));
    await capture('managedInfoOfApp', () => store.managedInfoOfApp({ projectId: 'p1' }));
    await capture('deleteStudioApp', () => store.deleteStudioApp('app-1', 'u1'));
    await capture('deleteStudioApp.foreign', () => store.deleteStudioApp('app-1', 'u2'));
    // Versions
    await capture('createVersionSnapshot', () => store.createVersionSnapshot('app-1', 'u1', { a: 1 }));
    await capture('createVersionSnapshot.onClient', () => store.createVersionSnapshot('app-1', 'u1', '{"b":2}', 'AI checkpoint', { client }));
    await capture('listVersions', () => store.listVersions('app-1', 'u1'));
    await capture('getVersion', () => store.getVersion('app-1', 'v-1', 'u1'));
    await capture('restoreVersion', () => store.restoreVersion('app-1', 'v-1', 'u1'));
    await capture('restoreVersion.missing', () => store.restoreVersion('app-1', 'v-9', 'u1'));
    // Access
    const app2 = await store.getStudioApp('app-2');
    results.access = {
        owner: store.canReadStudioApp(app2, 'u2'),
        inGroup: store.canReadStudioApp(app2, 'x', ['g1'], ['org1']),
        outGroup: store.canReadStudioApp(app2, 'x', ['g2'], ['org1']),
        setOrgs: store.canReadStudioApp(app2, 'x', ['g1'], new Set(['org1'])),
        nullApp: store.canReadStudioApp(null, 'x'),
        write: store.canWriteStudioApp(app2, 'u2'),
        writeOther: store.canWriteStudioApp(app2, 'x'),
    };
    projectRole = 'viewer';
    await capture('canReadStudioAppAsync.member', () => store.canReadStudioAppAsync(app2, 'x', [], []));
    projectRole = null;
    await capture('canReadStudioAppAsync.nonMember', () => store.canReadStudioAppAsync(app2, 'x', [], []));
    await capture('userHasAnyStudioAppAccess', () => store.userHasAnyStudioAppAccess('x', ['g1'], ['org1']));
    // Builder session
    await capture('getBuilderSession', () => store.getBuilderSession('app-1', 'u1'));
    await capture('getBuilderSession.foreign', () => store.getBuilderSession('app-1', 'u2'));
    const big = { sessionId: 's', pendingPlan: { p: 1 }, summary: 'sum',
        messages: Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: `${i}:${'z'.repeat(3000)}` })) };
    await capture('setBuilderSession.trim', async () => {
        const out = await store.setBuilderSession('app-1', 'u1', big, { expectedVersion: 2, trimBlock: 4 });
        return { ok: out.ok, version: out.snapshot.version, summary: out.snapshot.summary,
            kept: out.snapshot.messages.length, first: out.snapshot.messages[0].content.slice(0, 4), pendingPlan: out.snapshot.pendingPlan };
    });
    await capture('setBuilderSession.conflict', () => store.setBuilderSession('app-1', 'u1', { messages: [] }, { expectedVersion: 7 }));
    await capture('setBuilderSession.forbidden', () => store.setBuilderSession('app-1', 'u2', { messages: [] }));
    await capture('clearBuilderSession', () => store.clearBuilderSession('app-1', 'u1'));
    await capture('clearBuilderSession.any', () => store.clearBuilderSession('app-1'));
    // Nextcloud menu + projects
    await capture('setStudioAppNextcloudMenu', () => store.setStudioAppNextcloudMenu('app-1', 'u1', 1));
    await capture('listNextcloudMenuApps', () => store.listNextcloudMenuApps('org1', { limit: 99 }));
    await capture('listNextcloudMenuApps.noOrg', () => store.listNextcloudMenuApps(null));
    await capture('listProjectApps', () => store.listProjectApps('p1'));
    await capture('countProjectApps', async () => [...(await store.countProjectApps(['p1', '', 3]))]);
    await capture('setAppProject', () => store.setAppProject('app-1', 'u1', 'p1'));
    await capture('clearProjectFromApps', () => store.clearProjectFromApps('p1'));
    // Public pages
    await capture('createPublicPage', () => store.createPublicPage('app-1', 'u1'));
    await capture('getPublicPage', () => store.getPublicPage('tok-1'));
    await capture('listPublicPages', () => store.listPublicPages('app-1'));
    await capture('deletePublicPage', () => store.deletePublicPage('tok-1', 'app-1'));
    await capture('touchPublicPage', () => store.touchPublicPage('tok-1'));

    if (process.env.UPDATE_GOLDEN === '1') {
        fs.writeFileSync(GOLDEN, JSON.stringify(results, null, 1) + '\n');
        return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (const key of Object.keys(golden)) {
        assert.deepStrictEqual(results[key], golden[key], `golden mismatch in ${key}`);
    }
    assert.deepStrictEqual(Object.keys(results).sort(), Object.keys(golden).sort());
});
