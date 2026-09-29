/**
 * LINKING: what can be linked, what a link would look like, and making one.
 *
 * ── TWO IDENTITIES, KEPT APART ──────────────────────────────────────
 * `listLinkable` and `describe` run as the CALLER, on their own request
 * session, through the same scope guard the agent tools use — a table the
 * person cannot reach in chat is not offered here either. `linkTables` records
 * that caller as the mirror's linker (`source.linkedByUserId`), and from then
 * on every refresh runs as them (linkerAuth.js).
 *
 * ── ALL TABLES FIRST, THEN ALL COLUMNS ──────────────────────────────
 * A Nextcloud relation column points at another Nextcloud table by id. When
 * two tables are linked in one call and one points at the other, the columns
 * of the first can only resolve that pointer once the second EXISTS as a
 * mirror — so every table is created (empty, `fields: []`) before any table's
 * columns are derived, and the first refresh is kicked, not awaited. That
 * choreography is every source's and lives in ../mirror/linking; what is
 * Nextcloud's here is the validation, the `source` block, reading the
 * columns as the caller, and turning `{ncTableId, ncColumnId}` pairs into
 * declared relations.
 */

'use strict';

const datatableStore = require('../../../../stores/datatableStore');
const { KEY_RE } = require('../../dataModel/vocabulary');
const { managedKindSpec } = require('../../dataModel/managedTables');
const { assertDatatableQuota } = require('../../datatableLimits');
const linking = require('../mirror/linking');
const { NextcloudSourceError, isNextcloudSourceError } = require('./errors');
const ncApi = require('./ncApi');
const columns = require('./columns');
const sync = require('./sync');
const { KIND } = require('./index');

const TAG = '[NextcloudTable]';

const MAX_TABLES_PER_LINK = 10;

function deps() {
    return {
        ncClient: require('../../../../integrations/nextcloudClient'),
        guardedNcCall: require('../../../integrations/ncScopeGuard').guardedNcCall,
        isNcOrg: require('../../../../auth/ncAudience').isNcOrg,
        isIntegrationPermittedForUser: require('../../../integrations/integrationTools').isIntegrationPermittedForUser,
        userStore: require('../../../../stores/userStore'),
    };
}

/**
 * The caller's own Nextcloud API, after the org/integration gates. Throws a
 * NextcloudSourceError the route answers with.
 */
async function callerApi(session, principal) {
    const d = deps();
    const userId = principal.userId;
    const orgId = principal.orgId || null;
    if (orgId && !await d.isNcOrg(orgId)) {
        throw new NextcloudSourceError(400, 'not_nc_org', 'This organisation is not connected to Nextcloud.');
    }
    if (!orgId) {
        // A personal mirror still needs a Nextcloud-bound account.
        const bound = await d.ncClient.resolveNcBinding(session, userId).catch(() => null);
        if (!bound) throw new NextcloudSourceError(400, 'not_nc_org', 'This account is not connected to Nextcloud.');
    }
    if (!await d.isIntegrationPermittedForUser({ userId, appId: 'nextcloud-tables', session, isAdmin: !!session?.isAdmin })) {
        throw new NextcloudSourceError(403, 'nextcloud_integration_off', 'Nextcloud Tables is switched off for this account.');
    }
    const auth = await d.ncClient.resolveAuth(session, userId);
    if (!auth || !auth.baseUrl || typeof auth.fetch !== 'function') {
        throw new NextcloudSourceError(503, 'nextcloud_unavailable', (auth && auth.authError) || 'No working Nextcloud connection for this account.');
    }
    return { api: ncApi.forLinker(auth), guarded: (tool, args, run) => d.guardedNcCall(tool, args, { userId, session, orgId }, run), d };
}

/** A structured scope denial from the guard → the error the route answers. */
function denialToError(res, ncTableId = null) {
    if (res && res.nc_scope_denied) {
        return new NextcloudSourceError(403, 'nc_scope_denied', 'This account does not share that Nextcloud table with Bee Flow.', { ncTableId });
    }
    return null;
}

