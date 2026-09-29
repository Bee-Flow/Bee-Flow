/**
 * FORM ANSWERS — the pure half: from a routine's definition to the columns
 * of its answers table, and from a submission to a row.
 *
 * ── WHAT THE TABLE IS ──────────────────────────────────────────────
 * A datatable of `managed_kind = 'form_answers'` whose columns are the form's
 * QUESTIONS: two fixed columns (`run_id`, `completed_at`, managedTables.js)
 * plus one per input field of the trigger's form and of every input
 * `form_page` step. The routine's definition is the only editor of those
 * columns; this module derives them on every save (provision.js) and the
 * column map it writes into `source.columnMap` is what write.js and the
 * dashboard read.
 *
 * ── IDENTITY ───────────────────────────────────────────────────────
 * A column is identified by (page step id | null, form field NAME). The name
 * is minted once by the builder (FormBuilderFields.slugifyFieldName) and never
 * re-derived from the label, so relabelling a question renames the column
 * header and touches no DDL; page 2 may legitimately reuse a page-1 name,
 * hence the pair. The field id is a hash of that pair plus the column type's
 * code, so a RETYPE is a different id — and never a DROP: the old column is
 * retired and a new one added, because the answers already in it are
 * somebody's and this module is not the one to throw them away.
 *
 * A question removed from the form keeps its column, flagged `retired`; a
 * question re-added with the same name and type un-retires it. Nothing in
 * here ever produces a column list shorter than the previous one.
 *
 * Pure: no I/O, no time. Safe to require from stores, routes and tests.
 */

'use strict';

const crypto = require('crypto');
const { normalizeFields, isDisplayField, isFormTriggerDefinition } = require('../formTriggerContract');
const portability = require('../portability');
const { keyFromTitle, TYPE_CODE } = require('../../core/dataEngine/sources/mirror/keys');
const { DATA_LIMITS, SYSTEM_COLUMNS } = require('../../core/dataEngine/dataModel/vocabulary');
const { FORM_ANSWERS_FIELDS } = require('../../core/dataEngine/dataModel/managedTables');

const KIND = 'form_answers';

/** Form field type → datatable column type. Display fields have no column. */
const FORM_TYPE_TO_COLUMN = Object.freeze({
    text: 'text', textarea: 'text', email: 'text',
    number: 'number', date: 'date', select: 'select', checkbox: 'bool', file: 'file',
    // A picked record lands as TEXT — the title of what was chosen, not its
    // content. The content is the run's business and routinely tens of
    // thousands of characters; a dashboard column holding a whole meeting
    // transcript would be unreadable and would bloat every read of the table.
    app_pick: 'text',
});

const SYSTEM_KEYS = new Set([...SYSTEM_COLUMNS, ...FORM_ANSWERS_FIELDS.map(f => f.key)]);

/** Does the trigger's form ask for its answers to be collected in a table? */
function collectEnabled(definition) {
    return isFormTriggerDefinition(definition) && definition.trigger.form?.collect === true;
}

/** The input pages of a multi-page form, in definition order. */
function inputPagesOf(definition) {
    const pages = [];
    // portability is stubbed to a subset in some route suites; a definition
    // whose pages cannot be walked simply has none here.
    if (typeof portability.walkAllSteps !== 'function') return pages;
    portability.walkAllSteps(definition, (step) => {
        if (step && step.type === 'form_page' && step.mode !== 'ending' && typeof step.id === 'string') {
            pages.push({ stepId: step.id, form: step.form || null, label: step.title || step.form?.title || step.id });
        }
    });
    return pages;
}

/** Every question a submission can answer: the trigger's, then each page's. */
function questionsOf(definition) {
    if (!isFormTriggerDefinition(definition)) return [];
    const out = [];
    for (const f of normalizeFields(definition.trigger.form)) {
        if (!isDisplayField(f)) out.push({ pageStepId: null, field: f });
    }
    for (const page of inputPagesOf(definition)) {
        for (const f of normalizeFields(page.form)) {
            if (!isDisplayField(f)) out.push({ pageStepId: page.stepId, field: f });
        }
    }
    return out;
}

/** The identity hash of one question — stable across relabels and reorders. */
function identityHash(pageStepId, name) {
    return crypto.createHash('sha256').update(`${pageStepId || ''}|${name}`).digest('hex').slice(0, 10);
}

