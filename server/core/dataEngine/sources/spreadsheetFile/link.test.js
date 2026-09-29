/**
 * Linking, with the storages, the stores and the mirror-making stubbed:
 * which storages are offered and why not; how one `folderId` reaches each
 * storage's own listing and what crumbs come back (probed upwards on
 * Drive/OneDrive, split from the path on Nextcloud); what describe answers
 * for a csv; every refusal the link gives BEFORE making anything (a taken
 * technical name among them), the one storage budget it spends, and the
 * `source` block it makes; the settings a mirror takes — a new key column
 * checked unique over a fresh read as the linker; a relink that re-points
 * and never inherits a shared-file opt-in; the wire id a refusal names.
 * The making itself (empty tables, derived columns, kicked syncs) is proven
 * against Postgres in routes/datatables.spreadsheet.integration.test.js.
 *
 * Run: cd server && node --test core/dataEngine/sources/spreadsheetFile/link.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../../../testUtils/stubRequire');
const columns = require('./columns');
const cache = require('./cache');

const SCOPE = { kind: 'org', id: 'org_1' };
const PRINCIPAL = { userId: 'user_1', orgId: 'org_1' };
const SESSION = { user: { id: 'user_1' } };

const world = { files: new Map(), folders: new Map(), calls: [], mirrors: [], tables: [], connected: {}, permitted: () => true, sources: [], stale: [], made: null, forgotten: [], linker: [], budget: [], deny: false };
function csv(lines) { return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'); }
function reset() {
    cache.clear();
    world.files = new Map([
        ['f1', { name: 'klanten.csv', buffer: csv(['Naam;Stad;Omzet', 'Acme;Delft;1.234,56', 'Bee;Delft;99,50']), version: 1, owned: true }],
        ['f2', { name: 'shared.csv', buffer: csv(['A;B', '1;2']), version: 1, owned: false }],
    ]);
    // Drive/OneDrive folders, probed for the crumbs: root → Documents → Q3
    world.folders = new Map([
        ['rootid', { name: 'My Drive', parentId: null }],
        ['dir1', { name: 'Documents', parentId: 'rootid' }],
        ['sub', { name: 'Q3', parentId: 'dir1' }],
    ]);
    Object.assign(world, { calls: [], mirrors: [], tables: [], connected: { google_drive: { connected: true, reason: null } }, permitted: () => true, sources: [], stale: [], made: null, forgotten: [], linker: [], budget: [], deny: false });
}
function refOf(provider, id, f) {
    return { provider, fileId: id, driveId: null, path: null, name: f.name, mimeType: null, format: 'csv', size: f.buffer.length, modifiedAt: '2026-09-13T08:00:00.000Z', etag: null, webUrl: `https://x/${id}`, parentId: 'root', isFolder: false, owned: f.owned, writable: true };
}
function apiFor(provider) {
    const { SpreadsheetSourceError } = require('./errors');
    return {
        provider,
        list: async (args) => {
            world.calls.push(['list', provider, args]);
            const items = [{ provider, fileId: 'dir1', driveId: provider === 'onedrive' ? 'b!other' : null, path: provider === 'nextcloud_files' ? '/Documents' : null, name: 'Documents', isFolder: true, format: null, owned: provider !== 'onedrive' }];
            for (const [id, f] of world.files) items.push({ ...refOf(provider, id, f), path: provider === 'nextcloud_files' ? `/${f.name}` : null });
            return { items, nextPageToken: 'next-1' };
        },
        probe: async (file) => {
            world.calls.push(['probe', provider, file]);
            const id = provider === 'nextcloud_files' ? String(file.path || '').replace(/^\//, '') : file.fileId;
            const folder = provider !== 'nextcloud_files' && world.folders.get(id);
            if (folder) {
                // what a real probe answers for a folder: a ref with isFolder, no format, its parent
                const driveId = provider === 'onedrive' ? (file.driveId || 'me-drive') : null;
                return { marker: null, name: folder.name, format: null, path: null, webUrl: null, owned: driveId !== 'b!other', writable: true, file: { provider, fileId: id, driveId, parentId: folder.parentId, isFolder: true, name: folder.name, owned: driveId !== 'b!other' } };
            }
            const f = world.files.get(id);
            if (!f) throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', 'gone', { ref: { provider, fileId: file.fileId, path: file.path } });
            const ref = refOf(provider, id, f);
            if (provider === 'nextcloud_files') { ref.fileId = '777'; ref.path = `/${id}`; }
            // a fixture may say `format: null` — what a probe answers for a file that is no spreadsheet
            const format = f.format === undefined ? 'csv' : f.format;
            return { marker: { version: String(f.version) }, name: f.name, size: f.buffer.length, format, path: ref.path, webUrl: ref.webUrl, owned: f.owned, writable: true, file: { ...ref, format } };
        },
        download: async (file) => {
            world.calls.push(['download', provider, file]);
            const id = provider === 'nextcloud_files' ? String(file.path || '').replace(/^\//, '') : file.fileId;
            return { buffer: world.files.get(id).buffer, marker: { version: '1' } };
        },
        markerEquals: (a, b) => a && b && a.version === b.version,
    };
}
const providerModule = (provider) => ({
    provider, oauthProvider: provider === 'google_drive' ? 'google' : provider === 'onedrive' ? 'microsoft' : 'nextcloud',
    integrationAppIds: [provider === 'google_drive' ? 'google-drive' : provider === 'onedrive' ? 'onedrive' : 'nextcloud'],
    isConnected: async () => world.connected[provider] || { connected: false, reason: 'not_connected' },
    forCaller: () => apiFor(provider), forLinker: () => apiFor(provider),
});
const datatableStore = {
    listSourceMirrorsInScope: async () => world.mirrors,
    listDatatablesForScope: async () => world.tables,
    setSource: async (id, scope, source) => { world.sources.push({ id, source }); return { id, scope, source }; },
    markSourceStale: async (id, reason) => { world.stale.push([id, reason]); },
    getDatatable: async (id) => world.mirrors.find(m => m.id === id) || null,
    getTableMeta: async () => null,
};
const linking = {
    createEmptyMirrors: async ({ plans, sourceFor }) => {
        world.made = plans.map((plan, i) => ({ plan, table: { id: `tbl_${i}`, key: plan.key, name: plan.name, scope: SCOPE, source: sourceFor(plan) } }));
        return { created: world.made, partial: false, warnings: [] };
    },
    storeDerived: async (scope, created, deriveFor) => {
        const tables = [];
        for (const { plan, table } of created) {
            const d = await deriveFor(plan, table);
            tables.push({ ...table, source: { ...table.source, columnMap: d.columnMap, relations: d.relations }, _fields: d.fields });
        }
        return { tables, partial: false, warnings: [] };
    },
    kickFirstSyncs: async (scope, tables) => { world.kicked = tables.map(t => t.id); return tables; },
    setRelations: async () => ({}),
    orderParentsFirst: (t) => t,
};
const restore = installResolveStub({
    '../../../../stores/datatableStore': datatableStore,
    '../../../../stores/datatableDbStore': { scopeKey: () => 'org:org_1' },
    '../../../../auth/datatableAccess': { synthesizeAccess: () => ({ default: 'app' }), gradeAtLeast: () => true },
    '../../datatableLimits': { assertDatatableQuota: async () => ({}) },
    '../mirror/linking': linking,
    './providers': { providerFor: (name) => { if (!['google_drive', 'onedrive', 'nextcloud_files'].includes(name)) { const e = new Error('no'); e.code = 'unknown_provider'; throw e; } return providerModule(name); } },
    './credentials': { resolveProviderCredential: async (userId, provider) => ({ userId, oauthProvider: provider }) },
    '../../../../integrations/nextcloudClient': { resolveAuth: async () => ({ baseUrl: 'http://nc', uid: 'admin', fetch: async () => ({}) }) },
    '../../../integrations/integrationTools': { isIntegrationPermittedForUser: async (args) => world.permitted(args) },
    '../../../../stores/userStore': { getOrganization: async () => ({ id: 'org_1', nc_instance_id: 'inst_1' }) },
    // The linker's client — what a settings change reads the sheet through.
    './linkerAuth': {
        resolveLinker: async (source, opts) => { world.linker.push([source.linkedByUserId, opts]); if (!source.linkedByUserId) throw new SpreadsheetSourceError(503, 'linker_unavailable', 'no linker'); return { api: apiFor(source.provider), userId: source.linkedByUserId, session: null, cred: {} }; },
        forget: (id) => { world.forgotten.push(id); },
    },
    // The one storage bucket: recorded per spend, and closable to prove the 429.
    '../../../../utils/perUserRateLimit': {
        perUserRateLimit: (opts) => { world.limiterOpts = opts; return (req, res, next) => { world.budget.push(req.session && req.session.user && req.session.user.id); if (world.deny) { res.set('Retry-After', '7'); return res.status(429).json({ error: 'Too many requests — limit is 30 per 60s. Retry in ~7s.' }); } next(); }; },
    },
    './schema': { reconcileMirrorSchema: async () => ({ modelVersion: 2 }) },
    './relations': { buildRelationIndexes: async () => ({ relationIndexes: new Map(), labelIndexes: new Map(), warnings: [] }) },
});
const { SpreadsheetSourceError } = require('./errors');
const link = require('./link');
test.after(() => restore());
test.beforeEach(reset);

test('providers: only storages with a credential are listed; a dead one says needs_reauth; a switched-off integration says so', async () => {
    world.connected = {
        google_drive: { connected: true, reason: null },
        onedrive: { connected: false, reason: 'needs_reauth' },
        nextcloud_files: { connected: false, reason: 'not_connected' },
    };
    let out = await link.providers(SESSION, PRINCIPAL, SCOPE);
    assert.deepStrictEqual(out, { providers: [{ provider: 'google_drive', connected: true }, { provider: 'onedrive', connected: false, reason: 'needs_reauth' }] });
    world.permitted = ({ appId }) => appId !== 'google-drive';
    out = await link.providers(SESSION, PRINCIPAL, SCOPE);
    assert.deepStrictEqual(out.providers[0], { provider: 'google_drive', connected: false, reason: 'integration_off' });
});

test('the caller gates: a switched-off integration is 403 provider_integration_off; an unknown storage is a 400 before any call', async () => {
    world.permitted = () => false;
    await assert.rejects(link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive' }), (e) => e.code === 'provider_integration_off' && e.status === 403);
    await assert.rejects(link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'dropbox' }), (e) => e.code === 'spreadsheet_rejected' && e.status === 400);
    assert.deepStrictEqual(world.calls, []);
});

test('browse: one folderId reaches every storage; root, a folder, shared, search; Nextcloud has no shared root; items carry what is linked', async () => {
    const lists = () => world.calls.filter(c => c[0] === 'list');
    world.mirrors = [{ id: 'tbl_x', managedKind: 'spreadsheet_file', source: { provider: 'google_drive', file: { id: 'f1' }, sheet: { name: null } } }];
    let out = await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive' });
    assert.deepStrictEqual(world.calls[0], ['list', 'google_drive', { view: 'mine', parentId: null, path: '/', q: null, pageToken: null }]);
    assert.deepStrictEqual(out.folder, { id: 'root', name: '', path: [] });
    assert.strictEqual(out.nextPageToken, 'next-1');
    assert.deepStrictEqual(out.items.map(i => [i.id, i.name, i.kind, i.format || null, i.linkedAs || null]), [
        ['dir1', 'Documents', 'folder', null, null],
        ['f1', 'klanten.csv', 'file', 'csv', [{ datatableId: 'tbl_x', sheet: null }]],
        ['f2', 'shared.csv', 'file', 'csv', []],
    ]);
    assert.strictEqual(out.items[2].owned, false);
    assert.strictEqual(world.calls.length, 1, 'the root is not probed');

    world.calls.length = 0;
    await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', folderId: 'dir1', pageToken: 'next-1' });
    assert.deepStrictEqual(lists()[0][2], { view: 'mine', parentId: 'dir1', path: '/', q: null, pageToken: 'next-1' });
    await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', folderId: 'shared' });
    assert.strictEqual(lists()[1][2].view, 'shared');
    await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', shared: 'true' });
    assert.strictEqual(lists()[2][2].view, 'shared');
    await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', q: ' Factu ' });
    assert.deepStrictEqual(lists()[3][2], { view: 'search', parentId: null, path: '/', q: 'Factu', pageToken: null });

    // OneDrive: a folder outside the own drive carries its drive in the id
    world.calls.length = 0;
    out = await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'onedrive' });
    assert.strictEqual(out.items[0].id, 'b!other|dir1');
    await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'onedrive', folderId: 'b!other|dir1' });
    assert.deepStrictEqual(lists()[1][2].parentId, { id: 'dir1', driveId: 'b!other' });
    await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'onedrive', folderId: '01OWN' });
    assert.strictEqual(lists()[2][2].parentId, '01OWN');

    // Nextcloud: the id IS the path, and there is no shared root
    world.calls.length = 0;
    out = await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'nextcloud_files', folderId: '/Documents/Q3' });
    assert.deepStrictEqual(world.calls[0][2], { view: 'mine', parentId: null, path: '/Documents/Q3', q: null, pageToken: null });
    assert.deepStrictEqual(out.folder, { id: '/Documents/Q3', name: 'Q3', path: [{ id: '/Documents', name: 'Documents' }, { id: '/Documents/Q3', name: 'Q3' }] });
    assert.strictEqual(out.items[0].id, '/Documents');
    assert.strictEqual(out.items[1].id, '/klanten.csv');
    world.calls.length = 0;
    await assert.rejects(link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'nextcloud_files', folderId: 'shared' }), (e) => e.code === 'no_shared_root' && e.status === 400);
    assert.deepStrictEqual(world.calls, [], 'refused before the storage is asked');
});

test('browse crumbs: Drive/OneDrive name the folder and its ancestors by probing upwards, the root excluded; a foreign OneDrive folder keeps its drive in the crumb id; a probe that fails ends the trail', async () => {
    let out = await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', folderId: 'sub' });
    assert.deepStrictEqual(out.folder, { id: 'sub', name: 'Q3', path: [{ id: 'dir1', name: 'Documents' }, { id: 'sub', name: 'Q3' }] });
    assert.deepStrictEqual(world.calls.filter(c => c[0] === 'probe').map(c => c[2].fileId), ['sub', 'dir1', 'rootid'], 'the folder, its parent, and the root that ends the walk');
    assert.ok(out.folder.path.every(c => c.name), 'never a crumb without a name');
    // one level down: the current folder alone, root excluded
    out = await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', folderId: 'dir1' });
    assert.deepStrictEqual(out.folder, { id: 'dir1', name: 'Documents', path: [{ id: 'dir1', name: 'Documents' }] });
    // OneDrive, a shared folder outside the own drive: crumbs keep the drive|item spelling the browser hands out
    out = await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'onedrive', folderId: 'b!other|sub' });
    assert.deepStrictEqual(out.folder, { id: 'b!other|sub', name: 'Q3', path: [{ id: 'b!other|dir1', name: 'Documents' }, { id: 'b!other|sub', name: 'Q3' }] });
    // an ancestor the account cannot see: the trail ends at the folder itself
    world.folders.set('orphan', { name: 'Handed over', parentId: 'nope' });
    out = await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', folderId: 'orphan' });
    assert.deepStrictEqual(out.folder, { id: 'orphan', name: 'Handed over', path: [{ id: 'orphan', name: 'Handed over' }] });
    // a folder the probe cannot name at all: an honest empty trail, still no nameless crumb
    out = await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', folderId: 'unknown' });
    assert.deepStrictEqual(out.folder, { id: 'unknown', name: '', path: [] });
    // the walk is capped
    for (let i = 0; i < 12; i += 1) world.folders.set(`d${i}`, { name: `L${i}`, parentId: i === 0 ? 'rootid' : `d${i - 1}` });
    out = await link.browse(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', folderId: 'd11' });
    assert.strictEqual(out.folder.path.length, link.MAX_CRUMB_DEPTH);
    assert.strictEqual(out.folder.path.at(-1).name, 'L11');
});

test('describe: the tabs, the inferred columns, the key candidates, a preview, the write mode', async () => {
    const out = await link.describe(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', fileId: 'f1' });
    assert.strictEqual(out.provider, 'google_drive');
    assert.strictEqual(out.fileId, 'f1');
    assert.strictEqual(out.name, 'klanten.csv');
    assert.strictEqual(out.format, 'csv');
    assert.strictEqual(out.owned, true);
    assert.deepStrictEqual(out.write, { mode: 'csv_put', reason: null, caveats: ['rewrite'] });
    assert.deepStrictEqual(out.sheets, [{ name: null, index: 0, rows: 3, cols: 3, hidden: false, linkedAs: [] }]);
    assert.strictEqual(out.sheet.name, null);
    assert.strictEqual(out.sheet.headerRow, 1);
    assert.deepStrictEqual(out.sheet.columns.map(c => [c.col, c.letter, c.header, c.key, c.type, c.unique, c.samples]), [
        [0, 'A', 'Naam', 'naam', 'text', true, ['Acme', 'Bee']],
        [1, 'B', 'Stad', 'stad', 'text', false, ['Delft']],
        [2, 'C', 'Omzet', 'omzet', 'number', true, ['1.234,56', '99,50']],
    ]);
    assert.deepStrictEqual(out.keyCandidates, [0, 2]);
    assert.deepStrictEqual(out.sheet.preview.rows, [['Naam', 'Stad', 'Omzet'], ['Acme', 'Delft', '1.234,56'], ['Bee', 'Delft', '99,50']]);
    assert.strictEqual(out.sheet.rowCount, 2);
    assert.strictEqual(out.sheet.truncated, false);
    assert.deepStrictEqual(out.warnings, []);
    const shared = await link.describe(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', fileId: 'f2' });
    assert.deepStrictEqual(shared.write, { mode: 'none', reason: 'not_owned', caveats: [] });
    await assert.rejects(link.describe(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', fileId: 'f1', headerRow: 99 }), (e) => e.code === 'spreadsheet_rejected' && e.status === 422);
    await assert.rejects(link.describe(SESSION, PRINCIPAL, SCOPE, { provider: 'google_drive', fileId: 'nope' }), (e) => e.code === 'spreadsheet_not_found');
    assert.strictEqual(world.calls.filter(c => c[0] === 'download').length, 2, 'one download per file: the tab list and the read share it');
});

test('link: every refusal comes before anything is made', async () => {
    const t = (over) => ({ provider: 'google_drive', fileId: 'f1', ...over });
    const refuses = async (body, code, status) => {
        await assert.rejects(link.linkSpreadsheets({ scope: SCOPE, principal: PRINCIPAL, session: SESSION, ...body }), (e) => {
            assert.strictEqual(e.code, code, e.message);
            if (status) assert.strictEqual(e.status, status);
            return true;
        });
        assert.strictEqual(world.made, null, 'nothing made');
    };
    await refuses({ tables: [] }, 'spreadsheet_rejected', 400);
    await refuses({ tables: Array.from({ length: 11 }, () => t()) }, 'spreadsheet_rejected', 400);
    await refuses({ tables: [t({ key: 'a' }), t({ key: 'b' })] }, 'spreadsheet_rejected', 400);
    await refuses({ tables: [t({ key: 'Bad Key' })] }, 'spreadsheet_rejected', 400);
    await refuses({ tables: [t({ key: 'a' }), t({ fileId: 'f2', key: 'a' })] }, 'spreadsheet_rejected', 400);
    await refuses({ tables: [t({ keyColumn: 1 })] }, 'key_not_unique', 422);
    await refuses({ tables: [t({ keyColumn: 7 })] }, 'key_missing', 422);
    await refuses({ tables: [t({ columns: [{ col: 0, type: 'geo' }] })] }, 'spreadsheet_rejected', 422);
    await refuses({ tables: [t({ headerRow: 0 })] }, 'spreadsheet_rejected', 422);
    await refuses({ tables: [t({ fileId: 'nope' })] }, 'spreadsheet_not_found', 404);
    // a technical name an ordinary table in this scope already has: 409 key_taken, naming the key for the wizard's names step
    world.tables = [{ id: 'tbl_plain', key: 'Facturen', name: 'Facturen' }];
    await assert.rejects(link.linkSpreadsheets({ scope: SCOPE, principal: PRINCIPAL, session: SESSION, tables: [t({ key: 'facturen' })] }), (e) => {
        assert.strictEqual(e.code, 'key_taken');
        assert.strictEqual(e.status, 409);
        assert.strictEqual(e.key, 'facturen');
        assert.strictEqual(e.errorClass, 'datatable_source_rejected');
        return true;
    });
    assert.strictEqual(world.made, null, 'nothing made');
    world.tables = [];
    world.mirrors = [{ id: 'tbl_x', name: 'Klanten', managedKind: 'spreadsheet_file', source: { provider: 'google_drive', file: { id: 'f1' }, sheet: { name: null } } }];
    await assert.rejects(link.linkSpreadsheets({ scope: SCOPE, principal: PRINCIPAL, session: SESSION, tables: [t()] }), (e) => {
        assert.strictEqual(e.code, 'already_linked');
        assert.strictEqual(e.status, 409);
        assert.strictEqual(e.datatableId, 'tbl_x');
        assert.deepStrictEqual(e.ref, { provider: 'google_drive', fileId: 'f1' });
        return true;
    });
});

test('link: the source block, the declared types, the key column, the shared-file opt-in and a relation between the two', async () => {
    const out = await link.linkSpreadsheets({
        scope: SCOPE, principal: PRINCIPAL, session: SESSION,
        tables: [
            { provider: 'google_drive', fileId: 'f1', keyColumn: 0, columns: [{ col: 0, header: 'Naam', type: 'text' }, { col: 1, header: 'Stad', type: 'select' }, { col: 2, header: 'Omzet', type: 'number' }], name: 'Klanten', key: 'klanten' },
            { provider: 'google_drive', fileId: 'f2', sharedWriteOptIn: true },
        ],
        relations: [
            { from: { provider: 'google_drive', fileId: 'f2', col: 0 }, to: { provider: 'google_drive', fileId: 'f1', col: 0 } },
            { from: { provider: 'google_drive', fileId: 'nope', col: 0 }, to: { provider: 'google_drive', fileId: 'f1', col: 0 } },
        ],
    });
    assert.strictEqual(out.partial, false);
    assert.strictEqual(out.datatables.length, 2);
    assert.deepStrictEqual(world.kicked, ['tbl_0', 'tbl_1']);
    const [a, b] = out.datatables;
    const src = a.source;
    assert.strictEqual(src.kind, 'spreadsheet_file');
    assert.strictEqual(src.provider, 'google_drive');
    assert.strictEqual(src.format, 'csv');
    assert.deepStrictEqual(src.file, { id: 'f1', driveId: null, path: null, name: 'klanten.csv', webUrl: 'https://x/f1' });
    assert.deepStrictEqual(src.sheet, { id: null, name: null, index: 0 });
    assert.strictEqual(src.headerRow, 1);
    assert.deepStrictEqual(src.identity, { mode: 'key', keyFieldId: src.identity.keyFieldId });
    assert.match(src.identity.keyFieldId, /^fld_ss[0-9a-f]{10}txt$/);
    assert.strictEqual(src.csv.delimiter, ';');
    assert.strictEqual(src.csv.decimal, ',');
    assert.strictEqual(src.owned, true);
    assert.deepStrictEqual(src.write, { mode: 'csv_put', reason: null, caveats: ['rewrite'], sharedOptIn: false });
    assert.strictEqual(src.ncInstanceId, null);
    assert.strictEqual(src.linkedByUserId, 'user_1');
    assert.deepStrictEqual(src.schedule, { everyMinutes: 1, live: true });
    assert.strictEqual(src.rowCap, 10000);
    const stad = Object.values(src.columnMap).find(e => e.header === 'Stad');
    assert.strictEqual(stad.type, 'select');
    assert.deepStrictEqual(stad.options, ['Delft'], 'a select column takes the distinct values at link time');
    assert.strictEqual(Object.values(src.columnMap).find(e => e.header === 'Naam').key, true);
    assert.strictEqual(a.name, 'Klanten');
    assert.deepStrictEqual(a._fields.filter(f => f.required).map(f => f.key), ['naam']);

    assert.strictEqual(b.name, 'shared', 'the default name is the file name without its extension');
    assert.strictEqual(b.key, 'shared');
    assert.deepStrictEqual(b.source.identity, { mode: 'row' });
    assert.deepStrictEqual(b.source.write, { mode: 'csv_put', reason: null, caveats: ['rewrite'], sharedOptIn: true }, 'the opt-in makes a shared file writable');
    assert.deepStrictEqual(b.source.relations.map(r => [r.kind, r.targetDatatableId, r.localFieldId, r.targetFieldId]), [['match', 'tbl_0', Object.keys(b.source.columnMap)[0], src.identity.keyFieldId]]);
    assert.ok(b._fields.some(f => f.key === 'klanten_ref' && f.type === 'relation'));
    assert.ok(out.warnings.some(w => /A relation was skipped/.test(w)), JSON.stringify(out.warnings));
});

/** A linked mirror's source over fixture `fileId` (the csv's columns, Naam as the key). */
function linkedSource(fileId, cols, { keyCol = 0 } = {}) {
    const first = columns.fieldsFromSheet(cols, { keyCol });
    return {
        first,
        source: {
            kind: 'spreadsheet_file', provider: 'google_drive', format: 'csv', file: { id: fileId, driveId: null, path: null, name: `${fileId}.csv`, webUrl: null },
            sheet: { id: null, name: null, index: 0 }, headerRow: 1, refreshOnView: true, rowCap: 10000,
            identity: keyCol === null ? { mode: 'row' } : { mode: 'key', keyFieldId: first.keyFieldId },
            write: { mode: 'csv_put', reason: null, caveats: ['rewrite'], sharedOptIn: false },
            linkedByUserId: 'user_0', columnMap: first.columnMap, relations: [],
        },
    };
}