/**
 * Every Nextcloud table the caller can see (and its views), with which
 * mirrors in `scope` already copy it.
 * @returns {Promise<{ connected:boolean, reason?:string, tables:Array }>}
 */
async function listLinkable(session, principal, scope) {
    let ctx;
    try {
        ctx = await callerApi(session, principal);
    } catch (e) {
        if (isNextcloudSourceError(e)) return { connected: false, reason: e.code, tables: [] };
        throw e;
    }
    const res = await ctx.guarded('nextcloud_tables_list', {}, async () => ({ tables: await ctx.api.listTables() }));
    const denied = denialToError(res);
    if (denied) return { connected: false, reason: denied.code, tables: [] };
    if (res && res.error) return { connected: false, reason: 'nextcloud_unavailable', tables: [] };

    const mirrors = scope ? await datatableStore.listSourceMirrorsInScope(scope, { kind: KIND }) : [];
    const linkedByTable = new Map();
    const linkedByView = new Map();
    for (const m of mirrors) {
        const s = m.source || {};
        if (s.ncViewId) linkedByView.set(Number(s.ncViewId), [...(linkedByView.get(Number(s.ncViewId)) || []), m.id]);
        else if (s.ncTableId) linkedByTable.set(Number(s.ncTableId), [...(linkedByTable.get(Number(s.ncTableId)) || []), m.id]);
    }
    const tables = (res.tables || []).filter(t => t && !t.archived).map(t => ({
        ncTableId: t.id,
        title: t.title,
        emoji: t.emoji || null,
        rowsCount: t.rowsCount ?? null,
        columnsCount: t.columnsCount ?? null,
        isShared: !!t.isShared,
        linkedAs: linkedByTable.get(Number(t.id)) || [],
        views: (Array.isArray(t.views) ? t.views : []).map(v => ({
            ncViewId: v.id, title: v.title, linkedAs: linkedByView.get(Number(v.id)) || [],
        })),
    }));
    return { connected: true, tables };
}

/**
 * What linking `ref` ({ncTableId} or {ncViewId}) would produce: the columns,
 * how each maps, and where its relations point.
 */
async function describe(session, principal, scope, ref) {
    const ctx = await callerApi(session, principal);
    const tableId = await resolveTableId(ctx.api, ref);
    const probe = await ctx.guarded('nextcloud_tables_list_columns', { tableId }, async () => ({ ok: true }));
    const denied = denialToError(probe, tableId);
    if (denied) throw denied;
    const ncColumns = await ctx.api.getColumns(ref.ncViewId ? { viewId: ref.ncViewId, tableId } : { tableId });
    const siblings = scope ? await sync.siblingsOf(scope) : { linkedTargets: new Map(), linkedViews: new Map(), byId: new Map() };
    return {
        ncTableId: tableId,
        ncViewId: ref.ncViewId || null,
        columns: ncColumns.map((c) => {
            const relation = c.type === 'relation' ? relationTargetOf(c) : null;
            return {
                ncColumnId: c.id,
                title: c.title,
                type: c.type,
                subtype: c.subtype || '',
                mandatory: !!c.mandatory,
                mappedType: c.type === 'relation'
                    ? (relation && ((relation.relationType === 'view' ? siblings.linkedViews : siblings.linkedTargets).get(relation.targetId)) ? 'relation' : 'number')
                    : columns.mirrorTypeFor(c.type, c.subtype),
                options: (c.selectionOptions || []).map(o => o.label),
                relationTarget: relation,
            };
        }),
    };
}

function relationTargetOf(c) {
    const cs = c.customSettings || {};
    const targetId = Number(cs.targetId);
    if (!Number.isInteger(targetId)) return null;
    return {
        relationType: cs.relationType === 'view' ? 'view' : 'table',
        ncTableId: cs.relationType === 'view' ? null : targetId,
        ncViewId: cs.relationType === 'view' ? targetId : null,
        targetId,
        labelColumn: Number(cs.labelColumn) || null,
    };
}

