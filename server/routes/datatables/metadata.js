/**
 * One table's own facts: the label, the Art. 30 purpose, the lawful basis,
 * which column names the data subject, and how long its rows are kept.
 *
 * GET /:id answers the row the list already showed; PATCH /:id is the only
 * route that corrects any of it.
 */

'use strict';

const datatableStore = require('../../stores/datatableStore');
const sources = require('../../core/dataEngine/sources');
const { retentionFieldError } = require('../../core/dataEngine/dataModel/datatableFields');
const { isDefinitionManagedKind } = require('../../core/dataEngine/dataModel/managedTables');
const { DATA_LIMITS, MAX_RETENTION_DAYS } = require('./engine');
const { requireDatatableGrade, requireManageForOrgScope } = require('./grade');
const { bad, answerDatatableError, capabilityAllows } = require('./refusals');
const { publicTable } = require('./projection');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { worded, choice, rowScopeWord, NAME_TEXT, PURPOSE_TEXT } = require('./schemas');
const log = require('../../telemetry/log');

/**
 * The keys a PATCH may NOT carry, told apart from a typo on purpose.
 *
 * `key` and `scope` are not patchable and never will be: the key names one
 * physical Postgres table and the scope names the tenant whose schema holds
 * it, so "editing" either would rename or move real rows. They are refused by
 * name rather than lumped in with a misspelling, because "you cannot change
 * that" and "there is no such setting" are different answers to a person
 * looking for a rename button. What a PATCH MAY carry is PATCH_SHAPE below.
 */
const IMMUTABLE = Object.freeze(['key', 'scope', 'id', 'organizationId', 'scopeKind', 'managedKind']);

/** GDPR Art. 6(1) — the same closed list the Compliance settings screen offers. */
const LAWFUL_BASES = Object.freeze([
    'consent', 'contract', 'legal_obligation',
    'vital_interests', 'public_task', 'legitimate_interests',
]);

const RETENTION_TEXT = `A retention window is a whole number of days between 1 and ${MAX_RETENTION_DAYS}, or none`;
const BASIS_TEXT = 'Choose one of the six GDPR Art. 6 grounds, or none';
const NAME_LEN_TEXT = `A name may be at most ${DATA_LIMITS.MAX_NAME_LEN} characters`;
const FIELD_TEXT = 'A column name is text';

/**
 * What a PATCH may carry, as a schema.
 *
 * Every value used to arrive through `String(body.x ?? '')`, which has no
 * refusal in it: a `name` of `{nl:'Klanten', en:'Customers'}` was stored as
 * the literal text "[object Object]", and a `description` of `['a','b']` as
 * "a,b" — both under a 200 reporting the table as saved. A schema is the only
 * thing that can tell "42" from 42.
 *
 * The unknown-key check stays hand-written rather than becoming `.strict()`:
 * "you cannot change that" and "there is no such setting" are different
 * answers to a person looking for a rename button, and zod's one strict
 * message cannot say both.
 */
const PATCH_SHAPE = {
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(DATA_LIMITS.MAX_NAME_LEN, NAME_LEN_TEXT),
    description: worded(PURPOSE_TEXT).trim().min(1, PURPOSE_TEXT),
    lawfulBasis: choice(LAWFUL_BASES, BASIS_TEXT).nullable(),
    // Both column names are checked against the table's OWN columns in the
    // handler — an author-supplied identifier must never reach the compiler
    // unchecked, and only a meta read knows which columns exist.
    subjectColumn: worded(FIELD_TEXT).trim().min(1, FIELD_TEXT).nullable(),
    retentionField: worded(FIELD_TEXT).trim().min(1, FIELD_TEXT),
    retentionDays: z.number({ invalid_type_error: RETENTION_TEXT })
        .int(RETENTION_TEXT).min(1, RETENTION_TEXT).max(MAX_RETENTION_DAYS, RETENTION_TEXT)
        .nullable(),
    rowScope: rowScopeWord(),
};
const PatchBody = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(PATCH_SHAPE).partial().passthrough().superRefine((body, ctx) => {
        for (const k of Object.keys(body)) {
            if (Object.hasOwn(PATCH_SHAPE, k)) continue;
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [k],
                message: IMMUTABLE.includes(k)
                    ? `A table's ${k} cannot be changed — it names the table's own storage`
                    // Rejected, not dropped. A silently ignored key is a
                    // setting the person believes they saved.
                    : `"${k}" is not something you can change about a table`,
            });
        }
    }),
);

/**
 * Does this PATCH set a retention window, or make one keep rows for longer?
 *
 * That is the paid part (`datatable_retention`). Everything else a PATCH can
 * do to the window stays free on every plan: switching it off, leaving it as
 * it is, or shortening it. GDPR Art. 5(1)(e) asks for data to be kept no
 * longer than needed, and an owner acting on that must never meet a licence.
 *
 * "Shorter" means the same date column and fewer days. Moving a live window
 * to another column is a new rule rather than a shorter one: it can keep a
 * row far longer than the rule it replaces, so it counts as setting one.
 */
function widensRetention(table, body) {
    const current = table.retentionDays ?? null;
    const next = body.retentionDays === undefined ? current : body.retentionDays;
    if (next === null) return false;
    if (current === null || next > current) return true;
    return body.retentionField !== undefined && body.retentionField !== table.retentionField;
}

