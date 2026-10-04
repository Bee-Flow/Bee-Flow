/**
 * The column list: reading it, and saving it against an optimistic lock.
 *
 * A save is the one edit that can drop a column out from under somebody else's
 * automation, so it asks first; and the model write and the ALTERs are one
 * transaction, because two left the model claiming a column Postgres does not
 * have — permanently.
 */

'use strict';

const db = require('../../db');
const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const { migrationPlan } = require('../../core/dataEngine/dataModel/migrationPlan');
const { ddlForTable } = require('../../core/dataEngine/dataModel/ddl');
const { normalizeFields } = require('../../core/dataEngine/dataModel/datatableFields');
const {
    managedFieldsError, isSourceManagedKind, isSchemaLockedKind,
} = require('../../core/dataEngine/dataModel/managedTables');
const { PG, DATA_LIMITS } = require('./engine');
const { requireDatatableGrade, requireManageForOrgScope } = require('./grade');
const { quota, answerDatatableError, confirmedBreaking, breakingColumnUsage } = require('./refusals');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { bodyOf, flag, CONFIRM_TEXT } = require('./schemas');
const log = require('../../telemetry/log');

// ── What a save may carry ───────────────────────────────────────────
//
// `.strict()`, and the optimistic lock is why. `expectedVersion` is mandatory
// and the refusals for it were already spelled out below; what the schema adds
// is that a MISSPELLED one — `expectedversion`, `modelVersion` — is no longer
// an absent one. A client that sent the version under the wrong name used to
// be told "send the modelVersion you loaded" while it was doing exactly that.
//
// `confirmBreaking` is listed because the Studio's column designer always
// sends it (datatablesApi.putSchema), so a strict body without it would refuse
// every save from the shipped client.
const FIELDS_TEXT = 'Send the full column list';
const VERSION_TEXT = 'expectedVersion must be the whole number GET /schema returned';
const SchemaBody = bodyOf({
    fields: z.array(z.unknown(), { required_error: FIELDS_TEXT, invalid_type_error: FIELDS_TEXT }),
    // Accepted as a number or as the digits of one, and NOTHING else.
    // `Number()` alone accepts `true` (→ 1), `[]` (→ 0) and `''` (→ 0), so a
    // malformed field used to slip past and come back as a 409 telling the
    // person a colleague was editing — a lie about a save that never happened.
    expectedVersion: z.union([
        z.number().int(VERSION_TEXT).min(0, VERSION_TEXT),
        z.string().trim().regex(/^\d+$/, VERSION_TEXT).transform(Number),
    ], { errorMap: () => ({ message: VERSION_TEXT }) }).optional(),
    confirmBreaking: z.boolean({ invalid_type_error: CONFIRM_TEXT }).optional(),
});

const SchemaQuery = z.object({ confirmBreaking: flag(CONFIRM_TEXT) }).strict();

