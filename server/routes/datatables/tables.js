/**
 * The collection: every table the caller can address, and making a new one.
 *
 * Two creates, deliberately not sharing their gate chain — see the header of
 * POST /managed for why a helper would hide exactly the failure the suite
 * exists to catch.
 */

'use strict';

const db = require('../../db');
const { assertUserCanUseOrg, hasPermission, Permissions } = require('../../auth');
const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const { migrationPlan } = require('../../core/dataEngine/dataModel/migrationPlan');
const { ddlForTable } = require('../../core/dataEngine/dataModel/ddl');
const { normalizeFields } = require('../../core/dataEngine/dataModel/datatableFields');
const { managedKindSpec } = require('../../core/dataEngine/dataModel/managedTables');
const { assertDatatableQuota } = require('../../core/dataEngine/datatableLimits');
const {
    gradeForPrincipal, resolveDatatablePrincipal, datatableScopesFor, defaultCreateScope,
} = require('../../auth/datatableAccess');
const { PG, DATA_LIMITS, keyOf, MAX_RETENTION_DAYS } = require('./engine');
const { quota, answerDatatableError } = require('./refusals');
const { publicTable, scopeDescriptor } = require('./projection');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const {
    bodyOf, worded, tableKey, tableName, tablePurpose, scopeWord, SCOPE_WORDS, rowScopeWord,
} = require('./schemas');
const log = require('../../telemetry/log');

// ── What a caller may send ──────────────────────────────────────────
//
// Both creates are `.strict()`, and `rowScope` is the reason to read this
// twice. It used to be `const { rowScope = 'all' } = req.body`, straight into
// the store — and the store writes `rowScope === 'own' ? 'own' : 'all'`, as
// does auth/datatableAccess when it reads the column back. So `rowScope:
// 'Own'`, or 'onw', or 'own ' silently meant 'all': the person asked for "only
// the person who added it", the table was created with every row visible to
// everyone who can open it, and the answer was a 200 describing a table that
// had been made. An enum with an errorMap cannot say that.
//
// `name` is deliberately NOT length-capped here, though PATCH /:id caps it at
// MAX_NAME_LEN. The Duplicate action in the Studio (DatatableDetail.jsx) posts
// "<original name> (copy)", so a cap on create would refuse a duplicate of any
// table already near the limit — a caller that works today.

const CreateBody = bodyOf({
    // First in the shape so its refusal is the one the caller reads: the
    // placement decides which of the two gate chains below even runs.
    scope: scopeWord(),
    name: tableName(),
    key: tableKey(),
    description: tablePurpose(),
    // The column list. Shape is normalizeFields' to judge — it mints the
    // stable ids the migration planner matches on — and the length is the
    // quota's, which answers 409 rather than 400.
    fields: z.array(z.unknown(), { invalid_type_error: 'Send the columns as a list' }).default([]),
    rowScope: rowScopeWord().default('all'),
    projectId: worded('projectId is the id of a project').trim().min(1, 'projectId is the id of a project').nullish(),
});

const MANAGED_KIND_TEXT = 'That is not a kind of table this workspace knows how to fill in';
const ManagedBody = bodyOf({
    scope: scopeWord(),
    // Which contract to provision. Checked against managedKindSpec below
    // rather than listed here: the registry is the single source of the kinds,
    // and a second copy of the list would drift from it.
    kind: worded(MANAGED_KIND_TEXT).trim().min(1, MANAGED_KIND_TEXT),
    name: tableName(),
    key: tableKey(),
    // Optional here and only here: left out, the kind's own Art. 30 sentence
    // is used. Sent blank, it is still refused — an empty purpose makes the
    // generated register a record of nothing.
    description: tablePurpose().optional(),
    retentionDays: z.number({ invalid_type_error: `Rows are kept for a whole number of days between 1 and ${MAX_RETENTION_DAYS}` })
        .int(`Rows are kept for a whole number of days between 1 and ${MAX_RETENTION_DAYS}`)
        .min(1, `Rows are kept for a whole number of days between 1 and ${MAX_RETENTION_DAYS}`)
        .max(MAX_RETENTION_DAYS, `Rows are kept for a whole number of days between 1 and ${MAX_RETENTION_DAYS}`)
        .optional(),
});

