/**
 * LINKING: which storages this account can browse, what is in them, what one
 * sheet would arrive as, and making one or several mirrors — the spreadsheet
 * twin of ../nextcloudTable/link.js.
 *
 * ── TWO IDENTITIES, KEPT APART ──────────────────────────────────────
 * `providers`, `browse`, `describe` and the validation half of
 * `linkSpreadsheets` run as the CALLER, on their own request session, through
 * the same integration gate and (for Nextcloud) the same per-folder scope
 * guard the agent tools pass — a file a person cannot reach in chat is not
 * offered here either. `linkSpreadsheets` records that caller as the mirror's
 * linker (`source.linkedByUserId`), and from then on every refresh runs as
 * them (linkerAuth.js).
 *
 * ── VALIDATE EVERYTHING, THEN MAKE EVERYTHING ───────────────────────
 * Every requested sheet is probed, read and checked (the file is a
 * spreadsheet, the sheet exists, the header is there, the key column is
 * unique, the technical name is free) BEFORE a single table is created —
 * a wizard that linked three of five sheets and refused two is a support
 * ticket. Then every table is created EMPTY, then every table's columns are
 * derived (so a declared relation between two sheets of this call can name
 * its target), then the first refresh of each is kicked, targets first —
 * the choreography is every source's and lives in ../mirror/linking.
 *
 * ── WHAT THE LINK DECIDES ONCE ──────────────────────────────────────
 * The column TYPES (the wizard's, or inferred here when it sent none — never
 * re-inferred by a later pass), the IDENTITY (a key column, checked unique
 * over the full read, or the row number), and the WRITE MODE (reading.js
 * writeModeFor: by format, by ownership, by the storage's permission, and
 * for OneDrive by whether the workbook API answers for this file — asked
 * here, once, so the pass never asks Graph again).
 *
 * ── ONE BUDGET FOR EVERY CALL THAT REACHES A STORAGE ────────────────
 * Browsing, describing, linking (up to ten probes + downloads + parses per
 * call) and re-linking (a probe, and a download when the file or sheet is
 * re-pointed) all cost the storage — and the one process's two parse slots.
 * They share ONE per-user bucket, `storageLimiter`, the same thirty a minute
 * the Nextcloud scope pickers have. The spreadsheets router mounts it as
 * middleware on browse and describe; link and relink spend it HERE, because
 * the relink route lives in routes/datatables.js beside its Nextcloud twin
 * (no storage limiter there) and a bucket split over two files is two
 * budgets. The cheapest refusals (an over-quota scope, a bad body) come
 * before the spend.
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
const { KEY_RE } = require('../../dataModel/vocabulary');
const { managedKindSpec } = require('../../dataModel/managedTables');
const { assertDatatableQuota } = require('../../datatableLimits');
const { perUserRateLimit } = require('../../../../utils/perUserRateLimit');
const linking = require('../mirror/linking');
const { SpreadsheetSourceError, providerName } = require('./errors');
const columns = require('./columns');
const identity = require('./identity');
const reading = require('./reading');
const formats = require('./formats');
const cache = require('./cache');
const { inferColumns } = require('./infer');
const { isoDate, isoDateTime, hasTime } = require('./cells');
const sync = require('./sync');
const { KIND, PROVIDERS } = require('./index');

const TAG = '[SpreadsheetFile]';
const MAX_TABLES_PER_LINK = 10;
const PREVIEW_ROWS = 5;
const KEY_TYPES = ['text', 'number'];
/** Folder crumbs on Drive/OneDrive are probed upwards; a tree deeper than this shows its last levels. */
const MAX_CRUMB_DEPTH = 8;

/** The per-user bucket every storage-reaching call spends (see the header). */
const storageLimiter = perUserRateLimit({ windowMs: 60_000, max: 30 });

/**
 * Spend one unit of `storageLimiter` off the middleware path — for link and
 * relink, which reach the storage from an engine function rather than a
 * route of the spreadsheets router. The limiter is Express-shaped, so it is
 * handed the one thing it reads (a session with the user's id) and a
 * response whose only verb that fires is the 429; that becomes a refusal
 * the route answers like any other.
 */
function spendStorageBudget(principal) {
    const userId = (principal && principal.userId) || null;
    return new Promise((resolve, reject) => {
        const req = { session: { user: { id: userId } }, ip: 'engine' };
        let retryAfter = 60;
        const res = {
            set: (name, value) => { if (String(name).toLowerCase() === 'retry-after') retryAfter = Number(value) || retryAfter; return res; },
            status: () => res,
            json: (body) => {
                const e = rejected(429, 'rate_limited', (body && body.error) || 'Too many storage calls — try again in a minute.');
                e.retryAfter = retryAfter;
                reject(e);
                return res;
            },
        };
        try {
            storageLimiter(req, res, () => resolve());
        } catch (e) {
            reject(e);
        }
    });
}

function deps() {
    // Lazily required: the pure modules beside this one must stay loadable in
    // suites that stub the database, and these pull in stores at load time.
    return {
        providers: require('./providers'),
        credentials: require('./credentials'),
        ncClient: require('../../../../integrations/nextcloudClient'),
        isIntegrationPermittedForUser: require('../../../integrations/integrationTools').isIntegrationPermittedForUser,
        userStore: require('../../../../stores/userStore'),
    };
}

function rejected(status, code, message, extra) {
    return new SpreadsheetSourceError(status, code, message, extra);
}

function assertProvider(provider) {
    if (!PROVIDERS.includes(provider)) {
        throw rejected(400, 'spreadsheet_rejected', `Say which storage to use (${PROVIDERS.join(', ')}).`);
    }
}

function clampHeaderRow(headerRow) {
    if (headerRow === undefined || headerRow === null || headerRow === '') return 1;
    const h = Number(headerRow);
    if (!Number.isInteger(h) || h < 1 || h > formats.MAX_HEADER_ROW) {
        throw rejected(422, 'spreadsheet_rejected', `The header row must be between 1 and ${formats.MAX_HEADER_ROW}.`);
    }
    return h;
}