function fieldIdFor(pageStepId, name, columnType) {
    return `fld_fa${identityHash(pageStepId, name)}${TYPE_CODE[columnType] || 'txt'}`;
}

/** Select options as the datatable stores them: the option VALUES. */
function optionValuesOf(field) {
    return (Array.isArray(field.options) ? field.options : [])
        .map(o => (typeof o === 'string' ? o : o?.value))
        .filter(v => typeof v === 'string' && v.trim())
        .map(v => v.slice(0, 120));
}

/**
 * Merge the options a select column already has with the form's current
 * ones. Never shrinks: a row answered "Support" last year must stay valid
 * after the option is dropped from the form. Capped, oldest kept.
 */
function unionOptions(previous, current) {
    const out = [];
    const seen = new Set();
    for (const v of [...(Array.isArray(previous) ? previous : []), ...current]) {
        if (seen.has(v)) continue;
        seen.add(v);
        out.push(v);
        if (out.length >= DATA_LIMITS.MAX_SELECT_OPTIONS) break;
    }
    return out;
}

/**
 * A sha of what the columns would be — cheap "did anything change" for the
 * save path, so a save that touched no question costs no reconcile.
 */
function fingerprintOf(columnMap) {
    const entries = Object.entries(columnMap)
        .map(([id, c]) => [id, c.key, c.name, c.columnType, c.retired ? 1 : 0, (c.options || []).join('|')].join('|'))
        .sort();
    return crypto.createHash('sha256').update(entries.join(';')).digest('hex');
}

/**
 * From the definition (and the column map the table already has) to the
 * next column list.
 *
 * Returns `{ fields, columnMap, fingerprint, warnings }` where `fields` is
 * the FULL datatable field list in the order `[run_id, completed_at, …live
 * questions in form order, …retired]` and `columnMap` is keyed by field id.
 */
function deriveAnswerColumns(definition, existingColumnMap = null, { now = null } = {}) {
    const prior = existingColumnMap && typeof existingColumnMap === 'object' ? existingColumnMap : {};
    const used = new Set(SYSTEM_KEYS);
    for (const c of Object.values(prior)) if (c && typeof c.key === 'string') used.add(c.key);

    const columnMap = {};
    const live = [];
    const warnings = [];
    const cap = DATA_LIMITS.MAX_FIELDS_PER_TABLE - FORM_ANSWERS_FIELDS.length;
    const questions = questionsOf(definition);
    const kept = new Set();

    for (const { pageStepId, field } of questions) {
        const columnType = FORM_TYPE_TO_COLUMN[field.type];
        if (!columnType) continue;
        const id = fieldIdFor(pageStepId, field.name, columnType);
        const before = prior[id] || null;
        if (Object.keys(columnMap).length >= cap) {
            warnings.push({ code: 'too_many_columns', name: field.name, pageStepId, message: `"${field.label}" has no column: a table holds at most ${DATA_LIMITS.MAX_FIELDS_PER_TABLE} columns.` });
            continue;
        }
        // A key is minted once and kept forever: reordering pages or renaming
        // a question must never move an answer under another key.
        const key = before ? before.key : keyFromTitle(field.name, Object.keys(columnMap).length + 1, used);
        used.add(key);
        const entry = {
            key,
            name: field.label || field.name,
            formName: field.name,
            pageStepId: pageStepId || null,
            formType: field.type,
            columnType,
            options: columnType === 'select' ? unionOptions(before && before.options, optionValuesOf(field)) : null,
            required: !!field.required,
            retired: false,
            retiredAt: null,
        };
        columnMap[id] = entry;
        kept.add(id);
        live.push(id);
    }

    // Everything the table had that the form no longer asks: kept, retired —
    // in the order they were retired (JSONB keeps no order of its own).
    const retired = [];
    for (const [id, c] of Object.entries(prior)) {
        if (kept.has(id) || !c || typeof c.key !== 'string') continue;
        columnMap[id] = { ...c, retired: true, retiredAt: c.retiredAt || now || null };
        retired.push(id);
    }
    retired.sort((a, b) => String(columnMap[a].retiredAt || '').localeCompare(String(columnMap[b].retiredAt || ''))
        || (columnMap[a].position ?? 0) - (columnMap[b].position ?? 0));

    // JSONB does not keep key order, so the order the form has is written
    // into every entry: live questions in form order, retired ones after.
    [...live, ...retired].forEach((id, i) => { columnMap[id].position = i; });
    const fields = [
        ...FORM_ANSWERS_FIELDS.map(f => ({ ...f })),
        ...[...live, ...retired].map(id => fieldOf(id, columnMap[id])),
    ];
    return { fields, columnMap, fingerprint: fingerprintOf(columnMap), warnings };
}

