/**
 * Pure display + validation helpers for the Datatables section.
 *
 * Separate from the components so the rules a person is judged by — what a
 * column key may be, what "shared" actually means, whether a change to the
 * columns will THROW DATA AWAY — are testable without mounting anything, and
 * so a single place answers them for the designer, the row browser and the
 * sharing panel alike.
 */

import { DEFINITION_MANAGED_KINDS } from './formAnswers';
import { isSourceMirror, SOURCE_MANAGED_KINDS, sourceWritable } from './sourceMirrors';
// The BUILDER's humaniser, not a second one. Same argument ColumnKind.jsx
// makes for borrowing FieldKindIcon: a datatable column and a step's output
// field are the same idea to the person reading them, and two humanisers
// would eventually call `from_email` different things on two screens.
import { humanizeFieldKey } from '../../../automation/Builder/flow/displayHelpers';

// ── The three audiences ─────────────────────────────────────────────────────
// Same names as App Studio's publishAccessSummary (PRIVATE/ORG/GROUPS), and
// deliberately the same semantics, because the server's are shared too:
// `sharedGroups: []` on a PUBLISHED table means the ENTIRE ORGANISATION, not
// nobody (auth/audience.js). A picker that read the empty list as "no one yet"
// would show "nobody can see this" over a table the whole company can read.
export const PRIVATE = 'private';
export const ORG = 'org';
export const GROUPS = 'groups';

export function audienceOf(table) {
    if (!table || !table.isPublished) return PRIVATE;
    return (Array.isArray(table.sharedGroups) && table.sharedGroups.length) ? GROUPS : ORG;
}

/** ["a","b","c"] → "a, b and c" */
export function joinNames(names, t) {
    const list = (names || []).filter(Boolean);
    if (list.length <= 1) return list[0] || '';
    const head = list.slice(0, -1).join(', ');
    const last = list[list.length - 1];
    return t ? t('studio_misc.access.join_and', '{list} and {last}', { list: head, last }) : `${head} and ${last}`;
}

/**
 * One sentence naming who can READ the rows, and — separately — who can CHANGE
 * them. Two sentences because they are two columns on the server, and the
 * reason they are is that publishing a table must never be the thing that made
 * it writable by everyone.
 */
export function describeAccess(table, groupNames = new Map(), t = null) {
    const tr = (key, en, params) => (t ? t(key, en, params) : en.replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? '')));
    const audience = audienceOf(table);
    const readers = audience === PRIVATE
        ? tr('studio_misc.access.readers_private', 'Only you and the people you share it with')
        : audience === ORG
            ? tr('studio_misc.access.readers_org', 'Everyone in your organisation')
            : tr('studio_misc.access.readers_groups', 'Members of {names}', { names: joinNames((table.sharedGroups || []).map(g => groupNames.get(g) || g), t) });
    const writers = table?.writeMode === 'audience'
        ? (audience === PRIVATE ? tr('studio_misc.access.writers_same', 'the same people') : tr('studio_misc.access.writers_all', 'all of them'))
        : tr('studio_misc.access.writers_invited', 'only the people you invite');
    return { readers, writers, audience, broad: audience === ORG && table?.writeMode === 'audience' };
}

export const GRADE_LABEL = {
    owner: 'You own this table',
    editor: 'You can read and change rows',
    viewer: 'You can read rows',
};

export const GRADE_ORDER = { viewer: 0, editor: 1, owner: 2 };
export function gradeAtLeast(grade, min) {
    return (GRADE_ORDER[grade] ?? -1) >= (GRADE_ORDER[min] ?? 99);
}

// ── Columns ─────────────────────────────────────────────────────────────────

