// @typecheck
'use strict';
/**
 * Datatable rows over the Bee Flow MCP server (routes/mcpServer.js).
 *
 *   datatables_list          the tables this token's user may see
 *   datatables_get_schema    one table's columns: type, required, unique, options
 *   datatables_query_rows    a page of rows (filters, sort, search, cursor)
 *   datatables_insert_rows   add rows, one result per row
 *   datatables_update_rows   change rows by id with a patch, one result per row
 *
 * No second implementation of the product: the table is resolved by the same
 * function a datatable step uses (core/automationRunner/datatableResolve),
 * which looks it up in the caller's own scopes only and recomputes the grade
 * from the table and its grants on every call. The rows go through the same
 * query compiler and access filter as the web routes (routes/datatables/), the
 * column types through the same cell normaliser as an automation step, the
 * storage envelope through the same quota check, and the list descriptor
 * (filters, sort, search) through routes/datatables/rowDescriptor. There is no
 * SQL in here. Delete is not offered.
 *
 * ── PER-ROW RESULTS ─────────────────────────────────────────────────────────
 * Every row is validated BEFORE anything is written, and every row is answered:
 * `{ index, ok: true, id }` or `{ index, ok: false, error }`. A bad row never
 * stops the good ones, and a good row is never reported as written when it
 * was not. A refusal that concerns the whole call (no access, a full table, too
 * many rows) writes nothing and says so.
 *
 * ── CAPS (environment variables; a generous default, 0 = unlimited) ─────────
 *   MCP_DATATABLE_ROWS_MAX              rows per insert / update call            (100)
 *   MCP_DATATABLE_PAYLOAD_MAX_BYTES     JSON size of one call's arguments        (1048576)
 *   MCP_DATATABLE_QUERY_MAX             rows per datatables_query_rows page      (200)
 *   MCP_DATATABLE_ROWS_PER_MINUTE_TOKEN rows written per token per minute        (1000)
 *   MCP_DATATABLE_ROWS_PER_MINUTE_USER  rows written per user per minute, over
 *                                       all of that user's tokens                (3000)
 * The rate limits charge one unit PER ROW, on top of the gate's per-message
 * charge, so a batch of 100 rows costs 100.
 *
 * ── PRIVACY ─────────────────────────────────────────────────────────────────
 * Rows can hold personal data. Nothing here logs a cell, a row or a filter
 * value: the log has table ids and counts. A database error is never echoed
 * (a unique violation quotes the value); the row gets a fixed sentence.
 */

const log = require('../telemetry/log');
const {
    DATATABLE_TOOLS, DATATABLE_TOOL_NAMES, WRITE_TOOL_NAMES, caps, envCount,
    DEFAULT_QUERY_PAGE, LIST_MAX_TABLES, MAX_ID_CHARS,
} = require('./mcpDatatableToolDefs');
const {
    ToolRefusal, isPlainObject, jsonBytes, rowFailure, tableIdOf, asRefusal, checkValues,
} = require('./mcpDatatableRows');

/** The caller's identity in the shape the datatable resolver reads. */
async function ctxFor(deps, userId) {
    const p = await deps.principalFor(userId);
    return {
        userId,
        orgId: p.orgId || null,
        userHomeOrgId: p.organizationId || null,
        orgRole: p.orgRole || null,
        userGroupIds: p.groupIds || [],
        identityError: p.identityError || null,
    };
}

// ── The tool set ────────────────────────────────────────────────────────────

/**
 * Collaborators are loaded on first use, so importing this file in a unit test
 * stands up nothing; tests pass their own through `overrides`.
 *
 * @param {Record<string, any>} [overrides]
 */