/**
 * The `ref` a refusal carries: the wire id, and the sheet it was about. The
 * id must be the one the browser handed out and the wizard keyed its rows
 * on — a `fileRefOf` ref (split from the client's id) has no `owned`, and it
 * carries a driveId ONLY when the client sent a composite `drive|item`, so
 * that is read back as "foreign drive" and the composite is re-emitted.
 */
function wireRef(provider, ref, sheet = null) {
    const owned = ref.owned === undefined ? !ref.driveId : ref.owned;
    return { provider, fileId: reading.wireIdOf({ ...ref, provider, owned }), ...(sheet ? { sheet } : {}) };
}

function cellText(v) {
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : (hasTime(v) ? isoDateTime(v) : isoDate(v));
    return String(v);
}

/**
 * The caller's own storage client, after the gates. Throws the
 * SpreadsheetSourceError the route answers with.
 */
async function callerApi(session, principal, provider) {
    assertProvider(provider);
    const d = deps();
    let mod;
    try {
        mod = d.providers.providerFor(provider);
    } catch (e) {
        if (e && e.code === 'unknown_provider') throw rejected(422, 'spreadsheet_rejected', `${providerName(provider)} is not available on this server.`);
        throw e;
    }
    const userId = principal && principal.userId;
    const orgId = (principal && principal.orgId) || null;
    if (!userId) throw rejected(403, 'provider_not_connected', 'Sign in to link a spreadsheet.');
    const permitted = await d.isIntegrationPermittedForUser({ userId, appId: mod.integrationAppIds[0], session, isAdmin: !!(session && session.isAdmin) });
    if (!permitted) {
        throw rejected(403, 'provider_integration_off', `${providerName(provider)} is switched off for this account.`);
    }
    const ctx = { userId, orgId, session };
    if (provider === 'nextcloud_files') {
        let auth = null;
        try { auth = await d.ncClient.resolveAuth(session, userId); } catch (_) { auth = null; }
        if (!auth || !auth.baseUrl || typeof auth.fetch !== 'function') {
            throw rejected(403, 'provider_not_connected', (auth && auth.authError) || 'This account is not connected to Nextcloud.');
        }
        return { api: mod.forCaller(auth, ctx), mod, d, ctx };
    }
    const cred = await d.credentials.resolveProviderCredential(userId, mod.oauthProvider, { session, orgId });
    return { api: mod.forCaller(cred, ctx), mod, d, ctx };
}

/** Which mirrors in `scope` already copy a sheet of which file: fileKey → [{ datatableId, sheet }]. */
async function linkedIn(scope) {
    const out = new Map();
    if (!scope) return out;
    const mirrors = await datatableStore.listSourceMirrorsInScope(scope, { kind: KIND });
    for (const m of mirrors) {
        const src = m.source || {};
        const key = reading.fileKeyOf(src.provider, src.file);
        const list = out.get(key) || [];
        list.push({ datatableId: m.id, sheet: (src.sheet && src.sheet.name) || null });
        out.set(key, list);
    }
    return out;
}

// ─── providers ──────────────────────────────────────────────────────────

/**
 * Which storages this account could link from. CHEAP — a vault row, the
 * session's provider, the Nextcloud binding — never a call to the storage:
 * the create dialog asks this to decide whether to show the card at all.
 * Only storages the account has a credential or binding for are listed;
 * `connected:false` carries why.
 */
async function providers(session, principal, scope) {
    void scope;
    const d = deps();
    const userId = principal && principal.userId;
    const out = [];
    for (const provider of PROVIDERS) {
        let mod;
        try { mod = d.providers.providerFor(provider); } catch (_) { continue; }
        let status;
        try {
            status = await mod.isConnected({ userId, session });
        } catch (_) {
            status = { connected: false, reason: 'unavailable' };
        }
        if (!status || (!status.connected && (!status.reason || status.reason === 'not_connected'))) continue;
        if (!status.connected) { out.push({ provider, connected: false, reason: status.reason }); continue; }
        const permitted = await d.isIntegrationPermittedForUser({ userId, appId: mod.integrationAppIds[0], session, isAdmin: !!(session && session.isAdmin) }).catch(() => false);
        out.push(permitted ? { provider, connected: true } : { provider, connected: false, reason: 'integration_off' });
    }
    return { providers: out };
}

// ─── browse ─────────────────────────────────────────────────────────────

function truthy(v) {
    return v === true || v === 'true' || v === '1' || v === 1;
}

/** A FileRef → the browser's item. */
function toItem(ref, linked) {
    const item = {
        id: reading.wireIdOf(ref),
        name: ref.name || '',
        kind: ref.isFolder ? 'folder' : 'file',
    };
    if (!ref.isFolder && ref.format) item.format = ref.format;
    if (ref.size != null) item.size = ref.size;
    if (ref.modifiedAt) item.modifiedAt = ref.modifiedAt;
    if (ref.webUrl) item.webUrl = ref.webUrl;
    if (ref.path) item.path = ref.path;
    if (ref.owned !== undefined) item.owned = !!ref.owned;
    if (ref.driveId) item.driveId = ref.driveId;
    if (!ref.isFolder) item.linkedAs = linked.get(reading.fileKeyOf(ref.provider, { id: ref.fileId, path: ref.path })) || [];
    return item;
}

/**
 * One folder of one storage: sub-folders and spreadsheet files, with which
 * mirrors in `scope` already copy a sheet of each. `folderId` is `'root'`,
 * `'shared'` (Drive/OneDrive shared-with-me; Nextcloud has none) or the
 * storage's own id — on Nextcloud the id IS the path.
 */
