/**
 * Datatable columns — the normaliser that gives every field a STABLE ID.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────
 * `migrationPlan` diffs two models by identity, and identity means `id`:
 * `coerceModelShape` filters out any field without a string `id`, and step 4
 * decides "is this column new?" with `oldIds.has(nf.id)`. A field carrying no
 * id is therefore not merely unmatched — it is INVISIBLE to the planner, and
 * `has(undefined)` against a set built from other id-less fields is true, so
 * the planner concludes there is nothing to do.
 *
 * The datatables routes used to write the client's `{key, name, type}` objects
 * into the org model verbatim. The consequences were total and silent:
 *
 *   * Creating a table emitted `CREATE TABLE "x" (id, created_at, updated_at,
 *     created_by, org_id)` — the author's own columns were dropped from the DDL.
 *   * Adding a column emitted NOTHING. The plan came back empty, so
 *     `if (plan.length)` skipped the migration entirely and the route answered
 *     200. The model listed the column; the table never grew it.
 *   * Every later read then failed on a relation or column that does not
 *     exist — the first honest error, several steps downstream of the cause.
 *
 * So an id is not bookkeeping here. It is the difference between a column the
 * database has and a column only the JSON knows about.
 *
 * ── PRESERVING IDENTITY ACROSS AN EDIT ──────────────────────────────
 * The column designer loads the stored fields, edits them in place and sends
 * the whole list back, so an id it was given round-trips on its own. But a
 * field may arrive without one — from a client that predates ids, from the
 * builder tools, or from a hand-made API call — and minting a fresh id for a
 * column that already exists reads to the planner as "drop the old one, add a
 * new one": a DROP COLUMN against live rows. `normalizeFields` therefore
 * matches an incoming field to the stored list by id FIRST and by key SECOND,
 * and only mints when neither finds anything. A rename then stays a rename.
 *
 * ── WHAT A DATATABLE COLUMN MAY BE ──────────────────────────────────
 * A strict subset of FIELD_TYPES. `relation` and `computed` are refused: a
 * relation emits an unqualified `REFERENCES "<key>"(id)` that only means
 * something between tables the author can see, and a computed field needs an
 * expression surface this feature deliberately does not have. The column
 * designer already offers only the nine below; this is the server saying the
 * same thing, because the designer is not the only caller.
 */

'use strict';

const { newFieldId } = require('./ids');
const {
    FIELD_TYPES, SYSTEM_COLUMNS, KEY_RE, RESERVED_KEY_PREFIX_RE, DATA_LIMITS,
} = require('./vocabulary');

/** The types a datatable column may take — FIELD_TYPES minus two. */
const DATATABLE_FIELD_TYPES = Object.freeze(
    FIELD_TYPES.filter(t => t !== 'relation' && t !== 'computed'),
);

const FIELD_ID_RE = /^fld_[a-z0-9]{4,}$/;

/** Options are author-supplied labels, not identifiers — bound, don't parse. */
function normalizeOptions(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const o of raw) {
        const value = (o && typeof o === 'object') ? o.value ?? o.key ?? o.label : o;
        if (value === null || value === undefined) continue;
        const s = String(value).trim().slice(0, DATA_LIMITS.MAX_NAME_LEN);
        if (!s || out.includes(s)) continue;
        out.push(s);
        if (out.length >= DATA_LIMITS.MAX_SELECT_OPTIONS) break;
    }
    return out;
}

/**
 * The two system columns a retention window may age rows out by. Both are
 * TIMESTAMPTZ on every datatable (dataModel/ddl.js), so they are always a
 * valid answer and need no declaration.
 */
const RETENTION_SYSTEM_FIELDS = Object.freeze(['created_at', 'updated_at']);

/**
 * Is `field` a column this table can actually be aged by? Returns null when it
 * is, or the sentence to show the owner when it is not.
 *
 * ONE answer, used by the PATCH route that accepts a retention window and by
 * the sweep that later acts on it. They must agree: the route refusing what the
 * sweep would skip is a control that silently does nothing, and the sweep
 * accepting what the route refuses would compare a cutoff against a text
 * column. `date`/`datetime` only — a `text` column holding something that looks
 * like a date compares LEXICALLY, so '9 Jan' would outlive '10 Jan'.
 *
 * An author-supplied identifier must never reach the compiler unchecked, which
 * is the other half of why this exists: resolveColumn would happily quote a
 * declared `text` column.
 */
function retentionFieldError(tableMeta, field) {
    if (typeof field !== 'string' || !field) {
        return 'Choose the date column this table is aged by';
    }
    if (RETENTION_SYSTEM_FIELDS.includes(field)) return null;
    const fields = Array.isArray(tableMeta && tableMeta.fields) ? tableMeta.fields : [];
    const f = fields.find(x => x && x.key === field);
    if (!f) return `"${field}" is not a column of this table`;
    if (f.type !== 'date' && f.type !== 'datetime') {
        return `"${field}" is a ${f.type} column — rows can only be aged out by a date or date-and-time column`;
    }
    return null;
}