function register(router) {
    router.get('/:id', requireDatatableGrade('viewer'), (req, res) => {
        res.json({ datatable: publicTable(req.datatable, req.datatableGrade) });
    });

    /**
     * PATCH /api/datatables/:id — correct a table's name, its processing purpose,
     * its lawful basis, which column names the data subject, and how long its rows
     * are kept.
     *
     * There was no way to change ANY of this: the create dialog demands a
     * description on the stated grounds that "this sentence goes into your
     * organisation's processing record", and a typo in it was permanent.
     *
     * ── SETTING A WINDOW REQUIRES NAMING THE COLUMN ─────────────────────
     * `retention_field` is `TEXT NOT NULL DEFAULT 'created_at'`, so every row in
     * the deployment already carries a valid one and `retention_days IS NULL` is
     * the single thing keeping data alive. An owner who sets a window while
     * silently inheriting a default they never saw is one form submission away
     * from deleting on a rule nobody chose — so a non-null `retentionDays` is
     * refused unless `retentionField` is in the SAME request.
     *
     * ── rowScope NARROWS ONLY ───────────────────────────────────────────
     * 'own' → 'all' widens who can see rows that ALREADY EXIST: rows written under
     * "only the person who added it" would become visible to every viewer of the
     * table, retroactively. That is a disclosure, not a setting, so it is a 409
     * with the reason rather than a silent success.
     *
     * ── A LONGER WINDOW IS THE PAID PART, A SHORTER ONE NEVER IS ────────
     * Setting a window or lengthening one needs `datatable_retention`
     * (widensRetention above); shortening it or switching it off does not.
     * The check comes last, after every refusal that says what is wrong with
     * the request itself, so "that column is not a date" is never hidden
     * behind "that is on a higher plan". The sweep that enforces a window
     * already set is never gated (jobs/datatableRetention.js).
     */
    router.patch('/:id',
        requireDatatableGrade('owner'),
        requireManageForOrgScope(),
        validate({ body: PatchBody }),
        async (req, res) => {
            try {
                const body = req.body;
                const patch = {};

                // Trimmed and type-checked by the schema; the Art. 30 purpose
                // is refused blank there for the same reason POST / refuses it.
                if (body.name !== undefined) patch.name = body.name;
                if (body.description !== undefined) patch.description = body.description;
                if (body.lawfulBasis !== undefined) patch.lawfulBasis = body.lawfulBasis;

                // A mirror's rows are the source's: a retention window would delete
                // a copy the next refresh puts straight back, and 'own' would hide
                // the whole table from everyone but the account that linked it
                // (every synced row is created_by the linker).
                if (sources.isSourceMirror(req.datatable)) {
                    const where = sources.sourceLabel(req.datatable);
                    if (body.retentionDays !== undefined && body.retentionDays !== null) {
                        bad(`Rows of a linked table are not aged out here — they stay as long as they are in ${where}`, 'mirror_no_retention');
                    }
                    if (body.rowScope === 'own') {
                        bad('A linked table cannot be limited to each person\'s own rows — every row was written by the account that linked it', 'mirror_row_scope');
                    }
                }
                // A form's answers are written BY THE FORM: every row's created_by
                // is the person who submitted, so "only my own rows" would show a
                // reader nothing at all. Retention is allowed (answers may age).
                if (isDefinitionManagedKind(req.datatable.managedKind) && body.rowScope === 'own') {
                    bad('Answers are written by the form, not by the people reading them, so "only my own rows" would hide every row', 'answers_row_scope');
                }

                if (body.rowScope !== undefined) {
                    if (body.rowScope === 'all' && req.datatable.rowScope === 'own') {
                        return res.status(409).json({
                            error: 'Rows here were added under "only the person who added it". Opening them up would show every existing row to everyone with access to this table — make a new table instead.',
                            code: 'row_scope_widening',
                        });
                    }
                    patch.rowScope = body.rowScope;
                }

                if (body.retentionDays !== undefined) {
                    const d = body.retentionDays;
                    if (d !== null) {
                        if (body.retentionField === undefined) {
                            bad('Say which date column the age is measured from — a retention window must never fall back to a column nobody chose',
                                'retention_field_required');
                        }
                    }
                    patch.retentionDays = d;
                }

                // The two field names are checked against the table's own columns:
                // an author-supplied identifier must never reach the compiler
                // unchecked, and the sweep has to agree with what was accepted here
                // or the control silently does nothing.
                const needsMeta = body.retentionField !== undefined
                    || (body.subjectColumn !== undefined && body.subjectColumn !== null);
                const meta = needsMeta
                    ? await datatableStore.getTableMeta(req.datatableScope, req.datatable.id)
                    : null;
                if (needsMeta && !meta) {
                    return res.status(409).json({ error: 'This datatable has no columns yet' });
                }

                if (body.retentionField !== undefined) {
                    const err = retentionFieldError(meta, body.retentionField);
                    if (err) bad(err, 'bad_retention_field');
                    patch.retentionField = body.retentionField;
                }

                if (body.subjectColumn !== undefined) {
                    if (body.subjectColumn !== null) {
                        const declared = new Set((meta.fields || []).map(f => f && f.key));
                        if (!declared.has(body.subjectColumn)) {
                            bad(`"${body.subjectColumn}" is not a column of this table`, 'bad_subject_column');
                        }
                    }
                    patch.subjectColumn = body.subjectColumn;
                }

                if (widensRetention(req.datatable, body)
                    && !await capabilityAllows('datatable_retention', req, res)) return;

                const t = await datatableStore.updateDatatableMeta(req.datatable.id, req.datatableScope, patch);
                if (!t) return res.status(404).json({ error: 'Not found' });
                res.json({ datatable: publicTable(t, req.datatableGrade) });
            } catch (e) {
                if (answerDatatableError(res, e, req.datatableScope)) return;
                log.error('[datatables] meta write failed:', e.message);
                res.status(500).json({ error: 'Could not save the table settings' });
            }
        });
}

module.exports = { register };