test('applySettings: refreshOnView is free; headerRow, a retype and a new key column mark the copy stale; anything else is refused', async () => {
    world.files.set('f4', { name: 'f4.csv', buffer: csv(['Naam;Omzet;Totaal', 'Acme;1;2', 'Bee;3;4']), version: 1, owned: true });
    const { first, source } = linkedSource('f4', [{ col: 0, header: 'Naam', type: 'text' }, { col: 1, header: 'Omzet', type: 'number' }, { col: 2, header: 'Totaal', type: 'number', formula: true }]);
    const omzet = Object.keys(first.columnMap).find(id => first.columnMap[id].header === 'Omzet');
    const totaal = Object.keys(first.columnMap).find(id => first.columnMap[id].header === 'Totaal');

    let r = await link.applySettings(source, { refreshOnView: false });
    assert.strictEqual(r.stale, false);
    assert.strictEqual(r.next.refreshOnView, false);
    assert.deepStrictEqual(r.next.columnMap, source.columnMap);

    r = await link.applySettings(source, { headerRow: 3 });
    assert.strictEqual(r.stale, 'columns');
    assert.strictEqual(r.next.headerRow, 3);
    assert.strictEqual((await link.applySettings(source, { headerRow: 1 })).stale, false, 'the same header row changes nothing');

    r = await link.applySettings(source, { columns: { [omzet]: { type: 'text' } } });
    assert.strictEqual(r.stale, 'columns');
    assert.strictEqual(r.next.columnMap[omzet].type, 'text', 'the type is declared on the existing entry; the pass mints the new id');
    assert.strictEqual(source.columnMap[omzet].type, 'number', 'the input is not mutated');
    assert.strictEqual((await link.applySettings(source, { columns: { [omzet]: { type: 'number' } } })).stale, false);
    assert.deepStrictEqual(world.calls, [], 'nothing so far reads the file');

    r = await link.applySettings(source, { keyColumn: 1 });
    assert.strictEqual(r.stale, 'columns');
    assert.deepStrictEqual(r.next.identity, { mode: 'key', keyFieldId: omzet });
    assert.strictEqual(r.next.columnMap[omzet].key, true);
    assert.strictEqual(r.next.columnMap[first.keyFieldId].key, undefined);
    assert.deepStrictEqual(world.calls.map(c => c[0]), ['probe', 'download'], 'a NEW key column is checked over a fresh read');
    assert.deepStrictEqual(world.linker.map(l => l[0]), ['user_0'], '… read as the linker, what the pass will read');
    r = await link.applySettings(source, { keyColumn: null });
    assert.deepStrictEqual(r.next.identity, { mode: 'row' });
    assert.strictEqual(Object.values(r.next.columnMap).some(e => e.key), false);
    assert.strictEqual((await link.applySettings(source, { keyColumn: 0 })).stale, false, 'the same key changes nothing');
    assert.strictEqual(world.calls.length, 2, 'dropping the key or keeping it reads nothing');

    const refuses = (body, code) => assert.rejects(() => link.applySettings(source, body), (e) => e.code === code && e.status === 400);
    await refuses({ schedule: { everyMinutes: 5 } }, 'unknown_field');
    await refuses({ headerRow: 0 }, 'spreadsheet_rejected');
    await refuses({ columns: [] }, 'spreadsheet_rejected');
    await refuses({ columns: { [omzet]: { type: 'geo' } } }, 'spreadsheet_rejected');
    await refuses({ columns: { fld_ssnope: { type: 'text' } } }, 'unknown_field');
    await refuses({ columns: { [totaal]: { type: 'text' } } }, 'derived_column');
    await refuses({ columns: { [first.keyFieldId]: { type: 'bool' } } }, 'spreadsheet_rejected');
    await refuses({ keyColumn: 2 }, 'derived_column');
    await refuses({ keyColumn: 9 }, 'unknown_field');
    assert.strictEqual(world.calls.length, 2, 'a refused body never reaches the storage');
});