async function browse(session, principal, scope, { provider, folderId = null, q = null, shared = null, pageToken = null } = {}) {
    assertProvider(provider);
    const term = typeof q === 'string' ? q.trim() : '';
    const id = folderId === undefined || folderId === null || folderId === '' ? 'root' : String(folderId);
    const wantShared = id === 'shared' || (id === 'root' && truthy(shared));
    if (wantShared && !term && provider === 'nextcloud_files') {
        throw rejected(400, 'no_shared_root', 'Nextcloud has no "shared with me" folder — shared folders appear among your files.');
    }
    const ctx = await callerApi(session, principal, provider);
    let view = 'mine';
    let parentId = null;
    let path = '/';
    if (term) {
        view = 'search';
    } else if (wantShared) {
        view = 'shared';
    } else if (id !== 'root') {
        if (provider === 'nextcloud_files') {
            path = id.startsWith('/') ? id : `/${id}`;
        } else if (provider === 'onedrive') {
            const ref = reading.fileRefOf(provider, { fileId: id });
            parentId = ref.driveId ? { id: ref.fileId, driveId: ref.driveId } : ref.fileId;
        } else {
            parentId = id;
        }
    }
    const res = await ctx.api.list({ view, parentId, path, q: term || null, pageToken: pageToken || null });
    const linked = await linkedIn(scope);
    const items = (res.items || []).map(ref => toItem(ref, linked));
    let folder;
    if (view === 'shared') {
        folder = { id: 'shared', name: 'Shared with me', path: [] };
    } else if (id === 'root' || view === 'search') {
        folder = { id: 'root', name: '', path: [] };
    } else if (provider === 'nextcloud_files') {
        folder = { id, name: path.split('/').pop() || '', path: crumbs(path) };
    } else {
        const trail = await folderTrail(ctx, provider, typeof parentId === 'object' ? parentId : { id: parentId, driveId: null });
        folder = { id, name: trail.length ? trail[trail.length - 1].name : '', path: trail };
    }
    return { provider, folder, items, nextPageToken: res.nextPageToken || null };
}

/** `/Documents/Q3` → [{ id:'/Documents', name:'Documents' }, { id:'/Documents/Q3', name:'Q3' }]. */
function crumbs(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    const out = [];
    let acc = '';
    for (const p of parts) { acc += `/${p}`; out.push({ id: acc, name: p }); }
    return out;
}

/**
 * The crumbs of a Drive/OneDrive folder — [{ id, name }] from the top down.
 * Neither storage names a folder in its children listing, so the folder is
 * probed, then its parent, and so on up to the drive's root (the item with
 * no parent of its own — the client calls that one "All files" and it is
 * not a crumb). A probe that fails (an ancestor of a shared folder the
 * account cannot see) ends the trail where it is; the folder that was
 * opened is always the first probe, so at worst the trail is that folder
 * alone. Every crumb has a name, and its id is the browser's own (a foreign
 * OneDrive folder keeps its `drive|item` spelling).
 */
async function folderTrail(ctx, provider, first) {
    const up = [];
    const seen = new Set();
    let cur = first && first.id ? { fileId: String(first.id), driveId: first.driveId || null } : null;
    for (let depth = 0; cur && depth < MAX_CRUMB_DEPTH; depth += 1) {
        const key = `${cur.driveId || ''}|${cur.fileId}`;
        if (seen.has(key)) break;
        seen.add(key);
        let p = null;
        try { p = await ctx.api.probe({ provider, fileId: cur.fileId, driveId: cur.driveId }); } catch (_) { break; }
        const file = (p && p.file) || {};
        const parentId = file.parentId || null;
        // An ancestor without a parent is the drive root, not a crumb.
        if (depth > 0 && !parentId) break;
        const name = String(p.name || file.name || '').trim();
        if (!name) break;
        up.push({ id: reading.wireIdOf({ ...file, provider, fileId: file.fileId || cur.fileId, driveId: file.driveId || cur.driveId }), name });
        cur = parentId ? { fileId: String(parentId), driveId: file.driveId || cur.driveId || null } : null;
    }
    return up.reverse();
}

// ─── describe ───────────────────────────────────────────────────────────

/** The tab the request names, or the first visible one; a csv has exactly one. */
function pickTab(tabs, sheet, format, ref) {
    if (!tabs.length) throw rejected(404, 'sheet_missing', 'The spreadsheet has no worksheets.', { ref: wireRef(ref.provider, ref) });
    if (format === 'csv' || sheet === undefined || sheet === null || sheet === '') return tabs.find(t => !t.hidden) || tabs[0];
    const name = String(sheet);
    const found = tabs.find(t => t.name === name);
    if (!found) {
        throw rejected(404, 'sheet_missing', `The spreadsheet has no worksheet called "${name}" (it has: ${tabs.map(t => t.name).slice(0, 10).join(', ')}).`, { ref: wireRef(ref.provider, ref, name) });
    }
    return found;
}

/** Probe a file, list its tabs, read one — the same three steps describe and link take. */
async function openForCaller(ctx, ref, { sheet, headerRow, rowCap }) {
    const probe = await ctx.api.probe(ref);
    if (!probe.format) {
        throw rejected(415, 'format_unsupported', `"${probe.name}" is not a spreadsheet Bee Flow can read.`, { ref: wireRef(ref.provider, ref) });
    }
    const viaCells = await reading.cellsAvailable(ctx.api, probe);
    const tabs = await reading.listSheetsOf(ctx.api, probe, { viaCells });
    const chosen = pickTab(tabs, sheet, probe.format, ref);
    const read = await reading.readSheetOf(ctx.api, probe, {
        sheet: probe.format === 'csv' ? null : chosen.name, headerRow, rowCap, viaCells,
    });
    return { probe, viaCells, tabs, chosen, read, workbook: viaCells && probe.format !== 'gsheet' };
}

/**
 * What linking one sheet would produce: the tabs, the inferred columns, a
 * preview, the key candidates, and how rows could be written back.
 */