function makeDatatableTools(overrides = {}) {
    // Each module is required where it is first used (a getter), so a unit test
    // that supplies its own collaborators never loads the database layer.
    const stores = {
        get datatableStore() { return require('../stores/datatableStore'); },
        get datatableDbStore() { return require('../stores/datatableDbStore'); },
        get queryCompiler() { return require('../core/dataEngine/queryCompiler'); },
        get accessFilter() { return require('../core/dataEngine/accessFilter'); },
        get access() { return require('../auth/datatableAccess'); },
        get sources() { return require('../core/dataEngine/sources'); },
        get engine() { return require('./datatables/engine'); },
        get descriptor() { return require('./datatables/rowDescriptor'); },
        get resolver() { return require('../core/automationRunner/datatableResolve'); },
        get cells() { return require('../core/automationRunner/datatableCells'); },
        get quota() { return require('../core/dataEngine/datatableLimits'); },
        get vocabulary() { return require('../core/dataEngine/dataModel/vocabulary'); },
        get gate() { return require('../auth/mcpAccess/gate'); },
    };

    const deps = {
        get systemColumns() { return overrides.systemColumns || stores.vocabulary.SYSTEM_COLUMNS; },
        principalFor: overrides.principalFor || ((userId) => stores.access.resolveDatatablePrincipalForUser(userId)),
        resolve: overrides.resolve || ((id, ctx, opts) => stores.resolver.resolveDatatableForStep(id, ctx, opts)),
        normaliseCells: overrides.normaliseCells || ((meta, v) => stores.cells.normaliseCells(meta, v)),
        isMirror: overrides.isMirror || ((table) => stores.sources.isSourceMirror(table)),
        assertQuota: overrides.assertQuota || ((scope, opts) => stores.quota.assertDatatableQuota(scope, opts)),
        exec: overrides.exec || ((key, sql, params) => stores.datatableDbStore.exec(key, key, sql, params)),
        query: overrides.query || ((key, sql, params) => stores.datatableDbStore.query(key, key, sql, params)),
        bump: overrides.bump || ((id, scope, delta) => stores.datatableStore.bumpAfterWrite(id, scope, delta)),
        listForScope: overrides.listForScope || ((scope) => stores.datatableStore.listDatatablesForScope(scope)),
        listGrants: overrides.listGrants || ((id) => stores.datatableStore.listGrants(id)),
        getTableMeta: overrides.getTableMeta || ((scope, id) => stores.datatableStore.getTableMeta(scope, id)),
        // One unit of the budget per row, against the token and against the user.
        charge: overrides.charge || ((kind, key, cost, max) => stores.gate.checkLimiter({ name: kind, max }, key, cost)),
    };
    const lib = () => stores;

    /** Charge `rows` units to the token and to the user. 0 = unlimited. */
    async function chargeRows(ctx, rows) {
        const c = caps();
        const tokenKey = ctx.tokenId || `legacy:${ctx.userId}`;
        if (c.perToken > 0) {
            const r = await deps.charge('mcp-dt-rows-token', tokenKey, rows, c.perToken);
            if (!r.ok) throw new ToolRefusal('Too many rows written for this token this minute. Wait and send fewer rows per minute.', 'rate_limited', { retryAfter: r.retryAfter });
        }
        if (c.perUser > 0) {
            const r = await deps.charge('mcp-dt-rows-user', `user:${ctx.userId}`, rows, c.perUser);
            if (!r.ok) throw new ToolRefusal('Too many rows written for this account this minute (all tokens together). Wait and send fewer rows per minute.', 'rate_limited', { retryAfter: r.retryAfter });
        }
    }

    function checkPayload(args, countName, list) {
        const c = caps();
        if (!Array.isArray(list)) throw new ToolRefusal(`${countName} must be a list.`, 'invalid_arguments');
        if (c.rows > 0 && list.length > c.rows) {
            throw new ToolRefusal(`At most ${c.rows} ${countName} per call; send ${list.length} in several calls.`, 'too_many_rows', { limit: c.rows, used: list.length });
        }
        if (c.payload > 0 && jsonBytes(args) > c.payload) {
            throw new ToolRefusal(`The call is larger than ${c.payload} bytes; send fewer rows.`, 'payload_too_large', { limit: c.payload });
        }
    }

    /** The writable table at editor grade, resolved fresh now. */
    async function writableTable(ctx, datatableId) {
        let r;
        try {
            r = await deps.resolve(tableIdOf(datatableId), await ctxFor(deps, ctx.userId), { needed: 'editor', requireColumns: true });
        } catch (e) {
            throw asRefusal(e) || e;
        }
        if (deps.isMirror(r.table)) {
            throw new ToolRefusal('This table mirrors an external source; it cannot be written over MCP.', 'linked_table');
        }
        try {
            lib().accessFilter.assertCanWrite(r.tableMeta, r.grade, 'create');
            lib().queryCompiler.assertRowsWritable(r.tableMeta);
        } catch (e) {
            throw asRefusal(e) || new ToolRefusal(String(e.message || 'This table cannot be written.').slice(0, 300), e.code === 'managed_part' ? 'managed_part' : 'datatable_not_available');
        }
        return r;
    }

    // ── datatables_list ────────────────────────────────────────────────────
    async function list(ctx) {
        const principal = await deps.principalFor(ctx.userId);
        const access = lib().access;
        const out = [];
        for (const scope of access.datatableScopesFor(principal)) {
            if (scope.kind === 'org' && principal.identityError) continue; // cannot be decided: show nothing
            for (const table of await deps.listForScope(scope)) {
                const grade = access.gradeForPrincipal(table, await deps.listGrants(table.id), principal);
                if (!grade) continue;
                out.push({
                    id: table.id,
                    name: table.name,
                    key: table.key,
                    description: table.description || '',
                    scope: scope.kind === 'org' ? 'organisation' : 'personal',
                    access: grade,
                    canWrite: access.gradeAtLeast(grade, 'editor') && !deps.isMirror(table),
                    rowCount: table.rowCount ?? null,
                });
                if (out.length >= LIST_MAX_TABLES) return { datatables: out, truncated: true };
            }
        }
        return { datatables: out };
    }

    // ── datatables_get_schema ──────────────────────────────────────────────
    async function getSchema(ctx, args) {
        let r;
        try {
            r = await deps.resolve(tableIdOf(args.datatableId), await ctxFor(deps, ctx.userId), { needed: 'viewer', requireColumns: true });
        } catch (e) {
            throw asRefusal(e) || e;
        }
        const access = lib().access;
        const mirror = deps.isMirror(r.table);
        const locked = r.tableMeta.rowsLocked === true;
        return {
            id: r.table.id,
            name: r.table.name,
            access: r.grade,
            canWrite: access.gradeAtLeast(r.grade, 'editor') && !mirror && !locked,
            ...(mirror ? { linkedSource: true } : {}),
            ...(locked ? { rowsLocked: true } : {}),
            columns: (r.tableMeta.fields || []).filter((f) => f && f.key).map((f) => ({
                key: f.key,
                name: f.name || f.key,
                type: f.type,
                required: f.required === true,
                unique: f.unique === true,
                ...(Array.isArray(f.options) && f.options.length ? { options: f.options } : {}),
                ...(f.type === 'computed' ? { computed: true } : {}),
            })),
            systemColumns: [...deps.systemColumns],
        };
    }

    // ── datatables_query_rows ──────────────────────────────────────────────
    async function queryRows(ctx, args) {
        let r;
        try {
            r = await deps.resolve(tableIdOf(args.datatableId), await ctxFor(deps, ctx.userId), { needed: 'viewer', requireColumns: true });
        } catch (e) {
            throw asRefusal(e) || e;
        }
        const L = lib();
        const c = caps();
        const pageMax = c.query > 0 ? Math.min(c.query, L.engine.ROWS_PAGE_MAX) : L.engine.ROWS_PAGE_MAX;
        const wanted = args.limit === undefined ? DEFAULT_QUERY_PAGE : Number(args.limit);
        if (!Number.isInteger(wanted) || wanted < 1) throw new ToolRefusal('limit is a whole number of rows, 1 or more.', 'invalid_arguments');
        const limit = Math.min(wanted, pageMax);
        let descriptor;
        try {
            descriptor = L.descriptor.readListDescriptor(r.tableMeta, {
                filters: args.filters, match: args.match, sort: args.sort, dir: args.dir, q: args.q,
            });
        } catch (e) {
            if (e && e.status === 400) throw new ToolRefusal(String(e.message).slice(0, 300), e.code || 'invalid_arguments');
            throw e;
        }
        const filter = L.accessFilter.compileAccessFilter(r.tableMeta, r.grade, { id: ctx.userId }, 'read', L.engine.PG);
        let compiled;
        try {
            compiled = L.queryCompiler.compileRecordList(r.tableMeta, {
                ...descriptor, limit, maxLimit: pageMax,
                cursor: typeof args.cursor === 'string' && args.cursor ? args.cursor : null, dialect: 'pg',
            }, filter);
        } catch (e) {
            if (e && e.name === 'CompileError') throw new ToolRefusal(String(e.message).slice(0, 300), 'invalid_arguments');
            throw e;
        }
        const out = await deps.query(r.scopeKey, compiled.sql, compiled.params);
        const all = out.rows || [];
        const rows = all.slice(0, compiled.limit);
        const hasMore = all.length > compiled.limit;
        const last = rows[rows.length - 1];
        log.info(`[mcp-datatables] query table=${r.table.id} user=${ctx.userId} rows=${rows.length}`);
        return {
            rows, count: rows.length, hasMore,
            nextCursor: hasMore && last ? L.queryCompiler.encodeCursor(last[compiled.primaryField], last.id) : null,
        };
    }

    // ── datatables_insert_rows ─────────────────────────────────────────────
    async function insertRows(ctx, args) {
        checkPayload(args, 'rows', args.rows);
        const rows = args.rows;
        if (!rows.length) return { inserted: 0, failed: 0, results: [] };
        await chargeRows(ctx, rows.length);
        const r = await writableTable(ctx, args.datatableId);
        const L = lib();

        /** @type {any[]} */
        const results = new Array(rows.length);
        const ready = [];
        rows.forEach((row, index) => {
            const checked = checkValues(deps, r.tableMeta, row);
            if (checked.error) { results[index] = { index, ok: false, error: checked.error }; return; }
            try {
                const ins = L.queryCompiler.compileInsert(r.tableMeta, checked.values, { createdBy: ctx.userId, orgId: r.orgId, dialect: 'pg' });
                ready.push({ index, ins });
            } catch (e) {
                results[index] = { index, ok: false, error: rowFailure(e) };
            }
        });

        if (ready.length) {
            // The storage envelope for the rows that will be written; a full table writes none.
            try {
                await deps.assertQuota(r.scope, { table: r.table, addRows: ready.length });
            } catch (e) {
                throw asRefusal(e) || e;
            }
            let written = 0;
            for (const { index, ins } of ready) {
                try {
                    await deps.exec(r.scopeKey, ins.sql, ins.params);
                    written += 1;
                    results[index] = { index, ok: true, id: ins.id };
                } catch (e) {
                    results[index] = { index, ok: false, error: rowFailure(e) };
                }
            }
            if (written) await deps.bump(r.table.id, r.scope, written);
        }
        const inserted = results.filter((x) => x && x.ok).length;
        log.info(`[mcp-datatables] insert table=${r.table.id} user=${ctx.userId} rows=${rows.length} inserted=${inserted}`);
        return { inserted, failed: rows.length - inserted, results };
    }

    // ── datatables_update_rows ─────────────────────────────────────────────
    async function updateRows(ctx, args) {
        checkPayload(args, 'updates', args.updates);
        const updates = args.updates;
        if (!updates.length) return { updated: 0, failed: 0, results: [] };
        await chargeRows(ctx, updates.length);
        const r = await writableTable(ctx, args.datatableId);
        const L = lib();
        const writeFilter = L.accessFilter.compileAccessFilter(r.tableMeta, r.grade, { id: ctx.userId }, 'update', L.engine.PG);
        const readFilter = L.accessFilter.compileAccessFilter(r.tableMeta, r.grade, { id: ctx.userId }, 'read', L.engine.PG);
        try {
            L.accessFilter.assertCanWrite(r.tableMeta, r.grade, 'update');
        } catch (e) {
            throw asRefusal(e) || new ToolRefusal('This account may not change rows of this table.', 'datatable_not_available');
        }

        const results = [];
        let changedAny = false;
        for (let index = 0; index < updates.length; index += 1) {
            const u = updates[index];
            const fail = (error, extra = {}) => results.push({ index, ok: false, error, ...extra });
            if (!isPlainObject(u)) { fail('An update is {id, values}.'); continue; }
            if (typeof u.id !== 'string' || !u.id || u.id.length > MAX_ID_CHARS) { fail('id must be a row id from datatables_query_rows.'); continue; }
            if (u.expectedUpdatedAt !== undefined && (typeof u.expectedUpdatedAt !== 'string' || !u.expectedUpdatedAt)) { fail('expectedUpdatedAt must be the updated_at you read.'); continue; }
            const checked = checkValues(deps, r.tableMeta, u.values, { partial: true });
            if (checked.error) { fail(checked.error); continue; }
            try {
                const upd = L.queryCompiler.compileUpdate(r.tableMeta, u.id, checked.values, writeFilter,
                    { expectedUpdatedAt: u.expectedUpdatedAt || null, dialect: 'pg' });
                const done = await deps.exec(r.scopeKey, upd.sql, upd.params);
                if (done && done.changes) {
                    changedAny = true;
                    results.push({ index, ok: true, id: u.id });
                    continue;
                }
                // Nothing changed: "gone / not yours" and "changed under you" are different answers.
                const probe = L.queryCompiler.compileGetById(r.tableMeta, u.id, readFilter, L.engine.PG);
                const found = await deps.query(r.scopeKey, probe.sql, probe.params);
                const row = (found.rows || [])[0];
                if (!row) fail('No such row, or this account may not change it.');
                else fail('Someone else changed this row since you read it.', { code: 'row_conflict', updated_at: row.updated_at });
            } catch (e) {
                fail(rowFailure(e));
            }
        }
        // data_version moves, row_count does not: an edit adds no rows.
        if (changedAny) await deps.bump(r.table.id, r.scope, 0);
        const updated = results.filter((x) => x.ok).length;
        log.info(`[mcp-datatables] update table=${r.table.id} user=${ctx.userId} rows=${updates.length} updated=${updated}`);
        return { updated, failed: updates.length - updated, results };
    }

    const handlers = {
        datatables_list: (ctx) => list(ctx),
        datatables_get_schema: getSchema,
        datatables_query_rows: queryRows,
        datatables_insert_rows: insertRows,
        datatables_update_rows: updateRows,
    };

    /**
     * Run one tool. Never throws: a refusal is `{ error, code }`, which the MCP
     * layer reports as isError.
     *
     * @param {string} name @param {Record<string, any>} args @param {{ userId: string, tokenId?: string|null }} ctx
     */
    async function call(name, args, ctx) {
        const handler = handlers[name];
        if (!handler) return { error: `Unknown tool: ${name}` };
        try {
            return await handler(ctx, args && typeof args === 'object' ? args : {});
        } catch (e) {
            if (e instanceof ToolRefusal) return { error: e.message, code: e.code, ...e.extra };
            log.error(`[mcp-datatables] ${name} failed user=${ctx.userId}: ${e instanceof Error ? e.name : 'error'}`);
            return { error: `${name} failed.`, code: 'internal_error' };
        }
    }

    return { call };
}

module.exports = {
    DATATABLE_TOOLS, DATATABLE_TOOL_NAMES, WRITE_TOOL_NAMES, makeDatatableTools,
    caps, checkValues, _test: { rowFailure, envCount },
};