test('applySettings: a new key column that repeats or has blanks in the sheet is refused as 422 key_not_unique — exactly like the link — and one that vanished as key_missing', async () => {
    // f1: Naam;Stad;Omzet with Stad = Delft twice
    const { source } = linkedSource('f1', [{ col: 0, header: 'Naam', type: 'text' }, { col: 1, header: 'Stad', type: 'text' }, { col: 2, header: 'Omzet', type: 'number' }]);
    await assert.rejects(() => link.applySettings(source, { keyColumn: 1 }), (e) => {
        assert.strictEqual(e.code, 'key_not_unique');
        assert.strictEqual(e.status, 422);
        assert.strictEqual(e.header, 'Stad', 'the column, for the client\'s sentence');
        assert.match(e.message, /"Stad" cannot be the key: 1 rows repeat a value \("Delft"\)/);
        assert.deepStrictEqual(e.ref, { provider: 'google_drive', fileId: 'f1' });
        return true;
    });
    assert.deepStrictEqual(world.sources, [], 'nothing was stored');
    // a unique one is fine
    assert.deepStrictEqual((await link.applySettings(source, { keyColumn: 2 })).next.identity.mode, 'key');
    // blanks count too
    world.files.set('f5', { name: 'f5.csv', buffer: csv(['Naam;Stad;Omzet', 'Acme;Delft;1', ';Utrecht;2', 'Cee;;3']), version: 1, owned: true });
    const blank = linkedSource('f5', [{ col: 0, header: 'Naam', type: 'text' }, { col: 1, header: 'Stad', type: 'text' }, { col: 2, header: 'Omzet', type: 'number' }], { keyCol: null });
    await assert.rejects(() => link.applySettings(blank.source, { keyColumn: 1 }), (e) => e.code === 'key_not_unique' && /1 rows have no value in it/.test(e.message) && e.detail === '1 rows have no value in it');
    await assert.rejects(() => link.applySettings(blank.source, { keyColumn: 0 }), (e) => e.code === 'key_not_unique' && /have no value/.test(e.message));
    // the column is found in the FRESH header by its hash — a column that moved keeps its id
    world.files.set('f5', { name: 'f5.csv', buffer: csv(['Stad;Naam;Omzet', 'Delft;Acme;1', 'Utrecht;Bee;2']), version: 2, owned: true });
    const moved = await link.applySettings(blank.source, { keyColumn: 0 });
    assert.strictEqual(moved.next.columnMap[moved.next.identity.keyFieldId].header, 'Naam', 'col 0 of the stored map is Naam; the read found Naam at col 1 and checked THAT');
    // and one that is gone from the sheet
    world.files.set('f5', { name: 'f5.csv', buffer: csv(['Stad;Omzet', 'Delft;1']), version: 3, owned: true });
    await assert.rejects(() => link.applySettings(blank.source, { keyColumn: 0 }), (e) => e.code === 'key_missing' && e.status === 422 && e.header === 'Naam');
    // a caller that already holds a client hands it in; no linker is resolved
    world.linker.length = 0;
    await link.applySettings(source, { keyColumn: 2 }, { api: apiFor('google_drive') });
    assert.deepStrictEqual(world.linker, []);
    // without a linker the change cannot be checked, so it is refused rather than accepted blind
    await assert.rejects(() => link.applySettings({ ...source, linkedByUserId: null }, { keyColumn: 2 }), (e) => e.code === 'linker_unavailable');
});