function register(router) {
    router.get('/:id/schema', requireDatatableGrade('viewer'), async (req, res) => {
        try {
            const meta = await datatableStore.getTableMeta(req.datatableScope, req.datatable.id);
            const { modelVersion } = await datatableStore.getModel(req.datatableScope);
            res.json({ fields: meta?.fields || [], modelVersion });
        } catch (e) {
            log.error('[datatables] schema read failed:', e.message);
            res.status(500).json({ error: 'Could not load the columns' });
        }
    });

    router.put('/:id/schema',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        validate({ body: SchemaBody, query: SchemaQuery }),
        async (req, res) => {
            try {
                // A table whose WHOLE column list is somebody else's (a Nextcloud
                // mirror) is refused before anything is parsed: normalizeFields
                // would otherwise 400 on the relation columns such a table carries
                // and hide the real answer — that there is nothing to save here.
                if (isSchemaLockedKind(req.datatable.managedKind)) {
                    return res.status(409).json({
                        error: managedFieldsError(req.datatable.managedKind, []),
                        code: isSourceManagedKind(req.datatable.managedKind) ? 'schema_from_source' : 'schema_from_definition',
                    });
                }
                const { fields, expectedVersion: expected } = req.body;
                if (fields.length > DATA_LIMITS.MAX_FIELDS_PER_TABLE) {
                    return quota(res, DATA_LIMITS.MAX_FIELDS_PER_TABLE, fields.length);
                }
                // The optimistic lock is MANDATORY, and its own refusal — the
                // shape is the schema's. It used to be `expectedVersion ===
                // undefined ? null : Number(...)` against saveModel's `if
                // (expectedVersion !== null)`, so a client that simply forgot
                // the field clobbered a concurrent editor unconditionally.
                if (expected === undefined) {
                    return res.status(400).json({
                        error: 'Send the modelVersion you loaded, so a concurrent edit is not overwritten',
                        code: 'version_required',
                    });
                }
                const scope = req.datatableScope;
                const scopeKey = req.datatableScopeKey;
                const before = await datatableStore.getModel(scope);
                const next = JSON.parse(JSON.stringify(before.model));
                const t = (next.tables || []).find(x => x && x.id === req.datatable.id);
                if (!t) return res.status(409).json({ error: 'This datatable is not in the scope model' });

                // The STORED columns, captured before t.fields is replaced. They are
                // both the identity baseline for normalisation and the answer to
                // "which columns is this save dropping".
                const storedFields = Array.isArray(t.fields) ? t.fields : [];

                // Normalise against what is STORED, so a column that already exists
                // keeps its id. Minting a new one would read to the planner as
                // "drop that column, add this one" — a DROP COLUMN against live rows.
                const norm = normalizeFields(fields, storedFields);
                if (!norm.ok) return res.status(400).json({ error: norm.error });

                // A MANAGED table's own columns are not the author's to remove or
                // retype. Everything else about it is an ordinary table — extra
                // columns are welcome, the rows are editable, the table is
                // deletable — but the writer names these by key on a schedule, so a
                // drop is a 500 inside somebody's nightly automation and a retype is
                // worse: it lands as a value the column cannot hold. Checked HERE,
                // not only in the designer, because the designer is not the only
                // caller of this route.
                const managedErr = managedFieldsError(req.datatable.managedKind, norm.fields);
                if (managedErr) {
                    return res.status(409).json({ error: managedErr, code: 'managed_column' });
                }

                // A column drop is the one schema edit that breaks somebody else's
                // automation, and it breaks it silently at 3am. listUsageForColumn is
                // the index written for exactly this; ask it before the DDL runs,
                // not after.
                const breaking = await breakingColumnUsage(req.datatable.id, storedFields, norm.fields);
                if (breaking.length && !confirmedBreaking(req)) {
                    return res.status(409).json({
                        error: 'Automations still use the columns you are removing',
                        code: 'breaking_change',
                        breaking,
                    });
                }
                t.fields = norm.fields;

                // The model write and the ALTERs are ONE transaction. They used to
                // be two, and the order was the trap: the model committed first, so
                // a DDL failure (a bad type, a NOT NULL on a populated table, a lock
                // timeout, a replica restart) left `model_version` bumped and the
                // model claiming a column Postgres does not have — and the NEXT save
                // never re-emitted it, because migrationPlan step 4 skips a field
                // whose id is already in `oldIds`. The divergence was permanent.
                const saved = await db.withTransaction(async (client) => (
                    datatableStore.saveModel(scope, next, {
                        expectedVersion: expected,
                        client,
                        applyPhysical: async (c, { before: locked, next: after, modelVersion }) => {
                            // Diffed against the model read UNDER THE LOCK, and
                            // scoped to this table: nothing here may carry out
                            // another editor's half-finished change.
                            const plan = migrationPlan(locked, after, { ...PG, onlyTableIds: [req.datatable.id] });
                            if (!plan.length) return;
                            // Lead with an idempotent CREATE TABLE for the table
                            // being edited. It is a no-op in the ordinary case, and
                            // the repair in the case that matters: a table whose
                            // fields were stored without ids never got a physical
                            // table worth the name, so its ALTERs would fail on a
                            // relation that does not exist.
                            const ensure = ddlForTable(t, {
                                tableKeyById: new Map((after.tables || []).map(x => [x.id, x.key])),
                                dialect: 'pg',
                                // The read indexes ride along, so an existing table
                                // grows them on the next save without a migration.
                                rowScope: req.datatable.rowScope,
                            });
                            await datatableDbStore.applyMigration(scopeKey, scopeKey,
                                [ensure, ...plan], { client: c, targetVersion: modelVersion });
                        },
                    })
                ));
                if (!saved.ok) {
                    return res.status(409).json({
                        error: 'Someone else changed these columns while you were editing',
                        code: 'version_conflict',
                        currentVersion: saved.currentVersion,
                    });
                }
                res.json({ fields: norm.fields, modelVersion: saved.modelVersion });
            } catch (e) {
                if (answerDatatableError(res, e, req.datatableScope)) return;
                log.error('[datatables] schema write failed:', e.message);
                res.status(500).json({ error: 'Could not save the columns' });
            }
        });
}

module.exports = { register };