async function describe(session, principal, scope, { provider, fileId, driveId = null, path = null, sheet = null, headerRow = 1 } = {}) {
    const ctx = await callerApi(session, principal, provider);
    const ref = reading.fileRefOf(provider, { fileId, driveId, path });
    const h = clampHeaderRow(headerRow);
    const opened = await openForCaller(ctx, ref, { sheet, headerRow: h, rowCap: sync.DEFAULT_ROW_CAP });
    const { probe, tabs, chosen, read, workbook } = opened;
    const inf = inferColumns(read.header, read.rows, { dateCols: read.dateCols, formulaCols: read.formulaCols, numFmts: read.numFmts });
    const write = reading.writeModeFor({ provider, format: probe.format, owned: probe.owned, writable: probe.writable, workbook });
    const linked = (await linkedIn(scope)).get(reading.fileKeyOf(provider, { id: probe.file.fileId, path: probe.file.path })) || [];
    return {
        provider,
        fileId: reading.wireIdOf(probe.file),
        name: probe.name || null,
        format: probe.format,
        webUrl: probe.webUrl || null,
        path: probe.path || null,
        owned: !!probe.owned,
        write: { mode: write.mode, reason: write.reason, caveats: write.caveats },
        sheets: tabs.map(t => ({
            name: t.name, index: t.index, rows: t.rows, cols: t.cols, hidden: !!t.hidden,
            linkedAs: linked.filter(l => (l.sheet || null) === (t.name || null)).map(l => l.datatableId),
        })),
        sheet: {
            name: chosen.name,
            headerRow: h,
            columns: inf.columns.map(c => ({
                col: c.col, letter: c.letter, header: c.header, key: c.key, type: c.type,
                unique: c.unique, blankHeader: c.blankHeader, duplicateHeader: c.duplicateHeader, formula: c.formula,
                samples: c.samples, distinct: c.distinct, empties: c.empties,
                ...(c.dateFormat ? { dateFormat: c.dateFormat } : {}),
                ...(c.format ? { format: c.format } : {}),
            })),
            preview: { rows: [read.header.map(cellText), ...read.rows.slice(0, PREVIEW_ROWS).map(r => r.map(cellText))] },
            rowCount: read.rows.length,
            truncated: !!read.truncated,
        },
        keyCandidates: inf.keyCandidates,
        warnings: [...(read.warnings || []), ...inf.warnings],
    };
}

// ─── link ───────────────────────────────────────────────────────────────

/** Select options for a column at link time: the distinct values of the read, in order, capped. */
function optionsOf(rows, col) {
    const seen = new Set();
    const out = [];
    for (const r of rows) {
        const v = r[col];
        if (v === null || v === undefined || v === '') continue;
        const label = cellText(v).trim();
        if (!label || seen.has(label)) continue;
        seen.add(label);
        out.push(label);
        if (out.length >= 100) break;
    }
    return out;
}

function defaultNameFor(probe, chosen, tabs) {
    const base = String(probe.name || 'Sheet').replace(/\.[a-z0-9]+$/i, '').trim() || 'Sheet';
    return tabs.length > 1 && chosen.name ? `${base} – ${chosen.name}` : base;
}

/** The `source` block of a planned mirror. */
function sourceBlock(p, principal, ncInstanceId) {
    return {
        kind: KIND,
        provider: p.provider,
        format: p.probe.format,
        file: {
            id: p.probe.file.fileId || null,
            driveId: p.probe.file.driveId || null,
            path: p.probe.path || p.probe.file.path || null,
            name: p.probe.name || null,
            webUrl: p.probe.webUrl || null,
        },
        sheet: p.sheet,
        headerRow: p.headerRow,
        identity: p.keyFieldId ? { mode: 'key', keyFieldId: p.keyFieldId } : { mode: 'row' },
        csv: p.csv,
        owned: !!p.probe.owned,
        write: p.write,
        ncInstanceId: p.provider === 'nextcloud_files' ? ncInstanceId : null,
        linkedByUserId: principal.userId,
        linkedAt: new Date().toISOString(),
        schedule: sync.scheduleOf(),
        refreshOnView: true,
        rowCap: sync.DEFAULT_ROW_CAP,
        columnMap: {},
        relations: [],
    };
}

/**
 * Validate ONE requested sheet as the caller: probe, read, resolve the
 * columns' types, check the key column. Returns the plan or throws.
 */