test('a NUMBER key column is checked as the pass mints its ids: two spellings of one number are a duplicate at link time and at a settings change, not one skipped row at the first pass', async () => {
    // Nr holds 7,5 and 7.50 — one number, two spellings, in a decimal-comma csv.
    world.files.set('f6', { name: 'f6.csv', buffer: csv(['Nr;Naam', '7,5;Acme', '7.50;Bee', '1.000;Cee']), version: 1, owned: true });
    const t = { provider: 'google_drive', fileId: 'f6', keyColumn: 0, columns: [{ col: 0, header: 'Nr', type: 'number' }, { col: 1, header: 'Naam', type: 'text' }] };
    await assert.rejects(link.linkSpreadsheets({ scope: SCOPE, principal: PRINCIPAL, session: SESSION, tables: [t] }), (e) => {
        assert.strictEqual(e.code, 'key_not_unique', e.message);
        assert.strictEqual(e.status, 422);
        assert.match(e.message, /"Nr" cannot be the key: 1 rows repeat a value \("7.5"\)/, 'the duplicate is named in its canonical spelling');
        return true;
    });
    assert.strictEqual(world.made, null, 'nothing made');
    // declared as TEXT the two spellings are two keys, and the same sheet links
    const asText = { ...t, columns: [{ col: 0, header: 'Nr', type: 'text' }, { col: 1, header: 'Naam', type: 'text' }] };
    const out = await link.linkSpreadsheets({ scope: SCOPE, principal: PRINCIPAL, session: SESSION, tables: [asText] });
    assert.strictEqual(out.datatables.length, 1);
    // and the same rule when the key column is chosen later through the settings
    const { source } = linkedSource('f6', [{ col: 0, header: 'Nr', type: 'number' }, { col: 1, header: 'Naam', type: 'text' }], { keyCol: null });
    await assert.rejects(() => link.applySettings(source, { keyColumn: 0 }), (e) => e.code === 'key_not_unique' && /repeat a value \("7.5"\)/.test(e.message));
    // a non-number in a number key column is "no value"
    world.files.set('f6', { name: 'f6.csv', buffer: csv(['Nr;Naam', '7,5;Acme', 'abc;Bee']), version: 2, owned: true });
    await assert.rejects(() => link.applySettings(source, { keyColumn: 0 }), (e) => e.code === 'key_not_unique' && /1 rows have no value in it/.test(e.message));
});

