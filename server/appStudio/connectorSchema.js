/**
 * App Studio — CONNECTOR SHAPE DETECTION.
 *
 * Everything here answers one question: "given what this connector actually
 * returned (and what its action declares), what can we set up for the author
 * WITHOUT asking them?" It is the module behind the promise that materialising
 * a connector into a table is one click rather than a form:
 *
 *   • which columns should the table have          → inferFields / proposeTable
 *   • which field identifies a row (upsert key)    → detectIdentity
 *   • which field says when a row last changed     → detectWatermark
 *   • can the ACTION itself filter by that         → detectSinceParam
 *   • which action can supply a required param     → suggestChain
 *
 * Pure and I/O-free by construction: every function takes plain data (sample
 * rows, a JSON-Schema `inputSchema`, catalog action descriptors) and returns
 * plain data. The one caller that does I/O is the /inspect route, which runs the
 * connector once and feeds the sample in here. Keeping it pure is what lets the
 * FE render a proposal it never has to re-derive — the picker, the table
 * proposal and the sync engine all read ONE detection result, so they cannot
 * drift apart.
 *
 * ── INCREMENTAL TIERS ───────────────────────────────────────────────
 * The tier is a fact about the data, not a setting. The UI only ever offers
 * incremental loading when the tier is not 'none':
 *
 *   'request' — the action accepts a since-param (`updatedAfter`, `since`, …).
 *               We pass the stored watermark and the upstream returns only what
 *               changed. Cheapest: fewer rows AND fewer bytes over the wire.
 *   'client'  — no such param, but rows carry a last-changed field. We still
 *               fetch everything, but only WRITE rows newer than the watermark.
 *               Saves database churn and row-version bumps, not API calls — and
 *               the UI says so rather than implying a saving that isn't there.
 *   'none'    — nothing recognisable. Full refresh only.
 *
 * ── WHY HEURISTICS AND NOT A REGISTRY ───────────────────────────────
 * server/automation/outputSchemas.js declares shapes for ~90 of the ~400 tools;
 * vPlan, AFAS, NMBRS, Fireflies, GitHub reads and the whole Nextcloud family
 * have no entry. A registry would therefore fail for exactly the integrations an
 * owner is most likely to wire up by hand. A live sample is always available (we
 * just ran the thing), so detection reads the sample first and treats declared
 * schemas as a bonus. Every guess is shown to the author before it is used.
 */

'use strict';

const { FIELD_TYPES, KEY_RE, DATA_LIMITS, SYSTEM_COLUMNS, newTableId, newFieldId } = require('./dataModel');
// The "which key identifies one item" heuristic is shared with the poll_diff
// trigger runtime rather than duplicated — same question, different consumer.
const { ID_CANDIDATES } = require('../automation/triggerSources/pollDiff');

// How many sample rows detection ever looks at. A connector run is capped at 500
// rows; scanning them all to guess a column type buys nothing over the first
// handful, and inference must stay cheap enough to run inside a request.
const SAMPLE_ROWS = 25;
// Ceiling on inferred columns. Below MAX_FIELDS_PER_TABLE so a wide upstream
// payload proposes a usable table instead of failing model validation.
const MAX_INFERRED_FIELDS = 60;
// Nested objects/arrays are stored as JSON text; anything deeper than this is
// not worth a column of its own.
const MAX_SCAN_DEPTH = 2;

// Field names that read like "when did this last change", best first. Ordered:
// an explicit update stamp beats a generic timestamp, and created_at comes LAST
// because it only works as a watermark for append-only sources.
const WATERMARK_CANDIDATES = [
    'updated_at', 'updatedAt', 'modifiedTime', 'lastModified', 'last_modified',
    'lastModifiedDateTime', 'modified_at', 'modifiedAt', 'updated', 'modified',
    // Withings names its change stamp `lastupdate` on both sides of the call —
    // it is a response field AND the request parameter below.
    'lastupdate', 'last_update', 'lastUpdate',
    'changed_at', 'changedAt', 'edited_at', 'editedAt', 'last_changed', 'lastChanged',
    'datetime', 'timestamp', 'date', 'created_at', 'createdAt', 'created',
];