// Mirrors core/dataEngine/dataModel/vocabulary.FIELD_TYPES, minus the two a
// person cannot usefully author from here: `relation` needs a second table to
// point at, and `computed` needs the expression dialect. Offering either as an
// empty dropdown would be a promise the surface cannot keep.
export const COLUMN_TYPES = [
    { type: 'text', label: 'Text', blurb: 'A name, an e-mail address, a reference' },
    { type: 'number', label: 'Number', blurb: 'Amounts and counts you can compare' },
    { type: 'bool', label: 'Yes / no', blurb: 'A checkbox' },
    { type: 'date', label: 'Date', blurb: 'A day, with no time of day' },
    { type: 'datetime', label: 'Date and time', blurb: 'A moment' },
    { type: 'select', label: 'One of a list', blurb: 'Pick a single option you define' },
    { type: 'multiselect', label: 'Several of a list', blurb: 'Pick any number of options you define' },
    { type: 'richtext', label: 'Long text', blurb: 'Notes, a description, a message body' },
    { type: 'file', label: 'File', blurb: 'An attachment reference' },
];

/**
 * The column type a PERSON meets, as one of the builder's field kinds
 * (automation/Builder/mapping/fieldKinds.js).
 *
 * There are two vocabularies for the same idea and they are not going to
 * merge: the storage layer needs `richtext` apart from `text` (a different
 * Postgres column) and `datetime` apart from `date`, while a person choosing
 * a column wants the eight words the mapping panel already taught them. This
 * is the one-way bridge, and it lives here rather than in fieldKinds because
 * the datatable types are the ones being translated, not the kinds.
 *
 * `select` is why `choice` exists as a kind at all: "one of a list" is a
 * scalar with declared options, which is neither `text` (no options) nor
 * `list` (many values at once). `multiselect` IS a list — several of them.
 *
 * Unknown types answer 'unknown', never 'text': a type this build has not
 * heard of is not evidence of a string, and the icon says so.
 */
const COLUMN_TYPE_KIND = Object.freeze({
    text: 'text',
    richtext: 'text',
    number: 'number',
    bool: 'yesno',
    date: 'date',
    datetime: 'date',
    select: 'choice',
    multiselect: 'list',
    file: 'file',
    // Not OFFERED by the designer (COLUMN_TYPES above has no entry, and the
    // vocabulary test keeps it that way) but MET, on a table that mirrors a
    // Nextcloud table: a link to one row of another table. Reading it as
    // 'unknown' would put the "this build has not heard of it" glyph on a
    // column the platform itself wrote.
    relation: 'relation',
});

export function columnTypeKind(type) {
    return COLUMN_TYPE_KIND[type] || 'unknown';
}

// Mirrors vocabulary.KEY_RE exactly. Duplicated rather than imported because
// the client cannot import from server/. `datatableDisplay.vocabulary.test.js`
// READS server/core/dataEngine/dataModel/vocabulary.js and asserts the two
// agree, so the copy cannot drift into being more permissive — or, just as
// bad, into hiding a key the API would have accepted. (The neighbouring
// datatableDisplay.test.js does NOT do that: it re-declares the same literals
// inside itself, so it passes whatever either source happens to say.)
export const KEY_RE = /^[a-z][a-z0-9_]{0,62}$/;

// Mirrors vocabulary.SYSTEM_COLUMNS — every table already has these, so a
// column that claimed one would collide with a real column at DDL time.
export const SYSTEM_COLUMNS = ['id', 'created_at', 'updated_at', 'created_by', 'org_id'];

export const MAX_FIELDS_PER_TABLE = 100;
export const MAX_NAME_LEN = 120;

/** "Invoice date " → "invoice_date". Never produces an invalid key. */
export function keyFromName(name) {
    const slug = String(name || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 63);
    if (!slug) return '';
    return /^[a-z]/.test(slug) ? slug : `c_${slug}`.slice(0, 63);
}

/**
 * What to CALL a column on screen: its name, or its key made readable.
 *
 * `keyFromName` above is the forward trip — "Invoice date" becomes
 * `invoice_date`. Every screen here then rendered `c.name || c.key`, which is
 * fine for a column somebody typed a name for and wrong for every column that
 * arrived without one: an imported CSV, a Nextcloud or spreadsheet mirror, a
 * form-answers table, a column an automation created. Those have a key and no
 * name, so the studio showed people `contact_email` and `created_at` — the
 * database's spelling, in the one screen whose whole job is to make a table
 * readable to someone who does not think in databases.
 *
 * The builder stopped doing this (commit 31218f87, `humanizeFieldKey` in the
 * variable picker and the parameter rows); this is the same fix on the other
 * side of the same idea, using the same function rather than a second one.
 *
 * The exact key is never thrown away — it is what `columnKeyTitle` puts in the
 * tooltip, because whoever is writing `{{steps.x.output.contact_email}}` needs
 * the real spelling and should get it one hover away. The card shows the
 * sentence; the tooltip keeps the exact value.
 */