test('relink: the caller becomes the linker, ownership and the write mode are decided afresh, a body re-points the file; a shared-file opt-in is never inherited', async () => {
    const table = {
        id: 'tbl_1', scope: SCOPE,
        source: { kind: 'spreadsheet_file', provider: 'google_drive', format: 'csv', file: { id: 'f1', driveId: null, path: null, name: 'old.csv', webUrl: null }, sheet: { id: null, name: null, index: 0 }, headerRow: 1, identity: { mode: 'row' }, csv: { delimiter: ',' }, owned: true, write: { mode: 'csv_put', reason: null, caveats: ['rewrite'], sharedOptIn: true }, linkedByUserId: 'user_0', columnMap: {}, relations: [] },
    };
    const out = await link.relink(table, PRINCIPAL, SESSION, {});
    assert.strictEqual(out.source.linkedByUserId, 'user_1');
    assert.strictEqual(out.source.file.name, 'klanten.csv');
    assert.strictEqual(out.source.write.sharedOptIn, false, 'user_0 ticked the opt-in; user_1 is the linker now and did not');
    assert.strictEqual(out.source.write.mode, 'csv_put', 'an owned file writes regardless');
    assert.deepStrictEqual(world.stale, [['tbl_1', 'relink']]);
    assert.deepStrictEqual(world.forgotten, ['user_0', 'user_1']);
    assert.deepStrictEqual(world.budget, ['user_1'], 'a relink spends the storage budget');

    // the same linker re-reading the same file keeps their own opt-in
    const same = await link.relink({ ...table, source: { ...table.source, linkedByUserId: 'user_1' } }, PRINCIPAL, SESSION, {});
    assert.strictEqual(same.source.write.sharedOptIn, true);

    // re-pointed at a file the caller does not own: read-only until they tick it themselves
    const moved = await link.relink(table, PRINCIPAL, SESSION, { file: { provider: 'nextcloud_files', path: '/f2' } });
    assert.strictEqual(moved.source.provider, 'nextcloud_files');
    assert.deepStrictEqual(moved.source.file, { id: '777', driveId: null, path: '/f2', name: 'shared.csv', webUrl: 'https://x/f2' });
    assert.strictEqual(moved.source.owned, false);
    assert.deepStrictEqual(moved.source.write, { mode: 'none', reason: 'not_owned', caveats: [], sharedOptIn: false });
    assert.strictEqual(moved.source.ncInstanceId, 'inst_1');
    assert.strictEqual(moved.source.csv.delimiter, ',', 'a csv re-pointed at a csv keeps its sniff until the pass re-reads');
    const ticked = await link.relink(table, PRINCIPAL, SESSION, { file: { provider: 'nextcloud_files', path: '/f2' }, sharedWriteOptIn: true });
    assert.deepStrictEqual(ticked.source.write, { mode: 'csv_put', reason: null, caveats: ['rewrite'], sharedOptIn: true });
    // the same linker, same file, but re-pointed at it explicitly: the consent is per file, so it is asked again
    const repointedSame = await link.relink({ ...table, source: { ...table.source, linkedByUserId: 'user_1' } }, PRINCIPAL, SESSION, { file: { provider: 'google_drive', fileId: 'f2' } });
    assert.strictEqual(repointedSame.source.write.sharedOptIn, false);

    await assert.rejects(link.relink(table, PRINCIPAL, SESSION, { file: { provider: 'google_drive', fileId: 'nope' } }), (e) => e.code === 'spreadsheet_not_found');
});