// Input-parameter names that mean "only give me things changed since X".
const SINCE_PARAM_CANDIDATES = [
    'since', 'updatedAfter', 'updated_after', 'updatedSince', 'updated_since',
    'modifiedSince', 'modified_since', 'modifiedAfter', 'modified_after',
    // Withings' incremental parameter. Declared as an integer, so detectSinceParam
    // resolves it to format 'unix' (epoch seconds) — which is what the API wants.
    'lastupdate', 'last_update', 'lastUpdate',
    'changedSince', 'changed_since', 'startAt', 'start_at', 'startTime', 'start_time',
    'from', 'after',
];

// Parameters that LOOK like a watermark but are really page cursors. Passing a
// stored watermark into one of these would silently paginate from a stale
// offset — worse than no incremental loading, because it looks like it works.
const CURSOR_PARAM_NAMES = new Set([
    'pagetoken', 'page_token', 'cursor', 'nextcursor', 'next_cursor',
    'nextpagetoken', 'next_page_token', 'offset', 'page', 'continuationtoken',
]);
const CURSOR_DESCRIPTION_RE = /\b(cursor|pagination|paginate|page token|next page|opaque)\b/i;

// ── small shape helpers ─────────────────────────────────────────────

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function objectRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.filter(isPlainObject).slice(0, SAMPLE_ROWS);
}

/**
 * An ISO-8601-ish timestamp? Deliberately strict about the SHAPE rather than
 * trusting Date.parse: `Date.parse('2')` is a valid date in V8, so a plain
 * counter column would otherwise be proposed as a watermark and every sync would
 * compare integers as dates.
 */
function looksLikeTimestamp(value) {
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    if (typeof value === 'number') {
        // Unix seconds or millis, from 2001 to ~2100. Narrow on purpose — a row
        // count or an id must never read as a date.
        return Number.isFinite(value)
            && ((value > 1_000_000_000 && value < 4_102_444_800)
                || (value > 1_000_000_000_000 && value < 4_102_444_800_000));
    }
    if (typeof value !== 'string') return false;
    const s = value.trim();
    if (s.length < 8 || s.length > 40) return false;
    if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(s)) return false;
    return !Number.isNaN(Date.parse(s));
}

/** A timestamp as a comparable ISO string, or null when it isn't one. */
function toIsoStamp(value) {
    if (!looksLikeTimestamp(value)) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'number') {
        const ms = value > 1_000_000_000_000 ? value : value * 1000;
        return new Date(ms).toISOString();
    }
    const t = Date.parse(String(value).trim());
    return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * A source field name → a legal table column key (dataModel KEY_RE: lowercase,
 * starts with a letter, ≤63 chars). `modifiedTime` → `modified_time`,
 * `Total $` → `total`. Mirrors the FE's slugifyKey so a column proposed here
 * matches what the designer would have produced by hand.
 */