async function planTable(t, { apiFor, siblings, seenRefs, warnings, spec }) {
    if (!t || typeof t !== 'object') throw rejected(400, 'spreadsheet_rejected', 'Each entry names a file and a sheet.');
    assertProvider(t.provider);
    const provider = t.provider;
    const ref = reading.fileRefOf(provider, { fileId: t.fileId, driveId: t.driveId, path: t.path });
    const wanted = t.sheet === undefined || t.sheet === null || t.sheet === '' ? null : String(t.sheet);
    const h = clampHeaderRow(t.headerRow);
    const ctx = await apiFor(provider);
    const opened = await openForCaller(ctx, ref, { sheet: wanted, headerRow: h, rowCap: sync.DEFAULT_ROW_CAP });
    const { probe, tabs, chosen, read, workbook } = opened;
    const sheetName = chosen.name || null;
    const refKey = `${reading.fileKeyOf(provider, { id: probe.file.fileId, path: probe.file.path })}|${sheetName || ''}`;
    if (seenRefs.has(refKey)) throw rejected(400, 'spreadsheet_rejected', 'The same sheet is listed twice.', { ref: wireRef(provider, probe.file, sheetName) });
    seenRefs.add(refKey);
    const already = siblings.byRef.get(refKey);
    if (already) {
        throw rejected(409, 'already_linked', `"${already.name}" already mirrors that sheet.`, { ref: wireRef(provider, probe.file, sheetName), datatableId: already.id });
    }

    const described = columns.describeHeader(read.header);
    const declared = new Map();
    for (const c of Array.isArray(t.columns) ? t.columns : []) {
        if (!c || !Number.isInteger(c.col)) continue;
        if (c.type !== undefined && c.type !== null && !columns.DECLARABLE_TYPES.includes(c.type)) {
            throw rejected(422, 'spreadsheet_rejected', `"${c.header || columns.columnLetter(c.col)}" cannot be a ${String(c.type).slice(0, 20)} column here.`, { ref: wireRef(provider, probe.file, sheetName) });
        }
        declared.set(c.col, c);
    }
    let inferred = null;
    if (described.some(d => !declared.has(d.col) || !declared.get(d.col).type)) {
        inferred = new Map(inferColumns(read.header, read.rows, { dateCols: read.dateCols, formulaCols: read.formulaCols, numFmts: read.numFmts }).columns.map(c => [c.col, c]));
    }
    const cols = described.map((d) => {
        const w = declared.get(d.col);
        const inf = inferred && inferred.get(d.col);
        if (w && w.header !== undefined && w.header !== null && columns.headerText(w.header) !== d.header) {
            warnings.push(`Column ${d.letter} is now "${d.header}" (the wizard saw "${columns.headerText(w.header)}").`);
        }
        const type = (w && w.type) || (inf && inf.type) || 'text';
        const c = { col: d.col, header: read.header[d.col], type, formula: read.formulaCols.has(d.col) };
        const numFmt = read.numFmts.get(d.col);
        if (numFmt) c.numFmt = numFmt;
        if (inf && inf.dateFormat) c.dateFormat = inf.dateFormat;
        if (type === 'select') c.options = optionsOf(read.rows, d.col);
        return c;
    });

    let keyCol = null;
    let keyFieldId = null;
    if (t.keyColumn !== undefined && t.keyColumn !== null) {
        const col = Number(t.keyColumn);
        const kd = described.find(d => d.col === col);
        if (!Number.isInteger(col) || !kd) {
            throw rejected(422, 'key_missing', 'The key column is not one of the header columns.', { ref: wireRef(provider, probe.file, sheetName) });
        }
        const kc = cols.find(c => c.col === col);
        if (kc.formula) throw rejected(422, 'spreadsheet_rejected', `"${kd.name}" holds formulas and cannot be the key.`, { ref: wireRef(provider, probe.file, sheetName) });
        if (!KEY_TYPES.includes(kc.type)) throw rejected(422, 'spreadsheet_rejected', `Only a text or number column can be the key — "${kd.name}" is ${kc.type}.`, { ref: wireRef(provider, probe.file, sheetName) });
        // Checked as the pass will mint the ids (identity.js): in a number
        // column '7,5' and '7.50' are one key, so they are reported here as
        // a duplicate rather than becoming one skipped row at the first pass.
        const check = identity.checkKeyColumn(read.rows, col, kc.type);
        if (!check.unique) {
            const why = [];
            if (check.missing) why.push(`${check.missing} rows have no value in it`);
            if (check.duplicate) why.push(`${check.duplicate} rows repeat a value${check.firstDuplicate ? ` ("${String(check.firstDuplicate).slice(0, 40)}")` : ''}`);
            throw rejected(422, 'key_not_unique', `"${kd.name}" cannot be the key: ${why.join(' and ')}.`, { ref: wireRef(provider, probe.file, sheetName), detail: why.join('; '), header: kd.name });
        }
        kc.key = true;
        keyCol = col;
        keyFieldId = columns.fieldIdFor(kd.headerHash, kc.type);
    }

    const fallbackName = defaultNameFor(probe, chosen, tabs);
    const name = String(t.name || fallbackName).trim().slice(0, 120) || fallbackName;
    const key = String(t.key || columns.keyFromTitle(name, 0, new Set())).trim();
    if (!KEY_RE.test(key)) {
        throw rejected(400, 'spreadsheet_rejected', `"${key}" is not a valid technical name — lowercase letters, numbers and underscores, starting with a letter.`, { ref: wireRef(provider, probe.file, sheetName) });
    }
    const description = String(t.description ?? spec.defaultDescription).trim() || spec.defaultDescription;
    const write = reading.writeModeFor({
        provider, format: probe.format, owned: probe.owned, writable: probe.writable, workbook, sharedOptIn: t.sharedWriteOptIn === true,
    });
    return {
        provider, ref, probe, refKey, described, cols, keyCol, keyFieldId,
        sheet: { id: chosen.id ?? null, name: sheetName, index: Number.isInteger(chosen.index) ? chosen.index : 0 },
        headerRow: h, csv: read.csv || null, write,
        name, key, description,
    };
}

/**
 * Link one or more sheets as mirrors in `scope`.
 *
 * @param {object} args
 * @param {{kind,id}} args.scope
 * @param {object} args.principal   resolveDatatablePrincipal's answer (userId, orgId)
 * @param {object} args.session     the caller's request session
 * @param {Array}  args.tables      [{ provider, fileId, driveId?, path?, sheet?, headerRow?, keyColumn?, columns?, sharedWriteOptIn?, name?, key?, description? }]
 * @param {Array}  [args.relations] [{ from:{provider,fileId,sheet,col}, to:{provider,fileId,sheet,col} }]
 * @returns {Promise<{ datatables:Array, warnings:string[], partial:boolean }>}
 */
