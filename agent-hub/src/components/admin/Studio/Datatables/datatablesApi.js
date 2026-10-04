/**
 * Client for `/api/datatables` (see server/routes/datatables.js).
 *
 * Its own module rather than a few more members on useAutomationApi: that hook
 * hard-codes the `/api/automation` prefix, and a datatable is deliberately NOT
 * under that router — routes/automation.routetable.test.js freezes its
 * (method, path) table.
 *
 * NOTHING HERE TAKES SQL, and there is no escape hatch that could grow into
 * one. Every call is a closed descriptor: a table id, a field key from that
 * table's own declared list, a grade from {viewer, editor}. The server rejects
 * a `sql`/`query`/`rawSql` key by name, so a helper that accepted one would be
 * refused at the door — but the point is that no such helper exists to write.
 *
 * Errors carry `.status`, `.code` and `.body`, because the callers need to
 * tell these apart:
 *   404 — no grade at all. The table is not merely closed, it is not
 *         PROBEABLE: the surface must not distinguish "someone else's" from
 *         "deleted", so nothing here retries or explains.
 *   403 — a grade, but too low. Say which, and offer the person the ask.
 *   409 — someone else changed the columns while this editor was open.
 *   402 — sharing is the paid boundary; reading and writing rows never is.
 *
 * A table a Solution stage manages answers 409 `managed_part` to the columns,
 * its settings, its delete and (a reference table's) every row write. That 409
 * is NOT the column-conflict one above: the error then carries `.managed`
 * (the ManagedPartBanner's input, managedPart.fromError) beside the server's
 * own sentence, and a caller tells the two apart by `.managed`, never by the
 * status alone. The table's own `managed` is on the GET: `{ datatable: {
 * managed } }` (managedPart.managedOf reads it).
 */

import { API_BASE, authFetch } from '../../../../utils/helpers';
import { fromError } from '../../../shared/managedPart';

const base = `${API_BASE}/api/datatables`;
const enc = encodeURIComponent;

async function request(url, options = {}) {
    const res = await authFetch(url, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options,
    });
    let body = null;
    try { body = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
        const err = new Error(body?.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = body?.code || null;
        err.body = body;
        const managed = fromError(body);
        if (managed) err.managed = managed;
        throw err;
    }
    return body;
}

