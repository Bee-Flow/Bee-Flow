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
const { managedKindSpec } = require('../../dataModel/managedTables');
const { assertDatatableQuota } = require('../../datatableLimits');
const linking = require('../mirror/linking');
const { SpreadsheetSourceError } = require('./errors');
const columns = require('./columns');
const reading = require('./reading');
const cache = require('./cache');
const { inferColumns } = require('./infer');
const sync = require('./sync');
const { KIND, PROVIDERS } = require('./index');
const { resolveDeclared } = require('./linkRelations');
const { MAX_CRUMB_DEPTH, deps, rejected, callerApi, linkedIn, browse } = require('./linkBrowse');
const { wireRef } = require('./linkRef');
const { applySettings } = require('./linkSettings');
const { storageLimiter, spendStorageBudget, relink } = require('./linkRelink');
const { clampHeaderRow, cellText, openForCaller, sourceBlock, planTable } = require('./linkPlan');
const { fallback, bestEffort } = require('../../../../utils/bestEffort');

const TAG = '[SpreadsheetFile]';
const MAX_TABLES_PER_LINK = 10;
const PREVIEW_ROWS = 5;

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
        /** @type {{ connected: boolean; reason: string; }} */
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

// ─── describe ───────────────────────────────────────────────────────────

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
    /** @type {string[]} */
    const warnings = [];
    const apis = new Map();
    /**
     * @param {string} provider
     */
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
    const org = principal.orgId ? await d.userStore.getOrganization(principal.orgId).catch((e) => fallback('core/dataEngine/sources/spreadsheetFile/link:linkSpreadsheets', e, null)) : null;
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

/** DELETE /:id: the mirror is gone; forget what was held about the link. */
async function unlinked(table) {
    const source = (table && table.source) || {};
    try { require('./linkerAuth').forget(source.linkedByUserId); } catch (err) { bestEffort('core/dataEngine/sources/spreadsheetFile/link:unlinked', err); /* memo only */ }
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

/** @typedef {import('./credentials').SessionLike & { isAdmin?: boolean }} CallerSession */

/** @typedef {{ userId?: string, orgId?: string|null }} Principal */

/** @typedef {import('../mirror/linking').MirrorScope} Scope */

/** @typedef {Awaited<ReturnType<typeof reading.listSheetsOf>>[number]} Tab */

/** @typedef {Awaited<ReturnType<typeof callerApi>>} CallerCtx */

/**
 * A spreadsheet mirror's `source` block, as sourceBlock writes it.
 * @typedef {{ provider?: string, format?: string, file?: { id?: string, driveId?: string, path?: string, name?: string, webUrl?: string }, sheet?: { id?: string|null, name?: string|null, index?: number }, headerRow?: number, identity?: { mode?: string, keyFieldId?: unknown }, owned?: boolean, write?: { mode?: string, sharedOptIn?: boolean }, ncInstanceId?: string|null, linkedByUserId?: string, rowCap?: number, refreshOnView?: boolean, columnMap?: Record<string, import('./columns').ColumnMapEntry>, [k: string]: unknown }} SheetSource
 */