function slugifyKey(name) {
    const snake = String(name ?? '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .toLowerCase()
        .replace(/^_+|_+$/g, '');
    let key = snake.replace(/^[^a-z]+/, '');
    if (!key) return '';
    key = key.slice(0, 63).replace(/_+$/g, '');
    return KEY_RE.test(key) ? key : '';
}

/**
 * A column key that is free to use.
 *
 * Two things can be in the way, and they are not the same problem:
 *
 *   • a SYSTEM COLUMN — `id`, `created_at`, `updated_at`, `created_by`, `org_id`
 *     exist on every App Studio table and are server-managed. Almost every
 *     upstream list has an `id`, so without this a proposed table is rejected by
 *     validateDataModel and the author cannot save AT ALL. It gets the readable
 *     `source_` prefix rather than a counter, because `source_id` says what it is
 *     ("the id the source gave us") where `id_2` says nothing.
 *   • a SIBLING column already using the key (`author.id` after `authorId`) —
 *     that is genuine ambiguity between two upstream fields, so it keeps the
 *     numeric ladder.
 *
 * `taken` is mutated: callers mint keys in a loop and every mint must be visible
 * to the next one.
 */
function availableKey(candidate, taken) {
    let key = candidate;
    if (SYSTEM_COLUMNS.includes(key)) key = slugifyKey(`source_${key}`) || `${key}_col`;
    if (taken.has(key) || SYSTEM_COLUMNS.includes(key)) {
        const base = key;
        let n = 2;
        while (taken.has(`${base}_${n}`) || SYSTEM_COLUMNS.includes(`${base}_${n}`)) n += 1;
        key = `${base}_${n}`;
    }
    taken.add(key);
    return key;
}

// ── field inference ─────────────────────────────────────────────────

/**
 * The dataModel field type that best holds `value`. Only the types a connector
 * can actually produce are considered — no relation/file/computed, which are
 * authoring concepts with no counterpart in an upstream payload.
 */
function typeOfValue(value) {
    if (value === null || value === undefined) return null;   // no evidence yet
    if (typeof value === 'boolean') return 'bool';
    if (typeof value === 'number') return Number.isFinite(value) ? 'number' : null;
    if (value instanceof Date) return 'datetime';
    if (Array.isArray(value) || isPlainObject(value)) return 'text';  // stored as JSON text
    if (typeof value === 'string') {
        if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return 'date';
        if (looksLikeTimestamp(value)) return 'datetime';
        return 'text';
    }
    return 'text';
}

// Merge the types seen across rows. Conflicts widen to the type that can hold
// everything: a column that is a number in one row and a string in the next is
// text, because a sync must never fail on row 400 of 500.
function mergeTypes(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (a === b) return a;
    if ((a === 'date' && b === 'datetime') || (a === 'datetime' && b === 'date')) return 'datetime';
    return 'text';
}

/**
 * Infer table fields from sample rows.
 *
 * Returns [{ key, name, type, sourcePath, subtype? }] where `sourcePath` is the
 * ORIGINAL key on the upstream row (`modifiedTime`) and `key` is the column
 * (`modified_time`) — the sync engine needs both to map a row onto columns.
 *
 * Nested objects are flattened one level (`author.email` → `author_email`)
 * because that is where most useful scalars hide; anything deeper, and any
 * array, becomes JSON text under its own column.
 */
function inferFields(rows) {
    const sample = objectRows(rows);
    if (!sample.length) return [];

    const acc = new Map(); // sourcePath → { key, name, type, seen }

    const visit = (obj, prefix, depth) => {
        for (const [rawKey, value] of Object.entries(obj)) {
            if (rawKey.startsWith('_')) continue;             // runtime metadata (_error, …)
            const sourcePath = prefix ? `${prefix}.${rawKey}` : rawKey;
            // One level down into plain objects; arrays and deeper objects are JSON.
            if (isPlainObject(value) && depth < MAX_SCAN_DEPTH) {
                visit(value, sourcePath, depth + 1);
                continue;
            }
            const type = typeOfValue(value);
            const key = slugifyKey(sourcePath.replace(/\./g, '_'));
            if (!key) continue;
            const prev = acc.get(sourcePath);
            if (prev) {
                prev.type = mergeTypes(prev.type, type);
                if (value !== null && value !== undefined) prev.seen += 1;
            } else {
                acc.set(sourcePath, {
                    key,
                    name: rawKey,
                    type,
                    sourcePath,
                    seen: value === null || value === undefined ? 0 : 1,
                });
            }
        }
    };

    for (const row of sample) visit(row, '', 1);

    // Columns whose every sample value was null carry no type evidence — keep
    // them as text rather than dropping them: the field exists upstream, it just
    // happened to be empty in this sample.
    const fields = [];
    const takenKeys = new Set();
    for (const entry of acc.values()) {
        // Renames the reserved names (`id` → `source_id`) and resolves sibling
        // collisions (`author.id` after `authorId`). Only the COLUMN key moves —
        // `sourcePath` still says `id`, which is what the sync engine maps on and
        // what sync.keyField stores, and `name` still reads "id" to the author.
        const key = availableKey(entry.key, takenKeys);
        const type = entry.type || 'text';
        fields.push({
            key,
            name: entry.name,
            type,
            sourcePath: entry.sourcePath,
            ...(type === 'number' ? { subtype: 'decimal' } : {}),
        });
        if (fields.length >= MAX_INFERRED_FIELDS) break;
    }
    return fields;
}

// ── identity + watermark ────────────────────────────────────────────

/**
 * Which field identifies one row? Used as the UPSERT key, so it must be present
 * and distinct across the sample — a "key" that repeats would collapse rows into
 * each other on every sync. Returns the field (from inferFields) or null.
 */
function detectIdentity(rows, fields) {
    const sample = objectRows(rows);
    if (!sample.length || !Array.isArray(fields) || !fields.length) return null;

    const byPath = new Map(fields.map((f) => [f.sourcePath, f]));

    const usableAs = (path) => {
        const field = byPath.get(path);
        if (!field || field.type === 'bool') return false;
        const seen = new Set();
        for (const row of sample) {
            const v = readPath(row, path);
            if (v === null || v === undefined || v === '') return false;   // must always be present
            if (typeof v === 'object') return false;                        // must be scalar
            if (seen.has(String(v))) return false;                          // must be distinct
            seen.add(String(v));
        }
        return true;
    };

    for (const candidate of ID_CANDIDATES) {
        if (byPath.has(candidate) && usableAs(candidate)) return byPath.get(candidate);
    }
    // Nothing well-known — take the first field that behaves like a key anyway.
    for (const field of fields) {
        if (usableAs(field.sourcePath)) return field;
    }
    return null;
}

/**
 * Which field says when a row last changed? Name candidates in priority order,
 * but a name only counts when the SAMPLE actually parses as a timestamp — an
 * upstream `date: 'every monday'` must not become a watermark.
 */
function detectWatermark(fields, rows) {
    const sample = objectRows(rows);
    if (!Array.isArray(fields) || !fields.length) return null;
    const byPath = new Map(fields.map((f) => [f.sourcePath, f]));

    const parses = (path) => {
        let sawValue = false;
        for (const row of sample) {
            const v = readPath(row, path);
            if (v === null || v === undefined || v === '') continue;
            if (!looksLikeTimestamp(v)) return false;
            sawValue = true;
        }
        return sawValue;
    };

    for (const candidate of WATERMARK_CANDIDATES) {
        if (byPath.has(candidate) && parses(candidate)) return byPath.get(candidate);
    }
    // Case/shape-insensitive second pass (`Updated_At`, `lastmodified`).
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
    const wanted = new Set(WATERMARK_CANDIDATES.map(norm));
    for (const field of fields) {
        if (wanted.has(norm(field.sourcePath)) && parses(field.sourcePath)) return field;
    }
    return null;
}

/** Read a dotted source path off a row; own-props only, no proto walk. */
function readPath(row, path) {
    if (!isPlainObject(row) || typeof path !== 'string') return undefined;
    let cur = row;
    for (const seg of path.split('.')) {
        if (!isPlainObject(cur) || !Object.hasOwn(cur, seg)) return undefined;
        cur = cur[seg];
    }
    return cur;
}

/**
 * Does this action accept a "only things changed since X" parameter? Reads the
 * action's JSON-Schema `inputSchema`. Returns { param, format } or null.
 *
 * `format` tells the sync engine how to render the stored watermark:
 *   'iso'   — an ISO-8601 string (the default for string params)
 *   'unix'  — seconds since epoch (integer params)
 *   'date'  — YYYY-MM-DD (the param says so, e.g. a date-only filter)
 *
 * Pagination cursors are refused: passing a watermark into `pageToken` would
 * resume from a stale offset while looking like it worked.
 */
function detectSinceParam(inputSchema) {
    const props = (inputSchema && isPlainObject(inputSchema.properties)) ? inputSchema.properties : null;
    if (!props) return null;

    const entries = Object.entries(props);
    const pick = (name) => {
        const schema = props[name];
        if (!isPlainObject(schema)) return null;
        if (CURSOR_PARAM_NAMES.has(name.toLowerCase())) return null;
        const description = typeof schema.description === 'string' ? schema.description : '';
        if (CURSOR_DESCRIPTION_RE.test(description)) return null;
        const type = schema.type;
        if (type === 'integer' || type === 'number') return { param: name, format: 'unix' };
        if (type !== 'string' && type !== undefined) return null;
        if (/\bYYYY-MM-DD\b/.test(description) && !/\bHH:MM\b/i.test(description)) {
            return { param: name, format: 'date' };
        }
        return { param: name, format: 'iso' };
    };

    for (const candidate of SINCE_PARAM_CANDIDATES) {
        if (Object.hasOwn(props, candidate)) {
            const hit = pick(candidate);
            if (hit) return hit;
        }
    }
    // Case-insensitive second pass over the declared params.
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
    const wanted = new Set(SINCE_PARAM_CANDIDATES.map(norm));
    for (const [name] of entries) {
        if (wanted.has(norm(name))) {
            const hit = pick(name);
            if (hit) return hit;
        }
    }
    return null;
}

/**
 * The incremental tier for one action + sample. See the header for what each
 * tier costs. `field` is the row field carrying the last-changed stamp; `param`
 * is the request-side parameter, present only for the 'request' tier.
 */
function detectIncremental(inputSchema, fields, rows) {
    const watermark = detectWatermark(fields, rows);
    if (!watermark) return { mode: 'none', field: null, param: null, format: null };
    const since = detectSinceParam(inputSchema);
    if (since) {
        return { mode: 'request', field: watermark.sourcePath, param: since.param, format: since.format };
    }
    return { mode: 'client', field: watermark.sourcePath, param: null, format: 'iso' };
}

// ── chaining: which action supplies a missing parameter ─────────────

/** The required parameter names of an action's inputSchema. */
function requiredParams(inputSchema) {
    if (!isPlainObject(inputSchema)) return [];
    const required = Array.isArray(inputSchema.required) ? inputSchema.required : [];
    return required.filter((k) => typeof k === 'string' && k);
}

// Every scalar-ish field name an action is known to produce — from its declared
// output sample when it has one, else from a live sample we were handed.
function producedFieldNames(action, liveRows) {
    const names = new Set();
    const harvest = (obj, prefix, depth) => {
        if (!isPlainObject(obj) || depth > MAX_SCAN_DEPTH) return;
        for (const [k, v] of Object.entries(obj)) {
            if (k.startsWith('_')) continue;
            const path = prefix ? `${prefix}.${k}` : k;
            if (Array.isArray(v)) {
                const first = v.find(isPlainObject);
                if (first) harvest(first, `${path}[]`, depth + 1);
                else names.add(path);
            } else if (isPlainObject(v)) {
                harvest(v, path, depth + 1);
            } else {
                names.add(path);
            }
        }
    };

    for (const row of objectRows(liveRows)) harvest(row, '', 1);

    const sample = action && action.outputSample;
    if (Array.isArray(sample)) {
        const first = sample.find(isPlainObject);
        if (first) harvest(first, '', 1);
    } else if (isPlainObject(sample)) {
        // Declared samples wrap rows in an envelope ({ results: [...] }); the
        // interesting names are on the ITEMS, not the envelope.
        for (const [k, v] of Object.entries(sample)) {
            if (Array.isArray(v)) {
                const first = v.find(isPlainObject);
                if (first) harvest(first, '', 1);
            } else if (isPlainObject(v)) {
                harvest(v, k, 1);
            } else {
                names.add(k);
            }
        }
    }
    return [...names];
}

// Normalise a parameter/field name for matching: `messageId`, `message_id` and
// `MESSAGEID` are the same thing to a human, so they are here too.
function normName(s) {
    return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Would `fieldName` plausibly fill `paramName`? Exact match, then the common
// "<thing>Id ← the thing's own id" shape that every REST API uses.
function paramMatchesField(paramName, fieldName) {
    const p = normName(paramName);
    const leaf = String(fieldName).split(/[.[]/).filter(Boolean).pop();
    const f = normName(leaf);
    if (!p || !f) return false;
    if (p === f) return true;
    // messageId ← id  (on an action whose rows ARE messages)
    if (p.endsWith('id') && f === 'id') return true;
    // messageId ← messageId nested somewhere, or message_id ← messageid
    if (p === f.replace(/s$/, '') || p.replace(/s$/, '') === f) return true;
    // attachmentId ← attachments[].id  →  leaf is 'id', handled above; also
    // allow the full path to carry the noun: attachments[].attachmentId
    if (f.endsWith(p) || p.endsWith(f)) return f.length > 2 && p.length > 2;
    return false;
}

/**
 * For an action the author wants to run, work out which of its REQUIRED
 * parameters cannot be satisfied from what they already have, and which sibling
 * action of the same app could supply each one.
 *
 * This is what turns "gmail_read failed" into "gmail read needs a messageId —
 * gmail search gives one as `id`".
 *
 *   action          — the catalog action being configured
 *   available       — { fields, fixedArgs, viewerParams } already at hand
 *   siblings        — the other catalog actions of the same app
 *   liveSamples     — optional { [toolName]: rows } from earlier /inspect runs
 *
 * Returns { missing: [param], suggestions: [{ param, tool, label, field, why }] }.
 */
function suggestChain(action, available = {}, siblings = [], liveSamples = {}) {
    const fields = Array.isArray(available.fields) ? available.fields : [];
    const fixedArgs = isPlainObject(available.fixedArgs) ? available.fixedArgs : {};
    const viewerParams = Array.isArray(available.viewerParams) ? available.viewerParams : [];

    const haveKeys = new Set([
        ...Object.keys(fixedArgs),
        ...viewerParams.map((p) => (isPlainObject(p) ? p.key : p)).filter(Boolean),
    ].map(normName));
    const haveFields = fields.map((f) => f.sourcePath || f.key).filter(Boolean);

    const missing = [];
    const suggestions = [];

    for (const param of requiredParams(action?.inputSchema)) {
        if (haveKeys.has(normName(param))) continue;
        // Already fillable from the rows we have → a chain step binds it directly.
        const fromCurrent = haveFields.find((f) => paramMatchesField(param, f));
        if (fromCurrent) {
            suggestions.push({
                param,
                tool: null,
                label: null,
                field: fromCurrent,
                why: `takes ${param} from the ${fromCurrent} of each row`,
            });
            continue;
        }
        missing.push(param);
        for (const sibling of siblings) {
            if (!sibling || sibling.name === action?.name) continue;
            if (sibling.sideEffect) continue;     // never propose a WRITE as a lookup
            const produced = producedFieldNames(sibling, liveSamples[sibling.name]);
            const field = produced.find((f) => paramMatchesField(param, f));
            if (!field) continue;
            const siblingLabel = sibling.label || sibling.name;
            const actionLabel = action?.label || action?.name || 'this action';
            suggestions.push({
                param,
                tool: sibling.name,
                label: siblingLabel,
                field,
                why: `${actionLabel} needs ${param} — ${siblingLabel} gives one as \`${field}\``,
            });
            break;   // one suggestion per parameter; the author can change it
        }
    }

    return { missing, suggestions };
}

// ── the table proposal ──────────────────────────────────────────────

/**
 * A ready-to-insert model.tables[] entry for a connector's rows.
 *
 * The identity column is emitted `unique: true`, which makes the generated DDL
 * create a unique index on it: that is both the fast path for upsert lookups and
 * a hard guard against the same upstream record landing twice.
 *
 * Returns { table, keyField } — `keyField` is the SOURCE path of the identity
 * (what sync stores), and table.fields carry `sourcePath` so the sync engine can
 * map a row onto columns without re-inferring anything.
 */
function proposeTable(name, fields, identity, existingKeys = []) {
    const taken = new Set(existingKeys);
    let key = slugifyKey(name) || 'connector_data';
    if (taken.has(key)) {
        let n = 2;
        while (taken.has(`${key}_${n}`)) n += 1;
        key = `${key}_${n}`;
    }

    const identityPath = identity ? identity.sourcePath : null;
    const capped = fields.slice(0, Math.min(MAX_INFERRED_FIELDS, DATA_LIMITS.MAX_FIELDS_PER_TABLE));

    return {
        table: {
            id: newTableId(),
            key,
            name: String(name || 'Connector data').slice(0, DATA_LIMITS.MAX_NAME_LEN),
            fields: capped.map((f) => ({
                id: newFieldId(),
                key: f.key,
                name: f.name,
                type: FIELD_TYPES.includes(f.type) ? f.type : 'text',
                ...(f.subtype ? { subtype: f.subtype } : {}),
                // The identity column is unique (→ a unique index, which is both
                // the upsert lookup path and a duplicate guard) but NOT required:
                // a later row that arrives without it should land as a plain
                // insert, not fail the whole sync.
                ...(f.sourcePath === identityPath ? { unique: true } : {}),
                sourcePath: f.sourcePath,
            })),
        },
        keyField: identityPath,
    };
}

/**
 * A chain that EXPANDS produces two kinds of thing, not one.
 *
 * "Search my mail, read each message, then take each attachment" ends with one
 * row per attachment — the messages themselves are gone from the flat output.
 * Storing that as a single table would duplicate every message field once per
 * attachment and lose the messages that have none. What the data actually is, is
 * two related tables.
 *
 * So: one table per GRAIN (the runner reports them; a grain opens at every
 * expand step), joined by a `relation` column on the child. The join is by the
 * parent's record id, resolved at write time from the positional link the runner
 * stamped — never by matching a column name, which would break the moment an
 * expanded element happened to carry the same key as its parent.
 *
 * @param {object[]} grains  from runConnector(..., { trace: true })
 * @returns {{ tables, primary, children, incremental, defaultMode }}
 */
function proposeTableSet(grains, { name = 'Connector data', inputSchema = null, existingKeys = [] } = {}) {
    const list = (Array.isArray(grains) ? grains : []).filter((g) => g && Array.isArray(g.rows));
    if (!list.length) return null;

    const taken = [...existingKeys];
    const out = [];

    for (const [i, grain] of list.entries()) {
        const fields = inferFields(grain.rows);
        const identity = detectIdentity(grain.rows, fields);
        // A child table is named after what it holds ("attachments"), the parent
        // after the connector.
        const grainName = i === 0
            ? name
            : `${name} — ${String(grain.expandFrom || grain.tool || `step ${i}`).replace(/_/g, ' ')}`;
        const { table, keyField } = proposeTable(grainName, fields, identity, taken);
        taken.push(table.key);

        const parent = i > 0 ? out[grain.parentLevel ?? i - 1] : null;
        if (parent) {
            // The join column. dataModel emits a real FOREIGN KEY for a same-db
            // relation, so the database enforces it too.
            table.fields.unshift({
                id: newFieldId(),
                key: relationKeyFor(parent.table.key, table.fields),
                name: `${parent.table.name} record`,
                type: 'relation',
                relation: { table: parent.table.id },
            });
        }

        out.push({
            table,
            keyField,
            identity: identity ? identity.sourcePath : null,
            defaultMode: identity ? 'upsert' : 'replace',
            level: i,
            parentLevel: parent ? (grain.parentLevel ?? i - 1) : null,
            relationField: parent ? table.fields[0].key : null,
            // Present only when the grain was opened by an EXPAND. A step kept in
            // its own table is one child row per parent row, and saying "one row
            // per <field>" about it would be wrong — so the absence is the signal.
            expandFrom: grain.expandFrom || null,
            tool: grain.tool || null,
            rowCount: grain.rows.length,
        });
    }

    const [primary, ...children] = out;
    return {
        tables: out,
        primary,
        children,
        // Freshness is a property of the SOURCE list, so it is read off the
        // primary grain; children ride along with their parent's refresh.
        incremental: detectIncremental(inputSchema, inferFields(list[0].rows), list[0].rows),
        defaultMode: primary.defaultMode,
    };
}

// A relation column key that can't collide with an inferred one — nor with a
// system column, which a parent table keyed `org` would otherwise produce.
function relationKeyFor(parentTableKey, fields) {
    const base = slugifyKey(`${parentTableKey}_ref`) || 'parent_ref';
    return availableKey(base, new Set((fields || []).map((f) => f.key)));
}

/**
 * The whole proposal for one connector run, as the /inspect route returns it and
 * the FE renders it. One call, one truth.
 */
function inspectRows(rows, { name = 'Connector data', inputSchema = null, existingKeys = [] } = {}) {
    const fields = inferFields(rows);
    const identity = detectIdentity(rows, fields);
    const incremental = detectIncremental(inputSchema, fields, rows);
    const { table, keyField } = proposeTable(name, fields, identity, existingKeys);
    return {
        fields,
        identity: identity ? identity.sourcePath : null,
        incremental,
        suggestedTable: table,
        keyField,
        // Without an identity there is nothing to upsert ON, so a refresh can
        // only replace the table wholesale. Said here rather than left for the
        // sync engine to discover at 3am.
        defaultMode: identity ? 'upsert' : 'replace',
    };
}

module.exports = {
    proposeTableSet,
    inferFields,
    detectIdentity,
    detectWatermark,
    detectSinceParam,
    detectIncremental,
    suggestChain,
    proposeTable,
    inspectRows,
    // Exported for the sync engine and for tests.
    slugifyKey,
    availableKey,
    readPath,
    toIsoStamp,
    looksLikeTimestamp,
    requiredParams,
    producedFieldNames,
    paramMatchesField,
    SAMPLE_ROWS,
    MAX_INFERRED_FIELDS,
    WATERMARK_CANDIDATES,
    SINCE_PARAM_CANDIDATES,
};
