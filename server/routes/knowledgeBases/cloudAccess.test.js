/**
 * What the folder picker and the create route ask of a person's own storage
 * (routes/knowledgeBases/cloudAccess.js), against a recording fake of the
 * provider layer.
 *
 * What a wrong answer costs: a folder created for a storage the person is not
 * connected to is a source that fails at three in the morning with nobody
 * watching; a Nextcloud folder outside the folders they shared with Bee Flow
 * is a privacy boundary crossed by a background job; and a picker that lists
 * with someone else's session shows someone else's files.
 *
 * Run: cd server && node --test routes/knowledgeBases/cloudAccess.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { HttpError } = require('../../core/http/errors');
const access = require('./cloudAccess');

const REQ = { session: { user: { id: 'u1' } } };
const PRINCIPAL = { userId: 'u1', orgId: 'org1' };

const refusal = (code, extra = {}) => Object.assign(new Error(`internal ${code}`), { name: 'SpreadsheetSourceError', code, status: 400, ...extra });

function deps(over = {}) {
    const calls = { callerApi: [], list: [], checks: [] };
    return {
        calls,
        deps: {
            resolvePrincipal: async () => PRINCIPAL,
            callerApi: async (session, principal, provider, opts) => {
                calls.callerApi.push({ session, principal, provider, opts });
                return { api: { list: async (o) => { calls.list.push(o); return over.list ? over.list(o) : { items: [], nextPageToken: null }; } } };
            },
            checkToolCall: async (a) => { calls.checks.push(a); return over.denial || null; },
            friendlyError: (e, p) => require('../../core/kb/sources/cloudFolder.mts').friendlyError(e, p),
            providerFor: over.providerFor || (() => { throw new Error('no provider'); }),
            isIntegrationPermittedForUser: over.permitted || (async () => true),
            ...(over.callerApi ? { callerApi: over.callerApi } : {}),
        },
    };
}

// ─── Creating: the checks ───────────────────────────────────────────────

test('create: the caller must have the storage connected — otherwise cloud_not_connected, and nothing is listed', async () => {
    const { deps: d, calls } = deps({ callerApi: async () => { throw refusal('provider_not_connected'); } });
    await assert.rejects(() => access.openCloudFolder(REQ, { provider: 'google_drive', folderId: 'F' }, { organization_id: 'org1' }, d),
        (e) => e instanceof HttpError && e.code === 'cloud_not_connected' && e.status === 400 && /not connected to Google Drive/.test(e.message));
    assert.deepStrictEqual(calls.list, []);

    for (const code of ['provider_integration_off', 'linker_unavailable']) {
        const x = deps({ callerApi: async () => { throw refusal(code); } });
        await assert.rejects(() => access.openCloudFolder(REQ, { provider: 'onedrive', folderId: 'F' }, {}, x.deps), (e) => e.code === 'cloud_not_connected');
    }
});

test('create: a folder the caller cannot list is cloud_folder_unreadable, with the storage\'s own reason in words', async () => {
    const { deps: d } = deps({ list: async () => { throw refusal('spreadsheet_not_found'); } });
    await assert.rejects(() => access.openCloudFolder(REQ, { provider: 'onedrive', folderId: 'F' }, {}, d),
        (e) => e.code === 'cloud_folder_unreadable' && e.status === 400 && /OneDrive no longer has this folder/.test(e.message));
    const forbidden = deps({ list: async () => { throw refusal('spreadsheet_forbidden'); } });
    await assert.rejects(() => access.openCloudFolder(REQ, { provider: 'google_drive', folderId: 'F' }, {}, forbidden.deps), (e) => e.code === 'cloud_folder_unreadable');
    const down = deps({ list: async () => { throw refusal('spreadsheet_unavailable'); } });
    await assert.rejects(() => access.openCloudFolder(REQ, { provider: 'google_drive', folderId: 'F' }, {}, down.deps), (e) => e.code === 'cloud_unavailable' && e.status === 502);
});

test('create: a Nextcloud folder outside the shared folders is cloud_folder_out_of_scope before anything is listed', async () => {
    const { deps: d, calls } = deps({ denial: { error: 'outside', nc_scope_denied: true } });
    await assert.rejects(() => access.openCloudFolder(REQ, { provider: 'nextcloud_files', path: '/Private' }, { organization_id: 'orgKb' }, d),
        (e) => e.code === 'cloud_folder_out_of_scope' && e.status === 403);
    assert.deepStrictEqual(calls.checks, [{ toolName: 'nextcloud_read_file', toolArgs: { path: '/Private' }, userId: 'u1', orgId: 'org1' }]);
    assert.deepStrictEqual(calls.callerApi, [], 'no storage client is even built');
    assert.deepStrictEqual(calls.list, []);

    // And a scope that lists the folder only as a navigation step is denied by the guard at listing time.
    const nav = deps({ list: async () => { throw refusal('nc_scope_denied'); } });
    await assert.rejects(() => access.openCloudFolder(REQ, { provider: 'nextcloud_files', path: '/Docs' }, {}, nav.deps), (e) => e.code === 'cloud_folder_out_of_scope');
});

test('create: an allowed, listable folder passes — listed as the caller, in documents mode, per provider', async () => {
    const nc = deps();
    assert.deepStrictEqual(await access.openCloudFolder(REQ, { provider: 'nextcloud_files', path: '/Docs' }, {}, nc.deps), { orgId: 'org1' });
    assert.deepStrictEqual(nc.calls.list, [{ view: 'mine', path: '/Docs' }]);
    assert.strictEqual(nc.calls.callerApi[0].session, REQ.session);
    assert.deepStrictEqual(nc.calls.callerApi[0].opts, { accept: 'documents' });

    const od = deps();
    await access.openCloudFolder(REQ, { provider: 'onedrive', folderId: 'F', driveId: 'D' }, {}, od.deps);
    assert.deepStrictEqual(od.calls.list, [{ view: 'mine', parentId: { id: 'F', driveId: 'D' } }]);

    const gd = deps();
    await access.openCloudFolder(REQ, { provider: 'google_drive', folderId: 'F' }, {}, gd.deps);
    assert.deepStrictEqual(gd.calls.list, [{ view: 'mine', parentId: 'F' }]);
    const root = deps();
    await access.openCloudFolder(REQ, { provider: 'google_drive' }, {}, root.deps);
    assert.deepStrictEqual(root.calls.list, [{ view: 'mine', parentId: null }], 'no folder id means the drive root');
});

test('create: with no organisation on the caller the knowledge base\'s organisation scopes the Nextcloud check', async () => {
    const { deps: d, calls } = deps();
    d.resolvePrincipal = async () => ({ userId: 'u1', orgId: null });
    assert.deepStrictEqual(await access.openCloudFolder(REQ, { provider: 'nextcloud_files', path: '/Docs' }, { organization_id: 'orgKb' }, d), { orgId: 'orgKb' });
    assert.strictEqual(calls.checks[0].orgId, 'orgKb');
});

// ─── Browsing ───────────────────────────────────────────────────────────

test('browse: a level of the caller\'s own storage, in the picker\'s shape; no secrets, no cursor', async () => {
    const { deps: d, calls } = deps({
        list: async () => ({
            items: [
                { provider: 'onedrive', fileId: 'f1', driveId: 'D', path: '/Docs/a.pdf', name: 'a.pdf', mimeType: 'application/pdf', isFolder: false, size: 5, modifiedAt: '2026-09-01', webUrl: 'https://1drv/a', marker: { cTag: 'x' }, etag: 'e', parentId: 'p', owned: true, format: 'pdf' },
                { provider: 'onedrive', fileId: 'd1', name: 'Sub', isFolder: true },
            ],
            nextPageToken: 'next',
        }),
    });
    const res = await access.browse(REQ, { provider: 'onedrive', parentId: 'P', driveId: 'D', pageToken: 'tok' }, d);
    assert.deepStrictEqual(calls.list, [{ view: 'mine', q: null, pageToken: 'tok', parentId: { id: 'P', driveId: 'D' } }]);
    assert.strictEqual(res.nextPageToken, 'next');
    assert.deepStrictEqual(Object.keys(res.items[0]).sort(), ['driveId', 'fileId', 'isFolder', 'mimeType', 'modifiedAt', 'name', 'path', 'provider', 'size', 'webUrl']);
    assert.deepStrictEqual(res.items[1], { provider: 'onedrive', fileId: 'd1', driveId: null, path: null, name: 'Sub', mimeType: null, isFolder: true, size: null, modifiedAt: null, webUrl: null });
});

test('browse: Nextcloud by path, a search ignores the folder, and the storage\'s refusals leave as HttpError', async () => {
    const nc = deps();
    await access.browse(REQ, { provider: 'nextcloud_files', path: '/Docs/Sub' }, nc.deps);
    assert.deepStrictEqual(nc.calls.list[0], { view: 'mine', q: null, pageToken: null, path: '/Docs/Sub' });
    await access.browse(REQ, { provider: 'nextcloud_files' }, nc.deps);
    assert.strictEqual(nc.calls.list[1].path, '/');
    await access.browse(REQ, { provider: 'google_drive', q: '  budget ', parentId: 'ignored' }, nc.deps);
    assert.deepStrictEqual(nc.calls.list[2], { view: 'search', q: 'budget', pageToken: null });

    const bad = deps({ callerApi: async () => { throw refusal('provider_not_connected'); } });
    await assert.rejects(() => access.browse(REQ, { provider: 'google_drive' }, bad.deps), (e) => e instanceof HttpError && e.code === 'cloud_not_connected');
    const scoped = deps({ list: async () => { throw refusal('nc_scope_denied'); } });
    await assert.rejects(() => access.browse(REQ, { provider: 'nextcloud_files', path: '/x' }, scoped.deps), (e) => e.code === 'cloud_folder_out_of_scope');
});

// ─── Which storages are connected ───────────────────────────────────────

test('providers: all three are listed with whether they are connected and why not', async () => {
    const status = {
        nextcloud_files: { connected: true },
        onedrive: { connected: false, reason: 'needs_reauth' },
        google_drive: { connected: true },
    };
    const { deps: d } = deps({
        providerFor: (p) => ({ integrationAppIds: [p], isConnected: async () => status[p] }),
        permitted: async ({ appId }) => appId !== 'google_drive',
    });
    assert.deepStrictEqual(await access.providerStatuses(REQ, d), [
        { provider: 'nextcloud_files', connected: true, reason: null },
        { provider: 'onedrive', connected: false, reason: 'needs_reauth' },
        { provider: 'google_drive', connected: false, reason: 'integration_off' },
    ]);
    const broken = deps({ providerFor: () => { throw new Error('boom'); } });
    assert.deepStrictEqual((await access.providerStatuses(REQ, broken.deps)).map((p) => [p.connected, p.reason]), [[false, 'unavailable'], [false, 'unavailable'], [false, 'unavailable']]);
});