/** A view's parent table id, or the table id itself. */
async function resolveTableId(api, ref) {
    if (ref.ncViewId) {
        const view = await api.getView(ref.ncViewId);
        const tableId = Number(view && view.tableId);
        if (!Number.isInteger(tableId)) throw new NextcloudSourceError(404, 'nextcloud_not_found', 'Nextcloud does not have that view.');
        return tableId;
    }
    const tableId = Number(ref.ncTableId);
    if (!Number.isInteger(tableId) || tableId <= 0) throw new NextcloudSourceError(400, 'nextcloud_rejected', 'A Nextcloud table id is required.');
    return tableId;
}

function slugKey(title) {
    return columns.keyFromTitle(title, 0, new Set());
}

/**
 * Link one or more Nextcloud tables/views as mirrors in `scope`.
 *
 * @param {object} args
 * @param {{kind,id}} args.scope
 * @param {object} args.principal   resolveDatatablePrincipal's answer (userId, orgId)
 * @param {object} args.session     the caller's request session
 * @param {Array}  args.tables      [{ ncTableId?, ncViewId?, name?, key?, description? }]
 * @param {Array}  [args.relations] [{ from:{ncTableId, ncColumnId}, to:{ncTableId, ncColumnId} }]
 * @param {object} [args.schedule]  { everyMinutes }
 * @returns {Promise<{ datatables:Array, warnings:string[], partial:boolean }>}
 */
