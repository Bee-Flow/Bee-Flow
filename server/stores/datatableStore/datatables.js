// @typecheck
'use strict';

/**
 * The table itself: its `datatables` row and its entry in the scope's model
 * document, which are created, replaced and dropped together or not at all.
 *
 * Everything here is scope-addressed, because everything here names a tenant's
 * physical table. The three statements that change the SHAPE of a table —
 * create, save model, delete — take the model row's `FOR UPDATE` lock and run
 * the injected physical DDL (`applyPhysical` / `dropPhysical`) inside the same
 * transaction: the store keeps no engine dependency, and a half-written pair
 * leaves a table the picker shows but the compiler cannot describe.
 *
 * `bumpAfterWrite` is the opposite end of the same row — the hot path, one
 * arithmetic UPDATE per write STEP with no lock at all, which is exactly why
 * `row_count` and `data_version` are scalar columns rather than a JSONB blob.
 */

const { run, getOne, getAll } = require('../../db');
const { assertScope, orgIdOf } = require('./scope');
const { initDB } = require('./schema');
const { newDatatableId, rowToDatatable, inTransaction } = require('./rowMappers');
const { parseJSONObject } = require('../lib/json');
const { buildUpdate } = require('../lib/sqlBuilder');
const { notifyDatatableChanged } = require('./liveChanges');

/** One table by id, scoped to a tenant. Never call this unscoped. */
async function getDatatable(id, scope) {
    await initDB();
    if (!id || !scope || !scope.kind || !scope.id) return null;
    const r = await getOne(
        `SELECT * FROM datatables WHERE id = $1 AND scope_kind = $2 AND scope_id = $3`,
        [id, scope.kind, scope.id],
    );
    return rowToDatatable(r);
}

/**
 * Every table in one scope. Callers filter by grade — this is the "what exists"
 * half, and auth/datatableAccess is the "who may see it" half.
 */
async function listDatatablesForScope(scope) {
    await initDB();
    assertScope(scope, 'listDatatablesForScope');
    const res = await getAll(
        `SELECT * FROM datatables WHERE scope_kind = $1 AND scope_id = $2 ORDER BY name ASC`,
        [scope.kind, scope.id],
    );
    return (res || []).map(rowToDatatable);
}

/**
 * What one tenant consumes: tables, rows and on-disk bytes.
 *
 * The counters are read, never recomputed. `row_count` is arithmetic
 * (bumpAfterWrite, no lock) re-synced by jobs/datatableRetention, and
 * `size_bytes` is refreshed by the same sweep — a live COUNT(*) or
 * pg_total_relation_size here would put a full scan on every row write to make
 * a cap a few hundred rows more accurate.
 *
 * `client` runs it on the CALLER's transaction: createDatatable counts tables
 * with the model row already FOR UPDATE-held, because counting outside the lock
 * is how two replicas both saw 49 and both created the 50th.
 */
async function scopeUsage(scope, { client = null } = {}) {
    await initDB();
    assertScope(scope, 'scopeUsage');
    const q = client ? (sql, p) => client.query(sql, p) : async (sql, p) => ({ rows: await getAll(sql, p) });
    const counts = await q(
        `SELECT COUNT(*)::int AS table_count, COALESCE(SUM(row_count), 0)::bigint AS row_total
           FROM datatables WHERE scope_kind = $1 AND scope_id = $2`,
        [scope.kind, scope.id],
    );
    const meta = await q(
        `SELECT size_bytes FROM datatable_models WHERE scope_kind = $1 AND scope_id = $2`,
        [scope.kind, scope.id],
    );
    const c = (counts.rows || [])[0] || {};
    const m = (meta.rows || [])[0] || {};
    return {
        tables: Number(c.table_count) || 0,
        rows: Number(c.row_total) || 0,
        bytes: Number(m.size_bytes) || 0,
    };
}

/** The scope's data model document (the engine's table descriptors). */
async function getModel(scope) {
    await initDB();
    assertScope(scope, 'getModel');
    const r = await getOne(
        `SELECT model, model_version, schema_stamp, size_bytes FROM datatable_models
          WHERE scope_kind = $1 AND scope_id = $2`,
        [scope.kind, scope.id],
    );
    if (!r) return { model: { modelVersion: 1, tables: [] }, modelVersion: 0, schemaStamp: 0, sizeBytes: 0 };
    return {
        model: parseJSONObject(r.model, { modelVersion: 1, tables: [] }),
        modelVersion: Number(r.model_version) || 0,
        schemaStamp: Number(r.schema_stamp) || 0,
        sizeBytes: Number(r.size_bytes) || 0,
    };
}