test('the storage budget: link and relink spend the one bucket before reaching the storage, and a closed bucket is a 429 rate_limited with a Retry-After — nothing probed', async () => {
    assert.deepStrictEqual(world.limiterOpts, { windowMs: 60_000, max: 30 }, 'built like the scope pickers\' limiter');
    await link.linkSpreadsheets({ scope: SCOPE, principal: PRINCIPAL, session: SESSION, tables: [{ provider: 'google_drive', fileId: 'f1', key: 'k1' }] });
    assert.deepStrictEqual(world.budget, ['user_1'], 'one unit per link call, however many sheets');
    world.deny = true;
    world.calls.length = 0;
    await assert.rejects(link.linkSpreadsheets({ scope: SCOPE, principal: PRINCIPAL, session: SESSION, tables: [{ provider: 'google_drive', fileId: 'f1', key: 'k2' }] }), (e) => {
        assert.strictEqual(e.status, 429);
        assert.strictEqual(e.code, 'rate_limited');
        assert.strictEqual(e.retryAfter, 7);
        assert.strictEqual(e.errorClass, 'datatable_source_unavailable');
        return true;
    });
    await assert.rejects(link.relink({ id: 'tbl_1', scope: SCOPE, source: { provider: 'google_drive', file: { id: 'f1' }, linkedByUserId: 'user_0', write: {} } }, PRINCIPAL, SESSION, {}), (e) => e.code === 'rate_limited');
    assert.deepStrictEqual(world.calls, [], 'refused before any storage call');
    // and the pure spend helper is what the router's browse/describe share
    assert.strictEqual(typeof link.storageLimiter, 'function');
    await assert.rejects(link.spendStorageBudget(PRINCIPAL), (e) => e.code === 'rate_limited');
});