/** One datatable field from one column-map entry. */
function fieldOf(id, entry) {
    const f = { id, key: entry.key, name: entry.name, type: entry.columnType };
    if (entry.columnType === 'select') f.options = (entry.options || []).slice();
    return f;
}

/**
 * The row values for ONE page of answers (`pageStepId` null = the trigger's
 * form), keyed by column key. What the form stores as "" becomes NULL for
 * every type but a checkbox, so "skipped" is `IS NULL` in the dashboard.
 */
function rowValuesFor(columnMap, pageStepId, values) {
    const src = values && typeof values === 'object' ? values : {};
    const out = {};
    for (const entry of Object.values(columnMap || {})) {
        if (!entry || entry.retired || (entry.pageStepId || null) !== (pageStepId || null)) continue;
        if (!Object.prototype.hasOwnProperty.call(src, entry.formName)) continue;
        out[entry.key] = cellFor(entry, src[entry.formName]);
    }
    return out;
}

/**
 * The titles of one `app_pick` answer, or null when this is not one.
 *
 * null and '' mean different things: null is "not a pick, carry on"; '' is "a
 * pick that chose nothing", which the caller turns into an empty cell.
 */
function pickTitles(raw) {
    const list = Array.isArray(raw) ? raw : [raw];
    if (!list.length || !list.every(v => v && typeof v === 'object' && v.kind === 'app_pick')) return null;
    return list.map(v => v.title || v.recordId || '').filter(Boolean).join(', ');
}

function cellFor(entry, raw) {
    switch (entry.columnType) {
        case 'bool':
            return raw === true || raw === 'true';
        case 'number': {
            if (raw === '' || raw === null || raw === undefined) return null;
            const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
            return Number.isFinite(n) ? n : null;
        }
        case 'file': {
            if (!raw || typeof raw !== 'object') return null;
            // The claimed-upload descriptor, minus what does not belong in a
            // table: the storage key is internal, the extracted text can be
            // megabytes and is the run's business.
            const { fileId, filename, mimeType, size } = raw;
            return fileId ? JSON.stringify({ kind: 'form_upload', fileId, filename: filename || null, mimeType: mimeType || null, size: Number(size) || null }) : null;
        }
        default: {
            if (raw === null || raw === undefined) return null;
            // An `app_pick` answer is a descriptor (or a list of them), and its
            // column is plain text. Detected by SHAPE rather than by the form
            // type, because a column-map entry only carries the column type —
            // and String({…}) here would write "[object Object]" into the
            // dashboard for every picked record.
            const picks = pickTitles(raw);
            if (picks !== null) return picks || null;
            const s = typeof raw === 'string' ? raw : String(raw);
            return s === '' ? null : s;
        }
    }
}

/** The column-map entries in the form's order (live first, then retired). */
function orderedColumns(columnMap) {
    return Object.entries(columnMap || {})
        .filter(([, c]) => c && typeof c.key === 'string')
        .map(([fieldId, c]) => ({ fieldId, ...c }))
        .sort((a, b) => (a.retired === b.retired ? (a.position ?? 0) - (b.position ?? 0) : (a.retired ? 1 : -1)));
}

/** The `source` block as the client sees it: never the fingerprint. */
function publicSource(source) {
    if (!source || source.kind !== KIND) return null;
    const columns = orderedColumns(source.columnMap).map(({ fieldId, ...c }) => ({
        fieldId,
        key: c.key,
        name: c.name,
        formName: c.formName,
        pageStepId: c.pageStepId || null,
        formType: c.formType,
        columnType: c.columnType,
        required: !!c.required,
        retired: !!c.retired,
    }));
    return {
        kind: KIND,
        automationId: source.automationId || null,
        linked: source.linked !== false,
        linkedAt: source.linkedAt || null,
        columns,
        lastWriteError: source.lastWriteError || null,
    };
}

module.exports = {
    KIND,
    FORM_TYPE_TO_COLUMN,
    collectEnabled,
    inputPagesOf,
    questionsOf,
    fieldIdFor,
    deriveAnswerColumns,
    rowValuesFor,
    publicSource,
    orderedColumns,
    fingerprintOf,
};