/** The table descriptor the query compiler needs, by datatable id. */
async function getTableMeta(scope, datatableId) {
    const { model } = await getModel(scope);
    const tables = Array.isArray(model.tables) ? model.tables : [];
    return tables.find(t => t && t.id === datatableId) || null;
}

/**
 * Create a table. The `datatables` row, its entry in the scope model AND —
 * through `applyPhysical` — the CREATE TABLE are written in ONE transaction.
 * Every tbl_* in the model has exactly one datatables row with the same id, and
 * a half-written pair leaves a table the picker shows but the compiler cannot
 * describe (or the reverse).
 *
 * `organization_id` is DERIVED from the scope rather than passed alongside it:
 * two arguments for one fact is two arguments that can disagree, and the one
 * that would lose is the one org teardown and the FK filter on.
 *
 * The DDL is INJECTED rather than imported so this store keeps no engine
 * dependency, and it runs inside the transaction because the alternative is
 * what shipped: the `datatables` row committed before CREATE TABLE, so a
 * failure left a table the picker listed and every read 500'd on — and the
 * retry then hit the unique index on (scope, key).
 *
 * @param {{ scope: {kind: string, id: string}, ownerUserId?: string, key: string, name: string, description?: string,
 *           projectId?: string|null, lawfulBasis?: string|null, rowScope?: string, retentionDays?: number|null,
 *           retentionField?: string, subjectColumn?: string|null, fields?: any[], managedKind?: string|null,
 *           source?: object|null }} def
 * @param {object}   [opts]
 * @param {object}   [opts.client]  the caller's transaction, when they own one.
 * @param {(usage: {tables:number, rows:number, bytes:number}) => Promise<any>} [opts.assertQuota]
 *   Runs with the tenant's usage read UNDER the model row's FOR UPDATE lock and
 *   BEFORE anything is written. Injected rather than imported for the same
 *   reason applyPhysical is — this store keeps no engine dependency — and it
 *   runs inside the lock because the caller used to count every table in the
 *   organisation outside any transaction, so two replicas could both see 49 and
 *   both create the 50th. Throwing refuses the create.
 * @param {(client: object, ctx: {before: object, next: object, modelVersion: number}) => Promise<any>} [opts.applyPhysical]
 *   Runs on the transaction's own client, AFTER the metadata is written (the
 *   engine's access check reads `datatable_models`, so the row has to be there
 *   already). Throwing rolls the whole create back.
 */