async function linkTables({ scope, principal, session, tables, relations = [], schedule = null }) {
    if (!Array.isArray(tables) || !tables.length) {
        throw new NextcloudSourceError(400, 'nextcloud_rejected', 'Choose at least one table to link.');
    }
    if (tables.length > MAX_TABLES_PER_LINK) {
        throw new NextcloudSourceError(400, 'nextcloud_rejected', `At most ${MAX_TABLES_PER_LINK} tables can be linked at once.`);
    }
    // `schedule` is accepted for compatibility and ignored: a mirror is live
    // (sync.scheduleOf says why there is nothing to choose).
    void schedule;
    const wantedSchedule = sync.scheduleOf();

    const ctx = await callerApi(session, principal);
    const org = principal.orgId ? await ctx.d.userStore.getOrganization(principal.orgId).catch(() => null) : null;
    const ncInstanceId = org ? (org.nc_instance_id || org.ncInstanceId || null) : null;
    // For the deep link back into Nextcloud's Tables app — informational, never
    // used for an outbound call (those go through the connector).
    const ncBaseUrl = org ? (org.nc_base_url || org.ncBaseUrl || null) : null;
    const spec = managedKindSpec(KIND);
    const existing = await datatableStore.listSourceMirrorsInScope(scope, { kind: KIND });
    const warnings = [];

    // ── validate and resolve every requested table BEFORE creating any ──
    const plans = [];
    const seenRefs = new Set();
    for (const t of tables) {
        const ref = t.ncViewId ? { ncViewId: Number(t.ncViewId) } : { ncTableId: Number(t.ncTableId) };
        const refKey = ref.ncViewId ? `v:${ref.ncViewId}` : `t:${ref.ncTableId}`;
        if (seenRefs.has(refKey)) throw new NextcloudSourceError(400, 'nextcloud_rejected', 'The same table is listed twice.');
        seenRefs.add(refKey);
        const already = existing.find(m => (ref.ncViewId ? Number(m.source?.ncViewId) === ref.ncViewId
            : (!m.source?.ncViewId && Number(m.source?.ncTableId) === ref.ncTableId)));
        if (already) {
            const e = new NextcloudSourceError(409, 'already_linked', `"${already.name}" already mirrors that Nextcloud table.`, { ncTableId: already.source.ncTableId });
            e.datatableId = already.id;
            throw e;
        }
        const tableId = await resolveTableId(ctx.api, ref);
        const probe = await ctx.guarded('nextcloud_tables_list_rows', { tableId }, async () => ({ ok: true }));
        const denied = denialToError(probe, tableId);
        if (denied) throw denied;
        const ncTable = await ctx.api.getTable(tableId);
        const ncView = ref.ncViewId ? await ctx.api.getView(ref.ncViewId) : null;
        const title = (ncView && ncView.title) || (ncTable && ncTable.title) || `Table ${tableId}`;
        const name = String(t.name || title).trim().slice(0, 120) || title;
        const key = String(t.key || slugKey(name)).trim();
        if (!KEY_RE.test(key)) {
            throw new NextcloudSourceError(400, 'nextcloud_rejected', `"${key}" is not a valid technical name — lowercase letters, numbers and underscores, starting with a letter.`);
        }
        const description = String(t.description ?? spec.defaultDescription).trim() || spec.defaultDescription;
        plans.push({
            ref, tableId, viewId: ref.ncViewId || null, name, key, description,
            ncTitle: ncTable && ncTable.title, ncEmoji: (ncTable && ncTable.emoji) || null,
        });
    }
    const keys = plans.map(p => p.key);
    if (new Set(keys).size !== keys.length) {
        throw new NextcloudSourceError(400, 'nextcloud_rejected', 'Two tables would get the same technical name.');
    }
    await assertDatatableQuota(scope, { addTables: plans.length });

    // ── create every table, empty ───────────────────────────────────
    const made = await linking.createEmptyMirrors({
        scope, principal, KIND, plans,
        sourceFor: (p) => ({
            kind: KIND,
            ncInstanceId,
            ncBaseUrl,
            ncTableId: p.tableId,
            ncViewId: p.viewId,
            ncTitle: p.ncTitle,
            ncEmoji: p.ncEmoji,
            linkedByUserId: principal.userId,
            linkedAt: new Date().toISOString(),
            schedule: wantedSchedule,
            refreshOnView: true,
            rowCap: sync.DEFAULT_ROW_CAP,
            columnMap: {},
            relations: [],
        }),
    });
    const { created } = made;
    let partial = made.partial;
    warnings.push(...made.warnings);

    // ── then derive every table's columns, siblings included ────────
    const siblings = await sync.siblingsOf(scope);
    // Columns first, for every table, so a declared relation can name its
    // fields by their REAL ids (the id carries the type code — a match on a
    // number column is not a match on a text one).
    const ncColumnsByTable = new Map();
    for (const { plan, table } of created) {
        try {
            const ncColumns = await ctx.api.getColumns(plan.viewId ? { viewId: plan.viewId, tableId: plan.tableId } : { tableId: plan.tableId });
            ncColumnsByTable.set(table.id, ncColumns);
            table._ncColumnTypes = Object.fromEntries(ncColumns.map(c => [c.id, columns.mirrorTypeFor(c.type, c.subtype)]));
        } catch (e) {
            partial = true;
            warnings.push(`"${plan.name}" was linked but its columns could not be read: ${e && e.message}`);
        }
    }
    const declared = resolveDeclared(relations, created, siblings);
    warnings.push(...declared.warnings);
    const stored = await linking.storeDerived(scope, created, (plan, table) => {
        const ncColumns = ncColumnsByTable.get(table.id);
        if (!ncColumns) return null;
        return columns.fieldsFromNcColumns(ncColumns, {
            existingFields: [],
            linkedTargets: siblings.linkedTargets,
            linkedViews: siblings.linkedViews,
            declaredRelations: declared.byTable.get(table.id) || [],
        });
    });
    partial = partial || stored.partial;
    warnings.push(...stored.warnings);

    // ── kick the first refresh, targets before the mirrors that point at them ──
    const finals = await linking.kickFirstSyncs(scope, stored.tables, sync.syncRows, TAG);
    return { datatables: finals, warnings, partial };
}

/**
 * Turn the request's Nextcloud-native relation triples into per-mirror
 * declared relations (columns.js shape). A side that names a table not in
 * this call or this scope is a warning, not a failure.
 */
