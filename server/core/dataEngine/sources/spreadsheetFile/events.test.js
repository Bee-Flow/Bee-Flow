/**
 * A storage push marks the spreadsheet mirror(s) it is about stale and kicks
 * a pass, never patches a row: a Nextcloud file event finds its mirrors by
 * file id (by path for a delete, which carries none), a rename by the linker
 * re-points the stored path first, a rename by anyone else only kicks, a
 * OneDrive drive hint kicks every mirror that account linked there, and
 * nothing here ever throws.
 *
 * Run: cd server && node --test core/dataEngine/sources/spreadsheetFile/events.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');

const SCOPE = { kind: 'org', id: 'org_1' };
function mirror(over = {}, sourceOver = {}) {
    return {
        id: 'tbl_fac', key: 'facturen', scope: SCOPE, organizationId: 'org_1', managedKind: 'spreadsheet_file',
        source: {
            kind: 'spreadsheet_file', provider: 'nextcloud_files', format: 'xlsx',
            file: { id: '437', driveId: null, path: '/Documents/Facturen.xlsx', name: 'Facturen.xlsx', webUrl: 'http://nc/f/437' },
            sheet: { id: null, name: 'Facturen', index: 0 }, headerRow: 1,
            identity: { mode: 'row' }, linkedByUserId: 'u_linker', columnMap: {}, relations: [],
            ...sourceOver,
        },
        syncState: { status: 'ok', lastSuccessAt: new Date().toISOString(), marker: { etag: '"a"' } },
        ...over,
    };
}
const world = { mirrors: [], stale: [], kicked: [], sources: [], users: {}, calls: [], fail: null };
const restore = installResolveStub({
    '../../../../stores/datatableStore': {
        listSourceMirrorsByRef: async (orgId, { kind, provider, fileId }) => {
            world.calls.push(['byRef', orgId, kind, provider, fileId]);
            if (world.fail === 'byRef') throw new Error('pg down');
            return world.mirrors.filter(m => m.organizationId === orgId && m.source.provider === provider && m.source.file.id === fileId);
        },
        listSourceMirrorsByPath: async (orgId, { kind, provider, path }) => {
            world.calls.push(['byPath', orgId, kind, provider, path]);
            return world.mirrors.filter(m => m.organizationId === orgId && m.source.provider === provider && m.source.file.path === path);
        },
        listSourceMirrorsByLinker: async (userId, provider) => {
            world.calls.push(['byLinker', userId, provider]);
            return world.mirrors.filter(m => m.source.linkedByUserId === userId && m.source.provider === provider);
        },
        markSourceStale: async (id, reason) => {
            if (world.fail === 'stale') throw new Error('pg down');
            world.stale.push([id, reason]);
        },
        getDatatable: async (id) => world.mirrors.find(m => m.id === id) || null,
        setSource: async (id, scope, source) => {
            world.sources.push([id, scope, source]);
            const m = world.mirrors.find(x => x.id === id);
            if (m) m.source = source;
            return m || null;
        },
    },
    '../../../../stores/userStore': {
        getUserByNcUid: async (orgId, ncUid) => world.users[`${orgId}:${ncUid}`] || null,
    },
    './sync': { kickStale: (t, o) => { world.kicked.push([t.id, o && o.reason, o && o.delayMs]); return true; } },
});
const events = require('./events');
test.after(() => restore());
test.beforeEach(() => Object.assign(world, { mirrors: [], stale: [], kicked: [], sources: [], users: {}, calls: [], fail: null }));

test('file.changed: the mirrors of that file id are marked stale and kicked at once, nothing is patched', async () => {
    world.mirrors = [mirror(), mirror({ id: 'tbl_other' }, { sheet: { id: null, name: 'Leveranciers', index: 1 } })];
    const out = await events.onFileEvent({ orgId: 'org_1', event: 'file.changed', payload: { id: 437, path: '/Documents/Facturen.xlsx', name: 'Facturen.xlsx', actor: 'admin' } });
    assert.deepEqual(out, { kicked: 2, moved: 0 });
    assert.deepEqual(world.calls, [['byRef', 'org_1', 'spreadsheet_file', 'nextcloud_files', '437']], 'the id is a string, the lookup is by id only');
    assert.deepEqual(world.stale, [['tbl_fac', 'event'], ['tbl_other', 'event']]);
    assert.deepEqual(world.kicked, [['tbl_fac', 'event', 0], ['tbl_other', 'event', 0]]);
    assert.equal(world.sources.length, 0);
});

test('file.new, file.restored and file.copied go the same way as a change', async () => {
    world.mirrors = [mirror()];
    for (const event of ['file.new', 'file.restored', 'file.copied']) {
        world.stale = []; world.kicked = [];
        const out = await events.onFileEvent({ orgId: 'org_1', event, payload: { id: '437', path: '/Documents/Facturen.xlsx' } });
        assert.deepEqual(out, { kicked: 1, moved: 0 }, event);
        assert.deepEqual(world.stale, [['tbl_fac', 'event']], event);
    }
});

test('file.deleted carries no id: the mirrors are found by path and kicked; the pass answers what it finds', async () => {
    world.mirrors = [mirror()];
    const out = await events.onFileEvent({ orgId: 'org_1', event: 'file.deleted', payload: { id: null, path: '/Documents/Facturen.xlsx', name: 'Facturen.xlsx' } });
    assert.deepEqual(out, { kicked: 1, moved: 0 });
    assert.deepEqual(world.calls, [['byPath', 'org_1', 'spreadsheet_file', 'nextcloud_files', '/Documents/Facturen.xlsx']]);
    assert.deepEqual(world.stale, [['tbl_fac', 'event']]);
    assert.deepEqual(world.kicked, [['tbl_fac', 'event', 0]]);
});

test('file.renamed by the LINKER re-points the stored path and name before the kick; id and web link stay', async () => {
    world.mirrors = [mirror()];
    const out = await events.onFileEvent({
        orgId: 'org_1', event: 'file.renamed', actorUserId: 'u_linker',
        payload: { id: 437, path: '/Documents/2026/Facturen-Q3.xlsx', name: 'Facturen-Q3.xlsx', oldPath: '/Documents/Facturen.xlsx', sourceId: null, actor: 'admin' },
    });
    assert.deepEqual(out, { kicked: 1, moved: 1 });
    assert.equal(world.sources.length, 1);
    const [id, scope, source] = world.sources[0];
    assert.equal(id, 'tbl_fac');
    assert.deepEqual(scope, SCOPE);
    assert.deepEqual(source.file, { id: '437', driveId: null, path: '/Documents/2026/Facturen-Q3.xlsx', name: 'Facturen-Q3.xlsx', webUrl: 'http://nc/f/437' });
    assert.equal(source.linkedByUserId, 'u_linker', 'the rest of the source block is untouched');
    assert.deepEqual(world.stale, [['tbl_fac', 'event']]);
    assert.deepEqual(world.kicked, [['tbl_fac', 'event', 0]]);
});

test('file.renamed by someone else only marks stale and kicks — the path is that account\'s view, not the linker\'s', async () => {
    world.mirrors = [mirror()];
    const out = await events.onFileEvent({
        orgId: 'org_1', event: 'file.renamed', actorUserId: 'u_colleague',
        payload: { id: 437, path: '/Shared/Facturen-Q3.xlsx', name: 'Facturen-Q3.xlsx', oldPath: '/Shared/Facturen.xlsx', actor: 'bob' },
    });
    assert.deepEqual(out, { kicked: 1, moved: 0 });
    assert.equal(world.sources.length, 0);
    assert.deepEqual(world.stale, [['tbl_fac', 'event']]);
});

test('file.renamed without a resolved actor falls back to the payload actor through the user store', async () => {
    world.mirrors = [mirror()];
    world.users['org_1:admin'] = { id: 'u_linker' };
    const out = await events.onFileEvent({
        orgId: 'org_1', event: 'file.renamed',
        payload: { id: 437, path: '/Documents/Facturen-Q3.xlsx', name: 'Facturen-Q3.xlsx', oldPath: '/Documents/Facturen.xlsx', actor: 'admin' },
    });
    assert.deepEqual(out, { kicked: 1, moved: 1 });
    assert.equal(world.sources[0][2].file.path, '/Documents/Facturen-Q3.xlsx');
});

test('file.renamed whose source node had no id is still found by its OLD path, once', async () => {
    world.mirrors = [mirror()];
    const out = await events.onFileEvent({
        orgId: 'org_1', event: 'file.renamed', actorUserId: 'u_linker',
        payload: { id: null, path: '/Documents/Facturen-Q3.xlsx', name: 'Facturen-Q3.xlsx', oldPath: '/Documents/Facturen.xlsx', actor: 'admin' },
    });
    assert.deepEqual(out, { kicked: 1, moved: 1 });
    assert.deepEqual(world.calls, [['byPath', 'org_1', 'spreadsheet_file', 'nextcloud_files', '/Documents/Facturen.xlsx']]);
    assert.deepEqual(world.stale, [['tbl_fac', 'event']], 'one mirror, one mark, even when id and old path both name it');
});

test('a rename to the same path, or to a path the file contract refuses, moves nothing but still kicks', async () => {
    world.mirrors = [mirror()];
    let out = await events.onFileEvent({ orgId: 'org_1', event: 'file.renamed', actorUserId: 'u_linker', payload: { id: 437, path: '/Documents/Facturen.xlsx', oldPath: '/Documents/Facturen.xlsx' } });
    assert.deepEqual(out, { kicked: 1, moved: 0 });
    world.stale = [];
    out = await events.onFileEvent({ orgId: 'org_1', event: 'file.renamed', actorUserId: 'u_linker', payload: { id: 437, path: 'Documents/no-leading-slash.xlsx', oldPath: '/Documents/Facturen.xlsx' } });
    assert.deepEqual(out, { kicked: 1, moved: 0 });
    assert.equal(world.sources.length, 0);
    assert.deepEqual(world.stale, [['tbl_fac', 'event']]);
});

test('an event about a file nobody linked, an unknown event, or a missing org is a no-op', async () => {
    world.mirrors = [mirror()];
    assert.deepEqual(await events.onFileEvent({ orgId: 'org_1', event: 'file.changed', payload: { id: 999 } }), { kicked: 0, moved: 0 });
    assert.deepEqual(await events.onFileEvent({ orgId: 'org_1', event: 'file.tagged', payload: { id: 437 } }), { kicked: 0, moved: 0 });
    assert.deepEqual(await events.onFileEvent({ orgId: 'org_1', event: 'tables.row.added', payload: { tableId: 4 } }), { kicked: 0, moved: 0 });
    assert.deepEqual(await events.onFileEvent({ orgId: null, event: 'file.changed', payload: { id: 437 } }), { kicked: 0, moved: 0 });
    assert.deepEqual(await events.onFileEvent({ orgId: 'org_1', event: 'file.changed', payload: null }), { kicked: 0, moved: 0 });
    assert.equal(world.stale.length, 0);
});

test('another organisation\'s mirror of the same file id is never reached', async () => {
    world.mirrors = [mirror({ organizationId: 'org_2', scope: { kind: 'org', id: 'org_2' } })];
    assert.deepEqual(await events.onFileEvent({ orgId: 'org_1', event: 'file.changed', payload: { id: 437 } }), { kicked: 0, moved: 0 });
});

test('a store that fails never throws: a failed lookup is a no-op, a failed mark skips that mirror', async () => {
    world.mirrors = [mirror()];
    world.fail = 'byRef';
    assert.deepEqual(await events.onFileEvent({ orgId: 'org_1', event: 'file.changed', payload: { id: 437 } }), { kicked: 0, moved: 0 });
    world.fail = 'stale';
    assert.deepEqual(await events.onFileEvent({ orgId: 'org_1', event: 'file.changed', payload: { id: 437 } }), { kicked: 0, moved: 0 });
    assert.equal(world.kicked.length, 0);
});

test('a OneDrive drive hint kicks every mirror that account linked there, of this kind only', async () => {
    world.mirrors = [
        mirror({ id: 'tbl_a' }, { provider: 'onedrive', file: { id: '01A', driveId: 'b!1', path: null, name: 'a.xlsx' }, linkedByUserId: 'u_1' }),
        mirror({ id: 'tbl_b' }, { provider: 'onedrive', file: { id: '01B', driveId: 'b!1', path: null, name: 'b.csv' }, linkedByUserId: 'u_1' }),
        mirror({ id: 'tbl_g' }, { provider: 'google_drive', file: { id: 'g1', driveId: null, path: null, name: 'g.csv' }, linkedByUserId: 'u_1' }),
        mirror({ id: 'tbl_c' }, { provider: 'onedrive', file: { id: '01C', driveId: 'b!2', path: null, name: 'c.xlsx' }, linkedByUserId: 'u_2' }),
        mirror({ id: 'tbl_nc', managedKind: 'nextcloud_table' }, { kind: 'nextcloud_table', provider: 'onedrive', linkedByUserId: 'u_1' }),
    ];
    const out = await events.onProviderHint({ provider: 'onedrive', userId: 'u_1' });
    assert.deepEqual(out, { kicked: 2 });
    assert.deepEqual(world.calls, [['byLinker', 'u_1', 'onedrive']]);
    assert.deepEqual(world.stale, [['tbl_a', 'event'], ['tbl_b', 'event']]);
    assert.deepEqual(world.kicked, [['tbl_a', 'event', 0], ['tbl_b', 'event', 0]]);
});

test('a hint without a user or a provider, or for an account with no mirrors, is a no-op', async () => {
    world.mirrors = [mirror({ id: 'tbl_a' }, { provider: 'onedrive', linkedByUserId: 'u_1' })];
    assert.deepEqual(await events.onProviderHint({ provider: 'onedrive', userId: null }), { kicked: 0 });
    assert.deepEqual(await events.onProviderHint({ provider: null, userId: 'u_1' }), { kicked: 0 });
    assert.deepEqual(await events.onProviderHint({ provider: 'onedrive', userId: 'u_9' }), { kicked: 0 });
    assert.equal(world.stale.length, 0);
});

test('the adapter hands the registry this module', () => {
    const adapter = require('./adapter');
    assert.strictEqual(adapter.events, events);
    assert.strictEqual(typeof adapter.events.onFileEvent, 'function');
    assert.strictEqual(typeof adapter.events.onProviderHint, 'function');
});