export function columnLabel(column) {
    const c = column && typeof column === 'object' ? column : {};
    const name = typeof c.name === 'string' ? c.name.trim() : '';
    if (name) return name;
    return humanizeFieldKey(c.key) || String(c.key || '');
}

/**
 * The tooltip beside a humanised label: the column's real key, and only when
 * it differs from what is shown. A tooltip that repeats the visible text is
 * noise, and a screen reader reads it twice.
 */
export function columnKeyTitle(column) {
    const c = column && typeof column === 'object' ? column : {};
    const key = String(c.key || '');
    return key && key !== columnLabel(c) ? key : undefined;
}

/**
 * Everything wrong with one proposed column list, as messages a person can act
 * on. Returns [] when the list is fine.
 */
export function validateColumns(fields) {
    const list = Array.isArray(fields) ? fields : [];
    const errors = [];
    const seen = new Set();
    if (list.length > MAX_FIELDS_PER_TABLE) {
        errors.push(`A table can have at most ${MAX_FIELDS_PER_TABLE} columns; this has ${list.length}.`);
    }
    for (const f of list) {
        const key = f?.key || '';
        const label = f?.name || key || 'a column';
        if (!key) { errors.push(`${label} needs a key.`); continue; }
        if (!KEY_RE.test(key)) {
            errors.push(`"${key}" is not a usable key — lowercase letters, numbers and underscores, starting with a letter.`);
        }
        if (SYSTEM_COLUMNS.includes(key)) {
            errors.push(`"${key}" is a column every table already has. Pick another name.`);
        }
        if (seen.has(key)) errors.push(`There is more than one column called "${key}".`);
        seen.add(key);
        if (!f?.type || !COLUMN_TYPES.some(t => t.type === f.type)) {
            errors.push(`${label} needs a type.`);
        }
        if ((f?.name || '').length > MAX_NAME_LEN) {
            errors.push(`${label}'s name is longer than ${MAX_NAME_LEN} characters.`);
        }
        if ((f?.type === 'select' || f?.type === 'multiselect') && !(f.options || []).length) {
            errors.push(`${label} is a list, so it needs at least one option.`);
        }
    }
    return errors;
}

/**
 * What saving `next` over `prev` would DESTROY.
 *
 * The migration planner drops a removed column and rewrites a retyped one, and
 * both are irreversible against live rows. A designer that saved silently
 * would be a delete button wearing a Save label, so the panel asks first — and
 * asks with the row count, because "this deletes a column" and "this deletes
 * 40,000 values" land very differently.
 */
export function destructiveChanges(prev, next) {
    const before = new Map((prev || []).map(f => [f.key, f]));
    const after = new Map((next || []).map(f => [f.key, f]));
    const removed = [...before.keys()].filter(k => !after.has(k));
    const retyped = [...after.entries()]
        .filter(([k, f]) => before.has(k) && before.get(k).type !== f.type)
        .map(([k, f]) => ({ key: k, from: before.get(k).type, to: f.type }));
    return { removed, retyped, any: removed.length > 0 || retyped.length > 0 };
}