function register(router) {
    // ── Collection ──────────────────────────────────────────────────────────────

    /**
     * Every table the caller holds any grade on, across both scopes.
     *
     * BOTH, not "the current one": a personal table made before joining an
     * organisation would otherwise become invisible to its own owner, with no way
     * to read, export or erase it. `scope` describes where a NEW table would go.
     */
    router.get('/', async (req, res) => {
        try {
            const principal = await resolveDatatablePrincipal(req);
            const scopes = datatableScopesFor(principal);
            if (!scopes.length) {
                // No session at all — the mount's requireAuthedUser makes this
                // unreachable in practice, and an empty list with no scope is the
                // only honest answer if it ever is.
                return res.json({ datatables: [], scope: null, reason: 'no_scope' });
            }
            const all = [];
            for (const scope of scopes) {
                all.push(...await datatableStore.listDatatablesForScope(scope));
            }
            const grantsByTable = await datatableStore.listGrantsForTables(all.map(t => t.id));
            // "2 automations" on the row — distinct consumers of any kind, one
            // GROUP BY for the whole list rather than one usage read per table.
            const usageByTable = await datatableStore.listUsageCounts(all.map(t => t.id));
            const visible = [];
            for (const t of all) {
                const grade = gradeForPrincipal(t, grantsByTable.get(t.id) || [], principal);
                if (grade) visible.push({ ...publicTable(t, grade), usageCount: usageByTable.get(t.id) || 0 });
            }
            res.json({ datatables: visible, scope: scopeDescriptor(defaultCreateScope(principal)) });
        } catch (e) {
            log.error('[datatables] list failed:', e.message);
            res.status(500).json({ error: 'Could not load your datatables' });
        }
    });

    /**
     * Create a table.
     *
     * `scope` is a WORD the caller sends — 'organisation' or 'personal' — and it
     * defaults to whichever the account can actually use. A member of several
     * organisations picks one explicitly through `organizationId`; nothing here
     * guesses which of them a new table belongs to.
     */
    router.post('/', validate({ body: CreateBody }), async (req, res) => {
        // Declared out here so the catch can drop the engine's access memo for
        // the scope whose transaction just rolled back.
        let scope = null;
        try {
            const principal = await resolveDatatablePrincipal(req);
            const { scope: wanted, name, key, description, fields, rowScope, projectId } = req.body;
            // The WORD, judged here rather than as a schema enum: the Studio's
            // create dialog branches on this code to say it in the person's own
            // language, and `invalid_request` would drop them into English.
            if (wanted !== undefined && !SCOPE_WORDS.includes(wanted)) {
                return res.status(400).json({
                    error: 'A table belongs either to your organisation or to this account',
                    code: 'bad_scope',
                });
            }
            const preferred = wanted || (principal.orgId ? 'organisation' : 'personal');

            if (preferred === 'organisation') {
                if (!principal.orgId) {
                    return res.status(400).json({
                        error: 'Datatables belong to an organisation, and this account is not in one',
                        code: 'no_organisation',
                    });
                }
                scope = datatableStore.orgScope(principal.orgId);
                await assertUserCanUseOrg(req, scope.id);
                // The org-scope gate, and only here: `manage_datatables` sits under
                // org_admin/agent_admin, so applying it to a personal table would
                // refuse the account this route exists for.
                if (!await hasPermission(principal.userId, Permissions.MANAGE_DATATABLES, req.session)) {
                    return res.status(403).json({ error: `Permission '${Permissions.MANAGE_DATATABLES}' required` });
                }
            } else {
                if (!principal.userId) return res.status(401).json({ error: 'Not authenticated' });
                scope = datatableStore.userScope(principal.userId);
            }

            // The name, the key and the Art. 30 purpose were checked by the
            // schema; the column COUNT is a quota, so it answers 409 with the
            // frozen quota body rather than a 400.
            if (fields.length > DATA_LIMITS.MAX_FIELDS_PER_TABLE) {
                return quota(res, DATA_LIMITS.MAX_FIELDS_PER_TABLE, fields.length);
            }

            // Every column needs a stable id before it enters the model: the
            // migration planner matches fields BY ID, so an id-less field is
            // invisible to it and the physical column is never created. See
            // dataModel/datatableFields.js.
            const norm = normalizeFields(fields, []);
            if (!norm.ok) return res.status(400).json({ error: norm.error });

            const scopeKey = keyOf(scope);
            // The `datatables` row, the scope model and the CREATE TABLE land in
            // ONE transaction. They used to be two: the metadata committed
            // first, so a DDL failure left a table the picker listed and every
            // read 500'd on — and retrying hit the unique index on (scope, key),
            // which itself surfaced as a 500. Either both land or neither does.
            const table = await db.withTransaction(async (client) => (
                datatableStore.createDatatable({
                    scope, ownerUserId: principal.userId,
                    key, name, description,
                    projectId: projectId ?? null, rowScope, fields: norm.fields,
                }, {
                    client,
                    // Counted with the scope's model row FOR UPDATE-held. It used
                    // to list every table in the organisation OUTSIDE any lock, so
                    // two replicas could both see 49 and both create the 50th.
                    assertQuota: (usage) => assertDatatableQuota(scope, { addTables: 1, usage }),
                    applyPhysical: async (c, { before, next, modelVersion }) => {
                        // Compiled for Postgres explicitly, and scoped to the
                        // table being created: a whole-model diff would also
                        // carry out whatever a concurrent editor left half-done.
                        const created = next.tables[next.tables.length - 1];
                        // Leads with this table's OWN ddl so it carries the read
                        // indexes migrationPlan cannot know about: the plan diffs a
                        // coerced model (id/key/fields), which has no row scope.
                        const ensure = ddlForTable(created, {
                            tableKeyById: new Map((next.tables || []).map(x => [x.id, x.key])),
                            dialect: 'pg',
                            rowScope,
                        });
                        const plan = migrationPlan(before, next, { ...PG, onlyTableIds: [created.id] });
                        await datatableDbStore.applyMigration(scopeKey, scopeKey, [ensure, ...plan],
                            { client: c, targetVersion: modelVersion });
                    },
                })
            ));
            datatableDbStore.invalidate(scopeKey);
            res.json({ datatable: publicTable(table, 'owner') });
        } catch (e) {
            // The engine memoises "this scope has a model row" inside the
            // transaction that is now rolled back, so the memo has to go with
            // it — otherwise the next call skips the 404 and fails on a schema
            // that does not exist.
            if (scope) datatableDbStore.invalidate(keyOf(scope));
            if (answerDatatableError(res, e, scope)) return;
            log.error('[datatables] create failed:', e.message);
            res.status(500).json({ error: 'Could not create the datatable' });
        }
    });

    /**
     * Provision a MANAGED table — one whose COLUMNS the platform owns.
     *
     * Today there is exactly one kind: `http_cache`, the visible tier of the
     * http_request response cache. The caller chooses the NAME, the Art. 30
     * description and how long rows are kept; the columns are the contract in
     * core/dataEngine/dataModel/managedTables.js and are not negotiable, because a
     * routine writes them by name on a schedule and a dropped column is a 500 at
     * 3am that the person who dropped it will never see.
     *
     * ── WHY THE GATE CHAIN IS SPELLED OUT AGAIN ─────────────────────────
     * The org/personal branch below is deliberately NOT shared with POST / . Both
     * routes create a table in a tenant, and datatables.test.js pins the gates
     * against each route's own body — a second create route that quietly forgot
     * `manage_datatables` or `assertUserCanUseOrg` is precisely the failure that
     * suite exists to make impossible, and a helper would hide it from the regex.
     *
     * ── AND RETENTION IS THE EXPIRY ─────────────────────────────────────
     * `retention_field` is the kind's own timestamp column and `retention_days` the
     * window, so jobs/datatableRetention is what removes an old answer. One
     * mechanism, two features: there is no second, invisible clock to reason about.
     */
    router.post('/managed', validate({ body: ManagedBody }), async (req, res) => {
        let scope = null;
        try {
            const principal = await resolveDatatablePrincipal(req);
            const spec = managedKindSpec(req.body.kind);
            if (!spec) {
                return res.status(400).json({
                    error: 'That is not a kind of table this workspace knows how to fill in',
                    code: 'unknown_managed_kind',
                });
            }
            // A kind whose columns arrive WITH the link has nothing to provision
            // here — POST /nextcloud/link is the route that makes one.
            if (spec.fieldsFromSource) {
                return res.status(400).json({
                    error: 'This kind of table is made by linking it, not by creating it',
                    code: 'kind_needs_link',
                });
            }
            // A form's answers table is made by the form (Studio → Forms →
            // "Collect answers in a table"); its columns are that form's questions.
            if (spec.fieldsFromDefinition) {
                return res.status(400).json({
                    error: 'This kind of table is made by a form that collects its answers — switch that on under Studio → Forms',
                    code: 'kind_needs_form',
                });
            }

            const { scope: wanted, name, key } = req.body;
            if (wanted !== undefined && !SCOPE_WORDS.includes(wanted)) {
                return res.status(400).json({
                    error: 'A table belongs either to your organisation or to this account',
                    code: 'bad_scope',
                });
            }
            const preferred = wanted || (principal.orgId ? 'organisation' : 'personal');
            if (preferred === 'organisation') {
                if (!principal.orgId) {
                    return res.status(400).json({
                        error: 'Datatables belong to an organisation, and this account is not in one',
                        code: 'no_organisation',
                    });
                }
                scope = datatableStore.orgScope(principal.orgId);
                await assertUserCanUseOrg(req, scope.id);
                if (!await hasPermission(principal.userId, Permissions.MANAGE_DATATABLES, req.session)) {
                    return res.status(403).json({ error: `Permission '${Permissions.MANAGE_DATATABLES}' required` });
                }
            } else {
                if (!principal.userId) return res.status(401).json({ error: 'Not authenticated' });
                scope = datatableStore.userScope(principal.userId);
            }

            // The SAME Art. 30 demand POST / makes — the schema refuses a blank
            // one. Pre-filled by the dialog from the kind's own sentence, and
            // that sentence is what an omitted `description` falls back to: a
            // managed table holds third-party responses, which is exactly the
            // processing an auditor asks about.
            const description = req.body.description ?? String(spec.defaultDescription || '').trim();
            if (!description) {
                return res.status(400).json({ error: 'Say what this table is for — it goes in your processing record' });
            }
            const retentionDays = req.body.retentionDays ?? spec.defaultRetentionDays;

            // Through the same normaliser every other create uses, so a managed
            // table's fields are byte-identical in shape to an author's. The ids
            // are the contract's own and survive it — see managedTables.js.
            const norm = normalizeFields(spec.fields, []);
            if (!norm.ok) return res.status(500).json({ error: norm.error });

            const scopeKey = keyOf(scope);
            const table = await db.withTransaction(async (client) => (
                datatableStore.createDatatable({
                    scope, ownerUserId: principal.userId,
                    key, name, description,
                    fields: norm.fields,
                    managedKind: spec.kind,
                    // The whole expiry story: the ordinary sweeper, on the kind's
                    // own timestamp column.
                    retentionField: spec.retentionField,
                    retentionDays,
                }, {
                    client,
                    assertQuota: (usage) => assertDatatableQuota(scope, { addTables: 1, usage }),
                    applyPhysical: async (c, { before, next, modelVersion }) => {
                        const created = next.tables[next.tables.length - 1];
                        const ensure = ddlForTable(created, {
                            tableKeyById: new Map((next.tables || []).map(x => [x.id, x.key])),
                            dialect: 'pg',
                            rowScope: 'all',
                        });
                        const plan = migrationPlan(before, next, { ...PG, onlyTableIds: [created.id] });
                        await datatableDbStore.applyMigration(scopeKey, scopeKey, [ensure, ...plan],
                            { client: c, targetVersion: modelVersion });
                    },
                })
            ));
            datatableDbStore.invalidate(scopeKey);
            res.json({ datatable: publicTable(table, 'owner'), warning: spec.warning });
        } catch (e) {
            if (scope) datatableDbStore.invalidate(keyOf(scope));
            if (answerDatatableError(res, e, scope)) return;
            log.error('[datatables] managed create failed:', e.message);
            res.status(500).json({ error: 'Could not create the datatable' });
        }
    });
}

module.exports = { register };