async function linkSpreadsheets({ scope, principal, session, tables, relations = [] }) {
    if (!Array.isArray(tables) || !tables.length) {
        throw rejected(400, 'spreadsheet_rejected', 'Choose at least one sheet to link.');
    }
    if (tables.length > MAX_TABLES_PER_LINK) {
        throw rejected(400, 'spreadsheet_rejected', `At most ${MAX_TABLES_PER_LINK} sheets can be linked at once.`);
    }
    // Cheapest refusals first: an over-quota scope must not cost ten
    // downloads, and the storage budget is spent only once they are past
    // (planTable throws rather than skips, so tables.length IS the count).
    await assertDatatableQuota(scope, { addTables: tables.length });
    await spendStorageBudget(principal);
    const spec = managedKindSpec(KIND);
    const siblings = await sync.siblingsOf(scope);
    const warnings = [];
    const apis = new Map();
    const apiFor = async (provider) => {
        if (!apis.has(provider)) apis.set(provider, await callerApi(session, principal, provider));
        return apis.get(provider);
    };

    // ── validate and read every requested sheet BEFORE creating any ──
    const plans = [];
    const seenRefs = new Set();
    for (const t of tables) plans.push(await planTable(t, { apiFor, siblings, seenRefs, warnings, spec }));
    const keys = plans.map(p => p.key);
    if (new Set(keys).size !== keys.length) {
        throw rejected(400, 'spreadsheet_rejected', 'Two sheets would get the same technical name.');
    }
    // A technical name an ordinary table already has in this scope: refused
    // by name here so the wizard can mark the names step (`key` on the
    // body); the store's unique index is the race-safe backstop, and the
    // router maps that violation to the same 409 key_taken.
    const taken = new Set((await datatableStore.listDatatablesForScope(scope)).map(t => String(t.key || '').toLowerCase()));
    for (const p of plans) {
        if (taken.has(p.key.toLowerCase())) {
            throw rejected(409, 'key_taken', `There is already a table with the technical name "${p.key}" here.`, { key: p.key });
        }
    }

    const d = deps();
    const org = principal.orgId ? await d.userStore.getOrganization(principal.orgId).catch(() => null) : null;
    const ncInstanceId = org ? (org.nc_instance_id || org.ncInstanceId || null) : null;

    // ── create every table, empty ───────────────────────────────────
    const made = await linking.createEmptyMirrors({
        scope, principal, KIND, plans,
        sourceFor: (p) => sourceBlock(p, principal, ncInstanceId),
    });
    const { created } = made;
    let partial = made.partial;
    warnings.push(...made.warnings);

    // ── then derive every table's columns, siblings included ────────
    const declared = resolveDeclared(relations, created, siblings);
    warnings.push(...declared.warnings);
    const stored = await linking.storeDerived(scope, created, (plan, table) => columns.fieldsFromSheet(plan.cols, {
        existingFields: [],
        existingColumnMap: {},
        declaredRelations: declared.byTable.get(table.id) || [],
        keyCol: plan.keyCol,
    }));
    partial = partial || stored.partial;
    warnings.push(...stored.warnings);

    // ── kick the first refresh, targets before the mirrors that point at them ──
    const finals = await linking.kickFirstSyncs(scope, stored.tables, sync.syncRows, TAG);
    return { datatables: finals, warnings, partial };
}

/**
 * The request's `{ from:{provider,fileId,sheet,col}, to:{…} }` pairs → per-mirror
 * declared relations (columns.js shape). A side that names a sheet not in
 * this call or this scope is a warning, not a failure.
 */
function resolveDeclared(relations, created, siblings) {
    const byTable = new Map();
    const warnings = [];
    const createdByRef = new Map(created.map(({ plan, table }) => [plan.refKey, { plan, table }]));

    /** The mirror and the field a side names, or null. */
    function sideOf(side) {
        if (!side || !PROVIDERS.includes(side.provider) || !Number.isInteger(side.col)) return null;
        let ref;
        try { ref = reading.fileRefOf(side.provider, { fileId: side.fileId, driveId: side.driveId, path: side.path }); } catch (_) { return null; }
        const sheet = side.sheet === undefined || side.sheet === null || side.sheet === '' ? '' : String(side.sheet);
        const refKey = `${reading.fileKeyOf(side.provider, { id: ref.fileId, path: ref.path })}|${sheet}`;
        const made = createdByRef.get(refKey);
        if (made) {
            const d = made.plan.described.find(x => x.col === side.col);
            const c = made.plan.cols.find(x => x.col === side.col);
            if (!d || !c || c.formula) return null;
            return { table: made.table, fieldId: columns.fieldIdFor(d.headerHash, c.type), created: true };
        }
        const existing = siblings.byRef.get(refKey);
        if (!existing) return null;
        for (const [fieldId, entry] of Object.entries((existing.source && existing.source.columnMap) || {})) {
            if (entry && !entry.derived && entry.col === side.col && !entry.formula) return { table: existing, fieldId, created: false };
        }
        return null;
    }

    for (const rel of Array.isArray(relations) ? relations : []) {
        const from = sideOf(rel && rel.from);
        const to = sideOf(rel && rel.to);
        if (!from || !to) {
            warnings.push('A relation was skipped because one of its sides does not name a linked sheet and one of its columns.');
            continue;
        }
        if (!from.created) {
            warnings.push(`A relation from "${from.table.name}" was skipped: that table was linked earlier — add the relation on its Relations tab.`);
            continue;
        }
        const list = byTable.get(from.table.id) || [];
        list.push({
            targetDatatableId: to.table.id, targetKey: to.table.key, targetName: to.table.name,
            localFieldId: from.fieldId, targetFieldId: to.fieldId,
        });
        byTable.set(from.table.id, list);
    }
    return { byTable, warnings };
}

// ─── the per-table settings ─────────────────────────────────────────────

/**
 * Replace a mirror's DECLARED relations. The next refresh recomputes
 * everything. @param {Array} relations [{ targetDatatableId, localFieldId, targetFieldId }]
 */
function setRelations(datatable, relations) {
    return linking.setRelations(datatable, relations, {
        siblingsOf: sync.siblingsOf,
        matchFieldIdFor: columns.matchFieldIdFor,
        Err: SpreadsheetSourceError,
        rejectedCode: 'spreadsheet_rejected',
    });
}

/**
 * Make the caller the mirror's linker, after proving they can reach the
 * file — re-pointed at another file or sheet when the body says so
 * (`{ file:{ provider, fileId, driveId?, path? }, sheet?, sharedWriteOptIn? }`).
 * Ownership, permission and the write mode are decided afresh. A
 * shared-file opt-in only survives for the SAME linker on the SAME file; a
 * new linker (whose credentials will do the writing) or a re-pointed file
 * starts read-only until the caller ticks `sharedWriteOptIn: true` in the
 * body — the consent is per file and per person, never inherited.
 */