export const datatablesApi = {
    /** Every table the caller holds any grade on, each already carrying it. */
    list: () => request(base),
    /** body: { name, key, description, fields?, rowScope?, projectId? } */
    create: (body) => request(base, { method: 'POST', body: JSON.stringify(body) }),
    /**
     * Provision a table whose COLUMNS the platform owns — today only
     * `kind:'http_cache'`, the visible half of "ask this web service once".
     *
     * A separate route from `create`, not a flag on it, because the column list
     * is not the caller's to send: the runner writes those columns by name on a
     * schedule, so they are a contract rather than a starting point.
     *
     * Answers `{datatable, warning}`. The WARNING IS NOT DECORATION and is not
     * paraphrased by the caller — it is the one real reduction against the
     * hidden cache tier (these rows are plain text every colleague with access
     * can read and export), and the server owns that sentence so it stays true
     * when the storage does.
     *
     * body: { kind, name, key, description?, retentionDays?, scope? }
     */
    createManaged: (body) => request(`${base}/managed`, { method: 'POST', body: JSON.stringify(body) }),
    /**
     * "Build it with AI": `{ mode: 'create'|'revise', brief?, note?, current?, allowDestructive? }`
     * → `{ draft: { name, key, description, fields, notes, changes }, mode }`.
     * Nothing is stored — the dialog and the column designer apply the draft
     * to their own unsaved state; `allowDestructive` defaults to false and
     * is the person's explicit say-so that a column may go or change type.
     */
    draft: (body) => request(`${base}/ai/draft`, { method: 'POST', body: JSON.stringify(body) }),
    get: (id) => request(`${base}/${enc(id)}`),
    /**
     * Change what the table IS, never what it holds: name, description,
     * lawful basis, row scope, and the retention pair.
     *
     * The server REFUSES an unknown key by name rather than dropping it
     * (`unknown_field`), so a caller may not send a convenience field and
     * hope — and `retentionDays` non-null insists `retentionField` travels in
     * the SAME request (`retention_field_required`), because a window that
     * silently inherits a default is one submission away from deleting rows
     * on a rule nobody chose. The retention panel therefore always sends both.
     *
     * patch: { name?, description?, lawfulBasis?, rowScope?, retentionDays?,
     *          retentionField?, subjectColumn? }
     */
    update: (id, patch) => request(`${base}/${enc(id)}`, {
        method: 'PATCH', body: JSON.stringify(patch),
    }),
    /**
     * Does the physical table still match the model? Owner-only, and a read:
     * `{ modelVersion, schemaStamp, tableExists, missingColumns, stampBehind,
     *    healthy }`.
     */
    health: (id) => request(`${base}/${enc(id)}/health`),
    /**
     * Re-emit this table's own DDL. Every statement is IF NOT EXISTS and the
     * plan is add-only by construction, so on a healthy table it is a no-op —
     * which is what makes it safe to offer as a menu item rather than as a
     * support procedure. Answers `{ repaired: true, ...health }`.
     */
    repair: (id) => request(`${base}/${enc(id)}/repair`, { method: 'POST' }),
    /**
     * The server refuses (409 `in_use`) when automations still name this table,
     * unless the caller confirms. Pass `{confirmBreaking:true}` only from a
     * surface that has SHOWN the person which automations break — DangerZone lists
     * them and makes you type the table name first. On the query string, not a
     * body: a DELETE with a body is dropped by enough proxies to be a bad place
     * for a confirmation.
     */
    remove: (id, { confirmBreaking = false } = {}) => request(
        `${base}/${enc(id)}${confirmBreaking ? '?confirmBreaking=true' : ''}`, { method: 'DELETE' }),

    // Columns. The read hands back `modelVersion`; send it back on the write
    // and a concurrent edit comes back as a 409 instead of silently winning.
    // `confirmBreaking` answers the OTHER 409 (`breaking_change`): a column a
    // automation still reads. Two different 409 codes, and the caller must tell
    // them apart — one means reload, the other means ask.
    getSchema: (id) => request(`${base}/${enc(id)}/schema`),
    putSchema: (id, fields, expectedVersion, { confirmBreaking = false } = {}) => request(`${base}/${enc(id)}/schema`, {
        method: 'PUT',
        body: JSON.stringify({ fields, expectedVersion, confirmBreaking }),
    }),

    // Rows.
    //
    // `filters`, `sort`, `dir`, `match` and `q` are a CLOSED DESCRIPTOR, not a
    // query language: the server resolves every field key against the table's
    // own declared column list and every operator against the compiler's
    // FILTER_OPS, and it ANDs the access predicate in regardless. There is
    // still no way to express SQL from here, and there never will be.
    //
    // `cursor` is the keyset token the PREVIOUS page returned as `nextCursor`.
    // Not an offset: on a table two automations are writing to, an offset both
    // skips and repeats rows between pages.
    listRows: (id, { limit = 50, cursor = null, filters = null, match = null, sort = null, dir = null, q = null } = {}) => {
        const qs = new URLSearchParams();
        if (limit) qs.set('limit', String(limit));
        if (cursor) qs.set('cursor', cursor);
        if (filters && filters.length) qs.set('filters', JSON.stringify(filters));
        if (match) qs.set('match', match);
        if (sort) qs.set('sort', sort);
        if (dir) qs.set('dir', dir);
        if (q) qs.set('q', q);
        const query = qs.toString();
        return request(`${base}/${enc(id)}/rows${query ? `?${query}` : ''}`);
    },
    getRow: (id, rowId) => request(`${base}/${enc(id)}/rows/${enc(rowId)}`),
    addRow: (id, values) => request(`${base}/${enc(id)}/rows`, {
        method: 'POST', body: JSON.stringify({ values }),
    }),
    /**
     * Edit a row. `expectedUpdatedAt` is the `updated_at` the row was READ
     * with, and it is required: without it two colleagues with the table open
     * silently overwrite each other. A stale one comes back 409 `row_conflict`
     * carrying the row as it now is, so the caller can show what changed.
     */
    updateRow: (id, rowId, values, expectedUpdatedAt) => request(`${base}/${enc(id)}/rows/${enc(rowId)}`, {
        method: 'PUT', body: JSON.stringify({ values, expectedUpdatedAt }),
    }),
    deleteRow: (id, rowId) => request(`${base}/${enc(id)}/rows/${enc(rowId)}`, { method: 'DELETE' }),
    /**
     * Delete up to 200 rows in ONE transaction — the answer to a ticked
     * select-all over a page of rows.
     *
     * Answers `{ deleted, requested }`, and `deleted` is what Postgres
     * actually removed AFTER the access predicate: a `deleted: 0` is a 200,
     * not a 404, because "you may not see those rows" and "those rows are
     * gone" must stay indistinguishable from here. Over the cap it is a 413
     * `{ code: 'too_many_ids', limit, used }` — a number the caller can show,
     * not a truncated delete.
     */
    bulkDeleteRows: (id, ids) => request(`${base}/${enc(id)}/rows/bulk-delete`, {
        method: 'POST', body: JSON.stringify({ ids }),
    }),
    /**
     * Import many rows in ONE request. Answers `{inserted, errors:[{line,
     * error}]}` — a spreadsheet with two bad dates in it is a fixable import,
     * so the bad rows are reported by line rather than failing the whole file.
     */
    bulkImport: (id, rows) => request(`${base}/${enc(id)}/rows/bulk`, {
        method: 'POST', body: JSON.stringify({ rows }),
    }),
    /**
     * The whole table as CSV text, streamed by the server in one response.
     *
     * Fetched rather than linked. An `<a href download>` pointing at the API
     * would carry no auth header, and on this stack a same-origin download link
     * navigates the SPA away from itself — the automations library learned that the
     * hard way. The caller turns the text into a Blob and revokes the URL.
     */
    exportCsv: async (id) => {
        const res = await authFetch(`${base}/${enc(id)}/rows.csv`, { headers: { Accept: 'text/csv' } });
        if (!res.ok) {
            let body = null;
            try { body = await res.json(); } catch { /* not JSON */ }
            const err = new Error(body?.error || `Export failed (${res.status})`);
            err.status = res.status;
            err.code = body?.code || null;
            throw err;
        }
        return res.text();
    },

    // Sharing. One descriptor, never two fields that can disagree:
    //   { audience: 'private' | 'organisation' | 'groups',
    //     sharedGroups: string[],            // required, non-empty, for 'groups'
    //     writeMode: 'grants' | 'audience' }
    // The audience word exists because an empty sharedGroups on a PUBLISHED
    // table means the WHOLE ORG on the server, so the old {isPublished,
    // sharedGroups} pair could spell "share with specific groups" and mean
    // "share with everyone". `audience:'groups'` with an empty list is a 400
    // (`groups_required`), not a silent widening. Write access stays the
    // separate `writeMode` axis: publishing must never be what made a table
    // org-WRITABLE.
    setSharing: (id, descriptor) => request(`${base}/${enc(id)}/sharing`, {
        method: 'PUT', body: JSON.stringify(descriptor),
    }),
    listGrants: (id) => request(`${base}/${enc(id)}/grants`),
    addGrant: (id, grant) => request(`${base}/${enc(id)}/grants`, {
        method: 'POST', body: JSON.stringify(grant),
    }),
    removeGrant: (id, grantId) => request(`${base}/${enc(id)}/grants/${enc(grantId)}`, { method: 'DELETE' }),

    /** Which automations read or write this table — the answer before a delete. */
    listUsage: (id) => request(`${base}/${enc(id)}/usage`),

    // A table that MIRRORS a Nextcloud Tables table (server/core/dataEngine/
    // sources/nextcloudTable). The collection routes live under /nextcloud;
    // the per-table ones beside the other /:id routes.
    //
    // `linkable` answers `{connected, reason?, tables:[{ncTableId, title,
    // emoji, rowsCount, columnsCount, views:[{ncViewId,title,linkedAs}],
    // linkedAs:[datatableId]}]}` — `connected:false` carries the server's
    // reason code, which the dialog turns into a sentence.
    linkable: (scope = null) => request(`${base}/nextcloud/linkable${scope ? `?scope=${enc(scope)}` : ''}`),
    /** The columns a link would arrive with: `{ncTableId, ncViewId, columns:[…]}`. */
    describeNc: ({ ncTableId = null, ncViewId = null, scope = null } = {}) => {
        const qs = new URLSearchParams();
        if (ncViewId) qs.set('ncViewId', String(ncViewId)); else qs.set('ncTableId', String(ncTableId));
        if (scope) qs.set('scope', scope);
        return request(`${base}/nextcloud/describe?${qs}`);
    },
    /**
     * Link one or several tables in one go. Answers `{datatables, warnings,
     * partial}` — the WARNINGS are shown verbatim (the createManaged rule) and
     * the first refresh runs in the background: every table comes back with
     * `sync.status: 'running'` and the detail view polls `get(id)`.
     *
     * body: { scope?, tables:[{ncTableId|ncViewId, name, key, description?}],
     *         relations?:[{from:{ncTableId,ncColumnId}, to:{ncTableId,ncColumnId}}],
     *         schedule?:{everyMinutes} }
     */
    linkNc: (body) => request(`${base}/nextcloud/link`, { method: 'POST', body: JSON.stringify(body) }),
    getNc: (id) => request(`${base}/${enc(id)}/nextcloud`),
    /**
     * The PULSE a client sends while it has a mirror open: `{dataVersion,
     * rowCount, sync}`. Every pulse makes the server re-check Nextcloud (at
     * most once per few seconds), and a `dataVersion` that moved is the
     * signal to reload the rows — that is what makes a mirror live.
     */
    pulseNc: (id) => request(`${base}/${enc(id)}/nextcloud/pulse`),
    /** Refresh now. 200 `{ok, sync, warnings}` or 202 `{alreadyRunning, sync}`. */
    refreshNc: (id) => request(`${base}/${enc(id)}/nextcloud/refresh`, { method: 'POST' }),
    /** Declared relations, replacing the previous list: [{targetDatatableId, localFieldId, targetFieldId}]. */
    setNcRelations: (id, relations) => request(`${base}/${enc(id)}/nextcloud/relations`, {
        method: 'PUT', body: JSON.stringify({ relations }),
    }),
    /** patch: { schedule?:{everyMinutes}, refreshOnView? } */
    updateNc: (id, patch) => request(`${base}/${enc(id)}/nextcloud`, { method: 'PUT', body: JSON.stringify(patch) }),
    relinkNc: (id) => request(`${base}/${enc(id)}/nextcloud/relink`, { method: 'POST' }),

    // A table that MIRRORS one worksheet of a spreadsheet file in Google
    // Drive, OneDrive or Nextcloud Files (server/core/dataEngine/sources/
    // spreadsheetFile). The collection routes live under /spreadsheets, the
    // per-table ones under /:id/source/* — those are kind-AGNOSTIC (the
    // server dispatches on the table's managedKind), and the Nextcloud kind
    // keeps its own /:id/nextcloud/* methods above for one release.
    //
    // `spreadsheetProviders` answers `{providers:[{provider, connected,
    // reason?}]}` for ONLY the storages this account has a credential or
    // binding for — cheap, no call to any provider — so the create dialog can
    // gate its card on one probe. An empty list means no card at all.
    spreadsheetProviders: (scope = null) => request(`${base}/spreadsheets/providers${scope ? `?scope=${enc(scope)}` : ''}`),
    /**
     * One folder of one storage: `{provider, folder:{id,name,path:[…]},
     * items:[{id, name, kind:'folder'|'file', format?, size?, modifiedAt?,
     * webUrl?, path?, owned?, linkedAs?:[{datatableId,sheet}]}], nextPageToken}`.
     * ONE id parameter for every storage: `folderId` is `'root'`, `'shared'`
     * (the shared-with-me root, Drive and OneDrive only) or an id the server
     * handed out — for Nextcloud the id IS the path, and the client never
     * interprets it. Folders and spreadsheet files only.
     */
    browseSpreadsheets: ({ provider, folderId = 'root', q = null, shared = false, pageToken = null, scope = null }) => {
        const qs = new URLSearchParams();
        qs.set('provider', provider);
        if (folderId) qs.set('folderId', folderId);
        if (q) qs.set('q', q);
        if (shared) qs.set('shared', 'true');
        if (pageToken) qs.set('pageToken', pageToken);
        if (scope) qs.set('scope', scope);
        return request(`${base}/spreadsheets/browse?${qs}`);
    },
    /**
     * One file, one sheet, read up to the header row: the sheet list, the
     * columns as they would arrive (types inferred, `col` a 0-BASED integer,
     * `letter` for display only), a five-row preview, which columns could be
     * the key, and how the file can be written back (`write:{mode, reason?,
     * caveats}`). Without `sheet` the first sheet at header row 1.
     */
    describeSpreadsheet: ({ provider, fileId, sheet = null, headerRow = null, scope = null }) => {
        const qs = new URLSearchParams();
        qs.set('provider', provider);
        qs.set('fileId', fileId);
        if (sheet) qs.set('sheet', sheet);
        if (headerRow) qs.set('headerRow', String(headerRow));
        if (scope) qs.set('scope', scope);
        return request(`${base}/spreadsheets/describe?${qs}`);
    },
    /**
     * Link one or several sheets in one go — the spreadsheet twin of `linkNc`,
     * same answer shape `{datatables, warnings, partial}` and the same rule:
     * every table comes back with `sync.status:'running'`.
     *
     * body: { scope, tables:[{ provider, fileId, path?, sheet, headerRow,
     *         keyColumn:int|null, columns:[{col, header, type}],
     *         sharedWriteOptIn?, name, key, description? }] (1..10),
     *         relations:[{ from:{provider,fileId,sheet,col}, to:{…} }] }
     */
    linkSpreadsheets: (body) => request(`${base}/spreadsheets/link`, { method: 'POST', body: JSON.stringify(body) }),

    getSource: (id) => request(`${base}/${enc(id)}/source`),
    /** The pulse, for any kind of mirror: `{dataVersion, rowCount, sync}` (see pulseNc). */
    pulseSource: (id) => request(`${base}/${enc(id)}/source/pulse`),
    refreshSource: (id) => request(`${base}/${enc(id)}/source/refresh`, { method: 'POST' }),
    /**
     * patch: { refreshOnView? } for either kind; a spreadsheet also takes
     * { headerRow?, keyColumn?:int|null, columns?:{[fieldId]:{type}} } — a
     * re-map, which the next refresh applies (a retyped column is a new one).
     */
    updateSource: (id, patch) => request(`${base}/${enc(id)}/source`, { method: 'PUT', body: JSON.stringify(patch) }),
    setSourceRelations: (id, relations) => request(`${base}/${enc(id)}/source/relations`, {
        method: 'PUT', body: JSON.stringify({ relations }),
    }),
    /**
     * Re-read the source's access and columns as the linking account — and,
     * for a spreadsheet, optionally point the table at another file or
     * sheet: body `{ file:{provider, fileId, path?}, sheet? }`.
     */
    relinkSource: (id, body = null) => request(`${base}/${enc(id)}/source/relink`, {
        method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    // ── A form's answers (managed_kind 'form_answers') ────────────────────
    // The dashboard's numbers in one answer, for a period of calendar days.
    answersSummary: (id, { from = null, to = null } = {}) => {
        const q = new URLSearchParams();
        if (from) q.set('from', from);
        if (to) q.set('to', to);
        const qs = q.toString();
        return request(`${base}/${enc(id)}/answers/summary${qs ? `?${qs}` : ''}`);
    },
    // A validated aggregate over any table the caller may read.
    aggregate: (id, body) => request(`${base}/${enc(id)}/aggregate`, { method: 'POST', body: JSON.stringify(body || {}) }),
    // The one DROP a form's table allows: a question no longer on the form.
    removeAnswersColumn: (id, fieldId, { confirmBreaking = false } = {}) =>
        request(`${base}/${enc(id)}/answers/columns/${enc(fieldId)}${confirmBreaking ? '?confirmBreaking=1' : ''}`, { method: 'DELETE' }),
    // Keep the answers, forget the form: an ordinary table from here on.
    releaseAnswers: (id) => request(`${base}/${enc(id)}/answers/release`, { method: 'POST' }),
};

export default datatablesApi;