async function createDatatable({
    scope, ownerUserId, key, name, description = '', projectId = null,
    lawfulBasis = null, rowScope = 'all', retentionDays = null, retentionField = 'created_at',
    subjectColumn = null, fields = [], managedKind = null, source = null,
}, { client = null, applyPhysical = null, assertQuota = null } = {}) {
    await initDB();
    assertScope(scope, 'createDatatable');
    if (!ownerUserId) throw new Error('createDatatable requires an ownerUserId');
    const id = newDatatableId();
    const organizationId = orgIdOf(scope);

    return inTransaction(client, async (c) => {
        // Read-modify-write the scope model under a row lock. FOR UPDATE is the
        // right tool HERE (a schema change, rare) and the wrong one for a row
        // write (hot) — which is why the counters are separate scalar columns.
        //
        // It is taken FIRST, before the `datatables` INSERT, because the table
        // count the quota gate reads has to be taken under it: counted before
        // the lock, two concurrent creates both see room for one more.
        const cur = await c.query(
            `SELECT model, model_version FROM datatable_models
              WHERE scope_kind = $1 AND scope_id = $2 FOR UPDATE`,
            [scope.kind, scope.id],
        );

        if (assertQuota) await assertQuota(await scopeUsage(scope, { client: c }));

        await c.query(
            `INSERT INTO datatables
                (id, scope_kind, scope_id, organization_id, owner_user_id, project_id, key, name,
                 description, lawful_basis, row_scope, retention_days, retention_field, subject_column,
                 managed_kind, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
            [id, scope.kind, scope.id, organizationId, ownerUserId, projectId, key, name,
                description, lawfulBasis, rowScope === 'own' ? 'own' : 'all',
                retentionDays, retentionField, subjectColumn,
                managedKind || null,
                source ? JSON.stringify(source) : null],
        );

        const stored = cur.rows.length
            ? parseJSONObject(cur.rows[0].model, { modelVersion: 1, tables: [] })
            : { modelVersion: 1, tables: [] };
        const storedTables = Array.isArray(stored.tables) ? stored.tables : [];
        // `before` is read UNDER THE LOCK, not before the transaction: a plan
        // diffed against a model somebody else has since changed emits DDL for
        // their edit as well as this one. Two arrays, so pushing onto `next`
        // cannot make `before` describe the table it is supposed to predate.
        const before = { ...stored, tables: [...storedTables] };
        const next = {
            ...stored,
            tables: [...storedTables, { id, key, name, fields: Array.isArray(fields) ? fields : [] }],
        };
        const modelVersion = (cur.rows.length ? Number(cur.rows[0].model_version) || 0 : 0) + 1;

        if (cur.rows.length) {
            await c.query(
                `UPDATE datatable_models
                    SET model = $1::jsonb, model_version = model_version + 1, updated_at = NOW()
                  WHERE scope_kind = $2 AND scope_id = $3`,
                [JSON.stringify(next), scope.kind, scope.id],
            );
        } else {
            await c.query(
                `INSERT INTO datatable_models (scope_kind, scope_id, organization_id, model, model_version)
                 VALUES ($1, $2, $3, $4::jsonb, 1)`,
                [scope.kind, scope.id, organizationId, JSON.stringify(next)],
            );
        }

        if (applyPhysical) await applyPhysical(c, { before, next, modelVersion });

        const r = await c.query(`SELECT * FROM datatables WHERE id = $1`, [id]);
        return rowToDatatable(r.rows[0]);
    });
}

/**
 * Replace the scope's model, with optimistic concurrency, and — through
 * `applyPhysical` — the matching DDL in the SAME transaction.
 *
 * Returns the same shape App Studio's saveDataModel uses, so a caller that
 * already handles one handles the other:
 *   { ok:true,  model, modelVersion }
 *   { ok:false, conflict:true, currentVersion, model }
 *
 * @param {object}   [opts]
 * @param {number|null} [opts.expectedVersion]
 * @param {object}   [opts.client]  the caller's transaction, when they own one.
 * @param {(client: object, ctx: {before: object, next: object, modelVersion: number}) => Promise<any>} [opts.applyPhysical]
 *   `before` is the model as read UNDER THE LOCK — the only baseline a plan may
 *   be diffed against. Throwing rolls the model write back with it, so a failed
 *   ALTER can never leave `model_version` claiming a column that is not there.
 */
async function saveModel(scope, model, {
    expectedVersion = null, client = null, applyPhysical = null,
} = {}) {
    await initDB();
    assertScope(scope, 'saveModel');
    return inTransaction(client, async (c) => {
        const cur = await c.query(
            `SELECT model, model_version FROM datatable_models
              WHERE scope_kind = $1 AND scope_id = $2 FOR UPDATE`,
            [scope.kind, scope.id],
        );
        const currentVersion = cur.rows.length ? Number(cur.rows[0].model_version) || 0 : 0;
        if (expectedVersion !== null && currentVersion !== expectedVersion) {
            return {
                ok: false,
                conflict: true,
                currentVersion,
                model: cur.rows.length ? parseJSONObject(cur.rows[0].model, null) : null,
            };
        }
        const before = cur.rows.length
            ? parseJSONObject(cur.rows[0].model, { modelVersion: 1, tables: [] })
            : { modelVersion: 1, tables: [] };
        if (cur.rows.length) {
            await c.query(
                `UPDATE datatable_models
                    SET model = $1::jsonb, model_version = model_version + 1, updated_at = NOW()
                  WHERE scope_kind = $2 AND scope_id = $3`,
                [JSON.stringify(model), scope.kind, scope.id],
            );
        } else {
            await c.query(
                `INSERT INTO datatable_models (scope_kind, scope_id, organization_id, model, model_version)
                 VALUES ($1, $2, $3, $4::jsonb, 1)`,
                [scope.kind, scope.id, orgIdOf(scope), JSON.stringify(model)],
            );
        }
        const modelVersion = currentVersion + 1;
        if (applyPhysical) await applyPhysical(c, { before, next: model, modelVersion });
        return { ok: true, model, modelVersion };
    });
}

/** Sharing: publish state and the group list. Validated by the caller. */
async function setSharing(id, scope, { isPublished, sharedGroups, writeMode }) {
    await initDB();
    assertScope(scope, 'setSharing');
    await run(
        `UPDATE datatables
            SET is_published = COALESCE($4, is_published),
                shared_groups = COALESCE($5::jsonb, shared_groups),
                write_mode    = COALESCE($6, write_mode),
                updated_at    = NOW()
          WHERE id = $1 AND scope_kind = $2 AND scope_id = $3`,
        [id, scope.kind, scope.id,
            isPublished === undefined ? null : !!isPublished,
            sharedGroups === undefined ? null : JSON.stringify(sharedGroups || []),
            writeMode === undefined ? null : writeMode],
    );
    return getDatatable(id, scope);
}

/**
 * The columns a PATCH may write, and the only ones.
 *
 * `key` and `scope_kind`/`scope_id` are absent on purpose: the key names one
 * physical Postgres table and the scope names the tenant that owns it, so
 * neither is editable metadata — changing one would rename or move real rows.
 * Everything here is a label, a lawful basis or a retention rule.
 */
const META_COLUMNS = Object.freeze({
    name: 'name',
    description: 'description',
    lawfulBasis: 'lawful_basis',
    subjectColumn: 'subject_column',
    retentionDays: 'retention_days',
    retentionField: 'retention_field',
    rowScope: 'row_scope',
});

/**
 * Edit a table's metadata. Validated by the caller; this only writes.
 *
 * A key that is not in META_COLUMNS THROWS rather than being skipped. That is
 * the `updatePlan` lesson written down: its colMap silently dropped any field
 * it did not know, so a rename in the caller turned a save into a no-op that
 * still answered 200 and the setting simply never took. Here the same mistake
 * is a 400 the caller cannot miss.
 */
async function updateDatatableMeta(id, scope, patch) {
    await initDB();
    assertScope(scope, 'updateDatatableMeta');
    const updates = {};
    for (const [key, value] of Object.entries(patch || {})) {
        if (value === undefined) continue;
        if (!Object.hasOwn(META_COLUMNS, key)) {
            const e = new Error(`"${key}" is not something you can change about a table`);
            e.status = 400;
            e.code = 'unknown_field';
            throw e;
        }
        updates[key] = value;
    }
    const built = buildUpdate({
        table: 'datatables',
        updates,
        columnMap: META_COLUMNS,
        extraSet: ['updated_at = NOW()'],
        where: [
            { col: 'id', value: id },
            { col: 'scope_kind', value: scope.kind },
            { col: 'scope_id', value: scope.id },
        ],
    });
    if (!built) return getDatatable(id, scope);
    await run(built.sql, built.params);
    return getDatatable(id, scope);
}

/**
 * The hot path. One arithmetic UPDATE per write STEP — never per row, and never
 * a read-modify-write. `delta` may be negative (a delete).
 */
async function bumpAfterWrite(id, scope, delta = 0) {
    await initDB();
    assertScope(scope, 'bumpAfterWrite');
    await run(
        `UPDATE datatables
            SET row_count = GREATEST(0, row_count + $4),
                data_version = data_version + 1,
                updated_at = NOW()
          WHERE id = $1 AND scope_kind = $2 AND scope_id = $3`,
        [id, scope.kind, scope.id, Number(delta) || 0],
    );
    // A `live` knowledge source watching this table wants to know (K8). Debounced
    // and fire-and-forget: this is the hot path — one arithmetic UPDATE per write
    // step — and a knowledge base is never a reason to slow a write down.
    notifyDatatableChanged(id);
}

/**
 * Delete one table: its model entry, its row and — through `dropPhysical` —
 * the physical Postgres table, all inside ONE transaction.
 *
 * The DDL is INJECTED rather than imported so this store keeps no engine
 * dependency, and it runs inside the transaction because the alternative is
 * what shipped: the metadata committed first and the DROP ran after it, so a
 * lock timeout left a table full of personal data that no metadata describes,
 * no access filter guards, no retention reaches and no UI can show — and the
 * route still answered `{ok:true}`. Composed for both erasure callers by
 * datatableDbStore.dropDatatable.
 *
 * Wekt na een geslaagde verwijdering dezelfde gedebouncede tap als een
 * rij-mutatie (`notifyDatatableChanged`), zodat een openbare snapshot die deze
 * rijen ingebakken heeft herschreven wordt — zie de reden bij de aanroep.
 *
 * @param {object}   [opts]
 * @param {object}   [opts.client]  the caller's transaction, when they own one.
 * @param {(client: object, ctx: {before: object, next: object, modelVersion: number}) => Promise<any>} [opts.dropPhysical]
 *   Runs on the transaction's own client, after the metadata is gone and only
 *   when a row was actually deleted. Throwing rolls the whole delete back.
 */
async function deleteDatatable(id, scope, { dropPhysical = null, client: outerClient = null } = {}) {
    await initDB();
    assertScope(scope, 'deleteDatatable');
    const deleted = await inTransaction(outerClient, async (client) => {
        const cur = await client.query(
            `SELECT model, model_version FROM datatable_models
              WHERE scope_kind = $1 AND scope_id = $2 FOR UPDATE`,
            [scope.kind, scope.id],
        );
        let before = null;
        let model = null;
        let modelVersion = 0;
        if (cur.rows.length) {
            before = parseJSONObject(cur.rows[0].model, { modelVersion: 1, tables: [] });
            modelVersion = (Number(cur.rows[0].model_version) || 0) + 1;
            // Shallow copy, then a NEW filtered array — `before` has to keep the
            // table the plan is about to drop, or the diff is empty and nothing
            // is dropped at all.
            model = { ...before };
            model.tables = (Array.isArray(before.tables) ? before.tables : []).filter(t => t && t.id !== id);
            await client.query(
                `UPDATE datatable_models SET model = $1::jsonb, model_version = model_version + 1, updated_at = NOW()
                  WHERE scope_kind = $2 AND scope_id = $3`,
                [JSON.stringify(model), scope.kind, scope.id],
            );
        }
        // grants and usage rows cascade from the FK
        const res = await client.query(
            `DELETE FROM datatables WHERE id = $1 AND scope_kind = $2 AND scope_id = $3`,
            [id, scope.kind, scope.id],
        );
        if ((res.rowCount || 0) === 0) return false;
        if (dropPhysical && before) await dropPhysical(client, { before, next: model, modelVersion });
        return true;
    });
    // Dezelfde tap als een rij-mutatie, om dezelfde reden — alleen in zijn
    // sterkste vorm. Een OPENBARE webpagina bakt de rijen van deze tabel als
    // statische <table> in haar snapshot; die bytes werken zichzelf niet bij.
    // Verdween er één rij, dan wekt bumpAfterWrite de reconciler. Verdwijnt de
    // HELE tabel — de route DELETE /api/datatables/:id, of een account dat
    // wordt gewist — dan verdween tot nu toe niemand: de snapshot bleef de
    // namen en e-mailadressen tonen tot de eigenaar toevallig opsloeg. De
    // zwaarste verwijdering die het product kent was zo de enige die publiek
    // niets deed.
    //
    // Alleen bij een ECHTE verwijdering: een `false` betekent dat er niets is
    // gewist (verkeerde scope, al weg), en dan is er ook niets te herschrijven.
    //
    // Na de transactie, niet erin. Bezit de aanroeper de transactie zelf
    // (`outerClient`), dan is er op dit punt nog niet gecommit; de melding is
    // gedebouncet, dus in de praktijk loopt de commit voor. Rolt hij alsnog
    // terug, dan schrijft de reconciler dezelfde rijen opnieuw — dat is de
    // veilige kant van de vergissing.
    if (deleted) notifyDatatableChanged(id);
    return deleted;
}

module.exports = {
    getDatatable,
    listDatatablesForScope,
    scopeUsage,
    getModel,
    getTableMeta,
    createDatatable,
    saveModel,
    setSharing,
    META_COLUMNS,
    updateDatatableMeta,
    bumpAfterWrite,
    deleteDatatable,
};