async function relink(datatable, principal, session, body = {}) {
    const source = datatable.source || {};
    const target = body && body.file && typeof body.file === 'object' ? body.file : null;
    const provider = (target && target.provider) || source.provider;
    const ctx = await callerApi(session, principal, provider);
    // The gates are free; the probe (and a re-pointed file's tab list) is not.
    await spendStorageBudget(principal);
    const ref = target
        ? reading.fileRefOf(provider, { fileId: target.fileId, driveId: target.driveId, path: target.path })
        : reading.fileRefOf(provider, { fileId: source.file && source.file.id, driveId: source.file && source.file.driveId, path: source.file && source.file.path });
    const probe = await ctx.api.probe(ref);
    if (!probe.format) {
        throw rejected(415, 'format_unsupported', `"${probe.name}" is not a spreadsheet Bee Flow can read.`, { ref: wireRef(provider, ref) });
    }
    const viaCells = await reading.cellsAvailable(ctx.api, probe);
    let sheet = source.sheet || { id: null, name: null, index: 0 };
    if (target || (body && body.sheet !== undefined)) {
        const tabs = await reading.listSheetsOf(ctx.api, probe, { viaCells });
        const wanted = body && body.sheet !== undefined && body.sheet !== null ? body.sheet : (target ? null : sheet.name);
        const chosen = pickTab(tabs, wanted, probe.format, ref);
        sheet = { id: chosen.id ?? null, name: chosen.name || null, index: Number.isInteger(chosen.index) ? chosen.index : 0 };
    }
    // The opt-in is per file AND per linker: kept only when the same account
    // re-reads the same file; otherwise the caller ticks it again.
    const keptOptIn = !target
        && principal.userId === source.linkedByUserId
        && !!(source.write && source.write.sharedOptIn);
    const write = reading.writeModeFor({
        provider, format: probe.format, owned: probe.owned, writable: probe.writable,
        workbook: viaCells && probe.format !== 'gsheet',
        sharedOptIn: keptOptIn || (body && body.sharedWriteOptIn === true),
    });
    const d = deps();
    const org = principal.orgId ? await d.userStore.getOrganization(principal.orgId).catch(() => null) : null;
    const ncInstanceId = provider === 'nextcloud_files'
        ? (org ? (org.nc_instance_id || org.ncInstanceId || source.ncInstanceId || null) : (source.ncInstanceId || null))
        : null;
    const repointed = !!target || (sheet.name || null) !== ((source.sheet && source.sheet.name) || null);
    const updated = await datatableStore.setSource(datatable.id, datatable.scope, {
        ...source,
        provider,
        format: probe.format,
        file: {
            id: probe.file.fileId || null,
            driveId: probe.file.driveId || null,
            path: probe.path || probe.file.path || null,
            name: probe.name || null,
            webUrl: probe.webUrl || null,
        },
        sheet,
        owned: !!probe.owned,
        write,
        ncInstanceId,
        // A re-pointed mirror keeps its columns and identity by header hash;
        // a csv sniff belongs to the file it came from.
        ...(repointed && probe.format !== 'csv' ? { csv: null } : {}),
        linkedByUserId: principal.userId,
        linkedAt: new Date().toISOString(),
    });
    require('./linkerAuth').forget(source.linkedByUserId);
    if (principal.userId !== source.linkedByUserId) require('./linkerAuth').forget(principal.userId);
    await datatableStore.markSourceStale(datatable.id, 'relink');
    return updated;
}

/**
 * PUT /:id/source — the settings a spreadsheet mirror has: `refreshOnView`,
 * `headerRow`, `keyColumn` (a 0-based col, or null for row numbers) and
 * `columns: { [fieldId]: { type } }` (a retype). Anything that changes what
 * the copy holds marks it stale ('columns'); the pass then re-reads the
 * file and reconciles — a retype is DROP+ADD under the same key, a new key
 * column replaces every row id.
 *
 * A NEW key column is checked unique over a fresh read before it is
 * accepted — the same check the link runs (planTable), for the same reason:
 * the pass assigns ids first-occurrence-wins and drops the rest from the
 * copy with nothing but a warning, so a repeated or blank key would lose
 * rows silently. The read runs as the LINKER (what the pass will read;
 * an owner changing a setting need not hold a credential for the storage
 * at all), through the download cache. `ctx.api` lets a caller that
 * already holds a client hand it in; `ctx.orgId` is the table's org.
 * @returns {Promise<{ next:object, stale:false|string }>}
 */