function resolveDeclared(relations, created, siblings) {
    const byTable = new Map();
    const warnings = [];
    const mirrorByNcTable = new Map();
    for (const m of siblings.byId.values()) {
        if (m.source && !m.source.ncViewId && m.source.ncTableId) mirrorByNcTable.set(Number(m.source.ncTableId), m);
    }
    for (const { table } of created) {
        if (table.source && !table.source.ncViewId) mirrorByNcTable.set(Number(table.source.ncTableId), table);
    }
    for (const rel of Array.isArray(relations) ? relations : []) {
        const from = rel && rel.from, to = rel && rel.to;
        if (!from || !to || !from.ncTableId || !to.ncTableId || !from.ncColumnId || !to.ncColumnId) {
            warnings.push('A relation was skipped because it does not name both tables and both columns.');
            continue;
        }
        const fromMirror = mirrorByNcTable.get(Number(from.ncTableId));
        const toMirror = mirrorByNcTable.get(Number(to.ncTableId));
        if (!fromMirror || !toMirror) {
            warnings.push(`A relation was skipped because one of its tables (${from.ncTableId} → ${to.ncTableId}) is not linked here.`);
            continue;
        }
        // Field ids are derived from column ids, so they can be named before
        // the columns are read — the type code still has to be guessed from
        // the target column, which the sync verifies on its first pass.
        const localFieldId = guessFieldId(fromMirror, from.ncColumnId);
        const targetFieldId = guessFieldId(toMirror, to.ncColumnId);
        if (!localFieldId || !targetFieldId) {
            warnings.push('A relation was skipped because one of its columns could not be identified.');
            continue;
        }
        const list = byTable.get(fromMirror.id) || [];
        list.push({
            targetDatatableId: toMirror.id, targetKey: toMirror.key, targetName: toMirror.name,
            localFieldId, targetFieldId,
        });
        byTable.set(fromMirror.id, list);
    }
    return { byTable, warnings };
}

/**
 * The mirror field for a Nextcloud column id — from the columnMap when the
 * mirror has one, else by asking columns.js for the id a text column would
 * get (the common case for a match key). Returns null when unknowable.
 */
function guessFieldId(mirror, ncColumnId) {
    for (const [fieldId, entry] of Object.entries((mirror.source && mirror.source.columnMap) || {})) {
        if (entry && !entry.derived && Number(entry.ncColumnId) === Number(ncColumnId)) return fieldId;
    }
    const type = mirror._ncColumnTypes && mirror._ncColumnTypes[ncColumnId];
    if (!type) return null;
    // A match on a relation column makes no sense (its value is a row id of
    // yet another table); the sync would refuse it, so refuse it here.
    if (type === 'relation') return null;
    return columns.fieldIdFor(ncColumnId, type);
}

/** Mirrors whose relations point at other mirrors in the list go AFTER them. */
const { orderParentsFirst } = linking;

/**
 * Replace a mirror's DECLARED relations. The nc ones are derived and ride
 * along untouched; the next refresh recomputes everything.
 * @param {Array} relations  [{ targetDatatableId, localFieldId, targetFieldId }]
 */
function setRelations(datatable, relations) {
    return linking.setRelations(datatable, relations, {
        siblingsOf: sync.siblingsOf,
        matchFieldIdFor: columns.matchFieldIdFor,
        Err: NextcloudSourceError,
        rejectedCode: 'nextcloud_rejected',
    });
}

/** Make the caller the mirror's linker, after proving they can reach the table. */
async function relink(datatable, principal, session) {
    const ctx = await callerApi(session, principal);
    const tableId = Number(datatable.source && datatable.source.ncTableId);
    const probe = await ctx.guarded('nextcloud_tables_list_rows', { tableId }, async () => ({ ok: true }));
    const denied = denialToError(probe, tableId);
    if (denied) throw denied;
    await ctx.api.getTable(tableId);
    const org = principal.orgId ? await ctx.d.userStore.getOrganization(principal.orgId).catch(() => null) : null;
    const updated = await datatableStore.setSource(datatable.id, datatable.scope, {
        ...datatable.source,
        linkedByUserId: principal.userId,
        linkedAt: new Date().toISOString(),
        ncInstanceId: org ? (org.nc_instance_id || org.ncInstanceId || datatable.source.ncInstanceId || null) : datatable.source.ncInstanceId,
    });
    require('./linkerAuth').forget(datatable.source.linkedByUserId);
    await datatableStore.markSourceStale(datatable.id, 'relink');
    return updated;
}

module.exports = { listLinkable, describe, linkTables, setRelations, relink, MAX_TABLES_PER_LINK, orderParentsFirst, resolveDeclared };