/** A cell as text, without ever pretending an empty value is a real one. */
export function cellText(value, type) {
    if (value === null || value === undefined || value === '') return '—';
    if (type === 'bool') return value ? 'Yes' : 'No';
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

// ── Managed tables ──────────────────────────────────────────────────────────

/**
 * A table whose COLUMNS the platform owns — `managedKind` names the contract,
 * and it is null on the overwhelming majority of tables.
 *
 * Mirrors core/dataEngine/dataModel/managedTables.js. Duplicated rather than
 * imported for the same reason KEY_RE is (the client cannot require from
 * server/), and pinned the same way: datatableDisplay.vocabulary.test.js reads
 * the server file and asserts the two refuse the SAME edits.
 *
 * Drift in either direction is a real failure, which is why it is worth a test.
 * A designer that allows a drop the server refuses is a Save button that always
 * 409s; a designer that allows one the server would ACCEPT is a 500 at 3am
 * inside somebody's nightly automation, hit by the person who dropped the column
 * weeks after they did it.
 */
export const MANAGED_COLUMNS = {
    // Nothing fixed: EVERY column comes from the source — Nextcloud's table,
    // or a spreadsheet's header row — so the whole list is locked
    // (SOURCE_MANAGED_KINDS below) rather than a declared subset.
    nextcloud_table: [],
    spreadsheet_file: [],
    // The answers to a form: two fixed columns, the rest are the form's
    // questions (DEFINITION_MANAGED_KINDS) — locked as a whole, like a mirror.
    form_answers: [
        { key: 'run_id', type: 'text' },
        { key: 'completed_at', type: 'datetime' },
    ],
    // The cells of a spreadsheet document (docType 'spreadsheet'). One row per
    // sheet row: row_no is the 1-based row number, and a..z hold what was typed
    // in that column. Mirrors server/core/dataEngine/dataModel/managedTables.js
    // DOCUMENT_SHEET_FIELDS exactly.
    document_sheet: [
        { key: 'row_no', type: 'number', required: true, unique: true },
        { key: 'a', type: 'text' },
        { key: 'b', type: 'text' },
        { key: 'c', type: 'text' },
        { key: 'd', type: 'text' },
        { key: 'e', type: 'text' },
        { key: 'f', type: 'text' },
        { key: 'g', type: 'text' },
        { key: 'h', type: 'text' },
        { key: 'i', type: 'text' },
        { key: 'j', type: 'text' },
        { key: 'k', type: 'text' },
        { key: 'l', type: 'text' },
        { key: 'm', type: 'text' },
        { key: 'n', type: 'text' },
        { key: 'o', type: 'text' },
        { key: 'p', type: 'text' },
        { key: 'q', type: 'text' },
        { key: 'r', type: 'text' },
        { key: 's', type: 'text' },
        { key: 't', type: 'text' },
        { key: 'u', type: 'text' },
        { key: 'v', type: 'text' },
        { key: 'w', type: 'text' },
        { key: 'x', type: 'text' },
        { key: 'y', type: 'text' },
        { key: 'z', type: 'text' },
    ],
    http_cache: [
        { key: 'cache_key', type: 'text', required: true, unique: true },
        { key: 'request_host', type: 'text' },
        { key: 'request_path', type: 'text' },
        { key: 'request_method', type: 'text' },
        { key: 'response_status', type: 'number' },
        { key: 'response_body', type: 'text' },
        { key: 'response_headers', type: 'text' },
        { key: 'fetched_at', type: 'datetime' },
    ],
};

// The source-mirror vocabulary (SOURCE_MANAGED_KINDS, the kind predicates,
// provider names, {source} words, URLs, writability, the two refusal
// switches and the SOURCE_KINDS registry) lives in its own leaf and is
// re-exported here, so a consumer has ONE import path for "what is a table".
export * from './sourceMirrors';
// The form-answers vocabulary (DEFINITION_MANAGED_KINDS, isFormAnswers, the
// per-column hints) is the same kind of leaf.
export * from './formAnswers';

/**
 * A kind whose WHOLE column list is somebody else's — an external source's
 * (mirrors) or a form's (its questions). Nothing can be added, nothing
 * renamed, and a schema save is refused outright on both sides.
 */
export function isSchemaLocked(kind) {
    return SOURCE_MANAGED_KINDS.includes(kind) || DEFINITION_MANAGED_KINDS.includes(kind);
}

/** Is this column one the platform fills in, rather than the author's own? */
export function isManagedColumn(kind, key) {
    if (isSchemaLocked(kind)) return true;
    return (MANAGED_COLUMNS[kind] || []).some(f => f.key === key);
}

/**
 * May a person file an ad-hoc row into this table from elsewhere in the
 * product (a meeting's action item, say)? An ordinary table yes; a mirror
 * yes when it writes through — its columns are the person's own, and a
 * refusal comes back through the same error path — but NOT a read-only
 * file, where the row would have nowhere to go; a web-service cache no,
 * because its rows are somebody else's answers.
 */
export function acceptsAdHocRows(table) {
    return !table?.managedKind || (isSourceMirror(table) && sourceWritable(table));
}

/**
 * Can this account offer to link a Nextcloud table at all? One fact, from
 * the session: the organisation is bound to a Nextcloud instance. No feature
 * flag — linking is a capability of that connection. Whether THIS account may
 * actually read a given table (the Tables integration, its Nextcloud scope)
 * is the server's answer, which the card shows as its reason when it is no.
 */
export function canLinkNextcloud(user) {
    return !!user?.ncOrg?.instanceId;
}

/**
 * Which Studio KIND a table wears (shared/kindColors): an ordinary table is
 * a `datatable`, a web-service cache is an `app` — the artboard paints it in
 * `--type-app` with a globe, because what it holds is somebody else's
 * service, not your own rows. One place, so the list card, the header tile
 * and the create dialog cannot disagree.
 */
export function tableKindOf(table) {
    return table?.managedKind === 'http_cache' ? 'app' : 'datatable';
}

// ── Retention, as a person reads it ─────────────────────────────────────────

const DAY_MS = 86400000;

/**
 * When one ROW expires, from the table's window and the row's own date.
 *
 * Derived on the client because the server keeps no per-row expiry: the
 * sweep computes `<date column> + interval` at the moment it runs. So this
 * must use the SAME two inputs (`retentionDays`, `retentionField`) and
 * nothing else — a column picked here that the sweep does not use would put
 * a confident date next to a row that outlives it.
 *
 * Answers `null` when there is no window, no field, or the row's date is
 * missing or unparseable — never a guessed "today".
 *
 * @returns {{at: Date, days: number, overdue: boolean}|null} `days` is whole
 *   days from `now`, negative once the row is past due (the sweep runs on a
 *   schedule, so "expired" and "gone" are not the same moment).
 */
export function rowExpiry(row, { retentionDays, retentionField } = {}, now = Date.now()) {
    if (!row || !retentionDays || !retentionField) return null;
    const raw = row[retentionField];
    if (raw === null || raw === undefined || raw === '') return null;
    const from = new Date(raw);
    const ms = from.getTime();
    if (!Number.isFinite(ms)) return null;
    const at = new Date(ms + retentionDays * DAY_MS);
    return {
        at,
        days: Math.ceil((at.getTime() - now) / DAY_MS),
        overdue: at.getTime() <= now,
    };
}

/** The moment rows older than the window are already past due — an ISO string for a filter. */
export function retentionCutoffIso(retentionDays, now = Date.now()) {
    if (!retentionDays) return null;
    return new Date(now - retentionDays * DAY_MS).toISOString();
}

/**
 * The date BEFORE which a row is inside `withinDays` of expiring — the
 * "what is about to go" card. A row expires at `<field> + retentionDays`,
 * so it expires within the next `withinDays` when its field value is at or
 * before `now - (retentionDays - withinDays)` days.
 */
export function expiringSoonCutoffIso(retentionDays, withinDays, now = Date.now()) {
    if (!retentionDays || !withinDays) return null;
    return new Date(now - (retentionDays - withinDays) * DAY_MS).toISOString();
}

// ── Filters — the CLOSED descriptor, as choices ─────────────────────────────

/**
 * Mirrors the server's `vocabulary.FILTER_OPS`. Every operator a person can
 * pick is in that list; nothing here can invent one, and the server checks
 * again anyway (`readFilters` rejects an unknown op by name).
 */
export const FILTER_OPS = [
    'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
    'contains', 'notContains', 'startsWith', 'endsWith',
    'in', 'notIn', 'between', 'isNull', 'isNotNull',
];

const OPS_BY_KIND = Object.freeze({
    text: ['eq', 'neq', 'contains', 'notContains', 'startsWith', 'endsWith', 'in', 'notIn', 'isNull', 'isNotNull'],
    number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
    date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'],
    yesno: ['eq', 'neq', 'isNull', 'isNotNull'],
    choice: ['eq', 'neq', 'in', 'notIn', 'isNull', 'isNotNull'],
    list: ['contains', 'notContains', 'isNull', 'isNotNull'],
    file: ['isNull', 'isNotNull'],
    // A relation holds the target's row id; equality and emptiness are the
    // only questions a person can honestly ask of an id.
    relation: ['eq', 'neq', 'isNull', 'isNotNull'],
    unknown: ['eq', 'neq', 'isNull', 'isNotNull'],
});

/** The operators worth offering for a column, narrowest-useful set first. */
export function opsForColumn(column) {
    return OPS_BY_KIND[columnTypeKind(column?.type)] || OPS_BY_KIND.unknown;
}

/** `isNull`/`isNotNull` take no value — the row is the whole condition. */
export function opTakesNoValue(op) {
    return op === 'isNull' || op === 'isNotNull';
}

/** `in`/`notIn`/`between` take a LIST; `assertFilterValue` refuses objects either way. */
export function opTakesList(op) {
    return op === 'in' || op === 'notIn' || op === 'between';
}

/**
 * One filter row → the descriptor entry, or null when it is not answerable
 * yet. Never sends a half-typed condition: an empty value on an operator
 * that needs one would be `field = ''`, which silently returns nothing and
 * reads as "no rows match" rather than "you have not finished".
 */
export function filterEntry(row) {
    if (!row || !row.field || !row.op) return null;
    if (!FILTER_OPS.includes(row.op)) return null;
    if (opTakesNoValue(row.op)) return { field: row.field, op: row.op, value: null };
    if (opTakesList(row.op)) {
        const list = String(row.value ?? '').split(',').map(s => s.trim()).filter(Boolean);
        if (row.op === 'between' ? list.length !== 2 : list.length === 0) return null;
        return { field: row.field, op: row.op, value: list };
    }
    const value = row.value;
    if (value === '' || value === null || value === undefined) return null;
    return { field: row.field, op: row.op, value };
}

/** Every answerable row of a filter draft, as the server's `filters` array. */
export function filterDescriptor(rows) {
    return (Array.isArray(rows) ? rows : []).map(filterEntry).filter(Boolean);
}

/**
 * The FIRST thing wrong with a proposed column list for a managed table, as a
 * REASON CODE rather than a sentence.
 *
 * A code, because the sentence is a translated string and this module is where
 * the server's rules are mirrored: a mirrored sentence would drift into being
 * a second, subtly different explanation of the same refusal, and drift in the
 * RULE is what the pinning test can actually catch.
 *
 * `unique` is checked as hard as the rest. Dropping the unique index under the
 * writer's upsert does not fail loudly — it writes a DUPLICATE row every run.
 */
export function managedColumnProblem(kind, fields) {
    // The whole list is the source's: there is no edit to allow, an identical
    // list included — the server's managedFieldsError says the same.
    if (DEFINITION_MANAGED_KINDS.includes(kind)) return { reason: 'definition_owned' };
    if (isSchemaLocked(kind)) return { reason: 'source_owned' };
    const want = MANAGED_COLUMNS[kind];
    if (!want) return null;
    const byKey = new Map((Array.isArray(fields) ? fields : [])
        .filter(f => f && typeof f.key === 'string').map(f => [f.key, f]));
    for (const w of want) {
        const got = byKey.get(w.key);
        if (!got) return { reason: 'missing', key: w.key };
        if (got.type !== w.type) return { reason: 'retyped', key: w.key, type: w.type };
        if (w.unique && got.unique !== true) return { reason: 'unique', key: w.key };
        if (w.required && got.required !== true) return { reason: 'required', key: w.key };
    }
    return null;
}