async function applySettings(source, body, ctx = {}) {
    const b = body || {};
    for (const k of Object.keys(b)) {
        if (!['refreshOnView', 'headerRow', 'keyColumn', 'columns'].includes(k)) {
            throw rejected(400, 'unknown_field', `"${k}" is not a setting of a spreadsheet table`);
        }
    }
    const next = { ...source, columnMap: { ...((source && source.columnMap) || {}) } };
    let stale = false;
    if (b.refreshOnView !== undefined) next.refreshOnView = b.refreshOnView !== false;
    if (b.headerRow !== undefined) {
        const h = Number(b.headerRow);
        if (!Number.isInteger(h) || h < 1 || h > formats.MAX_HEADER_ROW) {
            throw rejected(400, 'spreadsheet_rejected', `The header row must be between 1 and ${formats.MAX_HEADER_ROW}.`);
        }
        if (h !== (Number(source.headerRow) || 1)) { next.headerRow = h; stale = 'columns'; }
    }
    if (b.columns !== undefined) {
        if (!b.columns || typeof b.columns !== 'object' || Array.isArray(b.columns)) {
            throw rejected(400, 'spreadsheet_rejected', '"columns" maps a field id to { type }.');
        }
        for (const [fieldId, v] of Object.entries(b.columns)) {
            const type = v && typeof v === 'object' ? v.type : v;
            if (!columns.DECLARABLE_TYPES.includes(type)) {
                throw rejected(400, 'spreadsheet_rejected', `A column can be one of ${columns.DECLARABLE_TYPES.join(', ')}.`);
            }
            const entry = next.columnMap[fieldId];
            if (!entry || entry.derived) throw rejected(400, 'unknown_field', `"${fieldId}" is not a column of this table`);
            if (entry.formula) throw rejected(400, 'derived_column', `"${entry.header || fieldId}" holds formulas and keeps the file's type.`);
            if (entry.type === type) continue;
            if (entry.key && !KEY_TYPES.includes(type)) {
                throw rejected(400, 'spreadsheet_rejected', 'The key column must stay a text or number column — pick another key first.');
            }
            const retyped = { ...entry, type };
            if (type !== 'select') delete retyped.options;
            next.columnMap[fieldId] = retyped;
            stale = 'columns';
        }
    }
    if (b.keyColumn !== undefined) {
        const current = identity.identityOf(next);
        const clearKeyFlags = () => {
            for (const [id, e] of Object.entries(next.columnMap)) {
                if (e && e.key) { const { key, ...rest } = e; void key; next.columnMap[id] = rest; }
            }
        };
        if (b.keyColumn === null) {
            if (current.mode !== 'row') {
                clearKeyFlags();
                next.identity = { mode: 'row' };
                stale = 'columns';
            }
        } else {
            const col = Number(b.keyColumn);
            const found = Object.entries(next.columnMap).find(([, e]) => e && !e.derived && e.col === col);
            if (!Number.isInteger(col) || !found) throw rejected(400, 'unknown_field', 'The key column must be one of the sheet\'s columns.');
            const [fieldId, entry] = found;
            if (entry.formula) throw rejected(400, 'derived_column', `"${entry.header || fieldId}" holds formulas and cannot be the key.`);
            if (!KEY_TYPES.includes(entry.type)) throw rejected(400, 'spreadsheet_rejected', 'Only a text or number column can be the key.');
            if (current.mode !== 'key' || current.keyFieldId !== fieldId) {
                await assertKeyUnique(source, next, fieldId, entry, ctx);
                clearKeyFlags();
                next.columnMap[fieldId] = { ...next.columnMap[fieldId], key: true };
                next.identity = { mode: 'key', keyFieldId: fieldId };
                stale = 'columns';
            }
        }
    }
    return { next, stale };
}

/**
 * The key-column check of planTable, over a fresh read of the linked sheet.
 * The column is found in the fresh header by its header hash — a column
 * that moved since the last pass keeps its id, so `col` may be stale, and
 * a renamed header at the old position is another column. Throws 422
 * key_missing when it is gone, 422 key_not_unique (+header, +detail) when
 * it repeats or has blanks.
 */
async function assertKeyUnique(source, next, fieldId, entry, ctx) {
    const api = ctx && ctx.api ? ctx.api : (await require('./linkerAuth').resolveLinker(source, { orgId: (ctx && ctx.orgId) || null })).api;
    const file = source.file || {};
    // `owned` rides along so a refusal names an own OneDrive file bare, as the browser does.
    const ref = { provider: source.provider, fileId: file.id || null, driveId: file.driveId || null, path: file.path || null, name: file.name || null, owned: source.owned === true };
    const probe = await api.probe(ref);
    // The refusal names the sheet the way the link did (a csv has none).
    const sheetName = probe.format === 'csv' ? null : ((source.sheet && source.sheet.name) || null);
    const wire = () => wireRef(source.provider, ref, sheetName);
    if (!probe.format) {
        throw rejected(415, 'format_unsupported', `"${probe.name}" is not a spreadsheet Bee Flow can read.`, { ref: wire() });
    }
    // The road the pass takes: by cells only where the link recorded that
    // the workbook API answers (never asked of Graph again here).
    const viaCells = probe.format === 'gsheet' || (!!api.cells && !!(source.write && source.write.mode === 'graph_workbook'));
    const read = await reading.readSheetOf(api, probe, {
        sheet: sheetName,
        headerRow: next.headerRow || Number(source.headerRow) || 1,
        rowCap: source.rowCap || sync.DEFAULT_ROW_CAP,
        viaCells,
    });
    const described = columns.describeHeader(read.header);
    // By header hash — never by position: a renamed header at the old
    // position is another column (strict column identity, columns.js).
    const kd = (entry.headerHash ? described.find(d => d.headerHash === entry.headerHash) : described.find(d => d.col === entry.col)) || null;
    const name = entry.header || fieldId;
    if (!kd) {
        throw rejected(422, 'key_missing', `"${name}" is no longer a column of the sheet, so it cannot be the key.`, { ref: wire(), header: name });
    }
    // Typed like the pass mints the ids: a number key's spellings are one key.
    const check = identity.checkKeyColumn(read.rows, kd.col, entry.type || 'text');
    if (!check.unique) {
        const why = [];
        if (check.missing) why.push(`${check.missing} rows have no value in it`);
        if (check.duplicate) why.push(`${check.duplicate} rows repeat a value${check.firstDuplicate ? ` ("${String(check.firstDuplicate).slice(0, 40)}")` : ''}`);
        throw rejected(422, 'key_not_unique', `"${kd.name}" cannot be the key: ${why.join(' and ')}.`, {
            ref: wire(), detail: why.join('; '), header: kd.name,
        });
    }
}

/** DELETE /:id: the mirror is gone; forget what was held about the link. */
async function unlinked(table) {
    const source = (table && table.source) || {};
    try { require('./linkerAuth').forget(source.linkedByUserId); } catch (_) { /* memo only */ }
    const file = source.file || {};
    cache.forget(`${source.provider}|${source.provider === 'nextcloud_files' ? (file.path || '') : (file.id || '')}`);
}

module.exports = {
    providers, browse, describe, linkSpreadsheets, setRelations, relink, applySettings, unlinked,
    MAX_TABLES_PER_LINK, MAX_CRUMB_DEPTH, callerApi, resolveDeclared, planTable, writeRef: wireRef,
    // The one storage bucket (see the header): the spreadsheets router mounts
    // it on browse/describe; link and relink spend it through spendStorageBudget.
    storageLimiter, spendStorageBudget,
};