test('a refusal names the file by the SAME id the browser handed out: drive|item for a foreign OneDrive item, the path on Nextcloud', async () => {
    // A file that is no spreadsheet: the refusal's ref is built from the
    // client's own id (fileRefOf), the path that lost the composite before.
    world.files.set('01ITEM', { name: 'deck.pptx', buffer: Buffer.from('x'), version: 1, owned: false, format: null });
    await assert.rejects(link.describe(SESSION, PRINCIPAL, SCOPE, { provider: 'onedrive', fileId: 'b!drv|01ITEM' }), (e) => {
        assert.strictEqual(e.code, 'format_unsupported');
        assert.deepStrictEqual(e.ref, { provider: 'onedrive', fileId: 'b!drv|01ITEM' }, 'the composite id the wizard keyed the row on');
        return true;
    });
    // an own OneDrive item stays bare
    world.files.set('01OWN', { name: 'deck.pptx', buffer: Buffer.from('x'), version: 1, owned: true, format: null });
    await assert.rejects(link.describe(SESSION, PRINCIPAL, SCOPE, { provider: 'onedrive', fileId: '01OWN' }), (e) => e.ref.fileId === '01OWN');
    // Nextcloud: the id IS the path
    world.files.set('deck.pptx', { name: 'deck.pptx', buffer: Buffer.from('x'), version: 1, owned: true, format: null });
    await assert.rejects(link.describe(SESSION, PRINCIPAL, SCOPE, { provider: 'nextcloud_files', fileId: '/deck.pptx' }), (e) => {
        assert.strictEqual(e.code, 'format_unsupported');
        assert.deepStrictEqual(e.ref, { provider: 'nextcloud_files', fileId: '/deck.pptx' });
        return true;
    });
    // the link's own refusals (planTable) and a relink's, through the same ref
    await assert.rejects(link.linkSpreadsheets({ scope: SCOPE, principal: PRINCIPAL, session: SESSION, tables: [{ provider: 'onedrive', fileId: 'b!drv|01ITEM', key: 'x' }] }), (e) => e.ref.fileId === 'b!drv|01ITEM');
    await assert.rejects(link.relink({ id: 't', scope: SCOPE, source: { provider: 'google_drive', file: { id: 'f1' }, linkedByUserId: 'user_0', write: {} } }, PRINCIPAL, SESSION, { file: { provider: 'onedrive', fileId: 'b!drv|01ITEM' } }), (e) => e.ref.fileId === 'b!drv|01ITEM');
});

test('unlinked forgets the linker memo and the cached bytes', async () => {
    await cache.bytes(cache.keyOf('google_drive', 'f1', { version: '1' }), async () => Buffer.from('x'));
    await link.unlinked({ source: { provider: 'google_drive', file: { id: 'f1' }, linkedByUserId: 'user_9' } });
    assert.deepStrictEqual(world.forgotten, ['user_9']);
    assert.strictEqual(cache.stats().entries, 0);
});