/**
 * Validate and normalise a full column list against the one currently stored.
 *
 * Returns `{ ok: true, fields }` or `{ ok: false, error }` — never throws, and
 * never partially applies: a caller that gets `ok: false` must write nothing,
 * because a half-normalised list is exactly the model/table divergence this
 * module exists to prevent.
 *
 * @param {Array} incoming            the client's full column list
 * @param {Array} [existing]          the stored fields for this table, for identity matching
 * @returns {{ok: true, fields: Array}|{ok: false, error: string}}
 */
function normalizeFields(incoming, existing = []) {
    if (!Array.isArray(incoming)) return { ok: false, error: 'Send the full column list' };
    if (incoming.length > DATA_LIMITS.MAX_FIELDS_PER_TABLE) {
        return { ok: false, error: `A table may have at most ${DATA_LIMITS.MAX_FIELDS_PER_TABLE} columns` };
    }

    const prior = Array.isArray(existing) ? existing.filter(f => f && typeof f === 'object') : [];
    const byId = new Map(prior.filter(f => typeof f.id === 'string').map(f => [f.id, f]));
    const byKey = new Map(prior.filter(f => typeof f.key === 'string').map(f => [f.key, f]));

    const usedKeys = new Set();
    const usedIds = new Set();
    const fields = [];

    for (const raw of incoming) {
        if (!raw || typeof raw !== 'object') return { ok: false, error: 'Every column must be an object' };

        const key = String(raw.key || '').trim();
        if (!KEY_RE.test(key)) {
            return { ok: false, error: `"${key || '(empty)'}" is not a valid column key — lowercase letters, numbers and underscores, starting with a letter` };
        }
        if (RESERVED_KEY_PREFIX_RE.test(key)) {
            return { ok: false, error: `"${key}" starts with a prefix the database reserves for itself` };
        }
        if (SYSTEM_COLUMNS.includes(key)) {
            return { ok: false, error: `Every table already has a "${key}" column — choose another name` };
        }
        if (usedKeys.has(key)) return { ok: false, error: `Two columns both use the key "${key}"` };
        usedKeys.add(key);

        const type = String(raw.type || '').trim();
        if (!DATATABLE_FIELD_TYPES.includes(type)) {
            return { ok: false, error: `"${key}" has an unsupported column type${type ? ` ("${type}")` : ''}` };
        }

        // Identity: the caller's own id if it is one we issued and have not
        // already used in this list, else the stored field with the same key,
        // else a fresh one. Key-matching is what keeps a client that never
        // learned about ids from turning every save into a drop-and-recreate.
        let id = null;
        if (typeof raw.id === 'string' && FIELD_ID_RE.test(raw.id) && byId.has(raw.id) && !usedIds.has(raw.id)) {
            id = raw.id;
        } else if (byKey.has(key) && !usedIds.has(byKey.get(key).id) && typeof byKey.get(key).id === 'string') {
            id = byKey.get(key).id;
        } else if (typeof raw.id === 'string' && FIELD_ID_RE.test(raw.id) && !usedIds.has(raw.id)) {
            // An id we have not seen before but that is well-formed: honour it
            // so an export/import round trip keeps its identities.
            id = raw.id;
        } else {
            do { id = newFieldId(); } while (usedIds.has(id));
        }
        usedIds.add(id);

        const field = {
            id,
            key,
            name: String(raw.name || key).trim().slice(0, DATA_LIMITS.MAX_NAME_LEN) || key,
            type,
        };
        if (type === 'select' || type === 'multiselect') {
            field.options = normalizeOptions(raw.options);
            if (!field.options.length) {
                return { ok: false, error: `"${key}" is a list column, so it needs at least one option` };
            }
        }
        if (raw.required === true) field.required = true;
        if (raw.unique === true) field.unique = true;

        fields.push(field);
    }

    return { ok: true, fields };
}

/**
 * Backfill ids on a model read out of the database.
 *
 * Tables created before this module existed carry id-less fields, and those
 * rows are already wrong in the database — their columns were never created.
 * Backfilling here means the next save produces a plan that ADDS them, which
 * is the repair. Returns `{ model, changed }` so a caller can skip the write
 * when there was nothing to fix.
 */
function backfillModelFieldIds(model) {
    const src = (model && typeof model === 'object') ? model : {};
    const tables = Array.isArray(src.tables) ? src.tables : [];
    let changed = false;
    const next = {
        ...src,
        tables: tables.map((t) => {
            if (!t || typeof t !== 'object') return t;
            const fields = Array.isArray(t.fields) ? t.fields : [];
            const seen = new Set(fields.filter(f => typeof f?.id === 'string').map(f => f.id));
            return {
                ...t,
                fields: fields.map((f) => {
                    if (!f || typeof f !== 'object') return f;
                    if (typeof f.id === 'string' && FIELD_ID_RE.test(f.id)) return f;
                    let id;
                    do { id = newFieldId(); } while (seen.has(id));
                    seen.add(id);
                    changed = true;
                    return { ...f, id };
                }),
            };
        }),
    };
    return { model: changed ? next : src, changed };
}

module.exports = {
    normalizeFields,
    backfillModelFieldIds,
    retentionFieldError,
    DATATABLE_FIELD_TYPES,
    RETENTION_SYSTEM_FIELDS,
    FIELD_ID_RE,
};
