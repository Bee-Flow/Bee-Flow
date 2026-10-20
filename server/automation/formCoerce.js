/**
 * Runtime coercion of a form submission.
 *
 * coerceSubmission iterates the DECLARED FIELDS, never Object.keys(body). That
 * is what makes `__proto__`/`constructor` in a submitted body structurally
 * unable to reach the values object.
 *
 * On top of the type check, a submission is judged by:
 *   • the field's rules (min/max, length, pattern, number of choices),
 *   • its showIf, in declaration order against the answers above it: a hidden
 *     question has no error, no file and no pick, and carries its empty value,
 *   • its group, for questions a `fieldsFrom` template expanded into: the
 *     answers fold back into one list (formDynamicFields.foldGroups).
 *
 * Pure: no I/O. No module in here requires formTriggerContract.js.
 */

'use strict';

const { MAX_STRING_VALUE } = require('./appTriggerContract');
const pickSources = require('./formPickSources');
const { isPlainObject, isDisplayField, EMAIL_RE, DATE_RE, MAX_TEXTAREA_LEN } = require('./formFieldTypes');
const { ruleError, isVisible } = require('./formFieldRules');
const { foldGroups } = require('./formDynamicFields');

const NOT_OFFERED = 'is not one of the offered choices';

/** The option values a choice question offers. */
const offered = (field) => (field.options || []).map(o => o.value);

/** Type-check/coerce ONE submitted value. `{ ok, value }` or `{ ok:false, error }`. */
function coerceFieldValue(field, raw) {
    switch (field.type) {
        case 'textarea': {
            if (typeof raw !== 'string') return { ok: false, error: 'expects text' };
            return { ok: true, value: raw.slice(0, MAX_TEXTAREA_LEN) };
        }
        case 'text': {
            if (typeof raw !== 'string') return { ok: false, error: 'expects text' };
            return { ok: true, value: raw.slice(0, MAX_STRING_VALUE) };
        }
        case 'email': {
            if (typeof raw !== 'string') return { ok: false, error: 'expects an email address' };
            const v = raw.trim();
            if (v && !EMAIL_RE.test(v)) return { ok: false, error: 'is not a valid email address' };
            return { ok: true, value: v.slice(0, MAX_STRING_VALUE) };
        }
        case 'number': {
            if (typeof raw === 'number' && Number.isFinite(raw)) return { ok: true, value: raw };
            if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) return { ok: true, value: Number(raw) };
            return { ok: false, error: 'expects a number' };
        }
        case 'date': {
            if (typeof raw !== 'string') return { ok: false, error: 'expects a date (YYYY-MM-DD)' };
            const v = raw.trim();
            if (v && !DATE_RE.test(v)) return { ok: false, error: 'expects a date in YYYY-MM-DD format' };
            return { ok: true, value: v };
        }
        case 'select':
        case 'radio': {
            if (typeof raw !== 'string') return { ok: false, error: 'expects one of the offered choices' };
            const v = raw.trim();
            if (!v) return { ok: true, value: '' };
            // Closed vocabulary: an off-list value is a tampered submission.
            if (!offered(field).includes(v)) return { ok: false, error: NOT_OFFERED };
            return { ok: true, value: v };
        }
        case 'multiselect': {
            const list = Array.isArray(raw) ? raw : [raw];
            const picked = new Set();
            for (const item of list) {
                if (typeof item !== 'string') return { ok: false, error: 'expects some of the offered choices' };
                const v = item.trim();
                if (v) picked.add(v);
            }
            const values = offered(field);
            const known = new Set(values);
            for (const v of picked) if (!known.has(v)) return { ok: false, error: NOT_OFFERED };
            // Deduplicated, in the order the question lists its choices.
            return { ok: true, value: [...new Set(values)].filter(v => picked.has(v)) };
        }
        case 'checkbox': {
            if (typeof raw === 'boolean') return { ok: true, value: raw };
            if (raw === 'true' || raw === 'on' || raw === 1 || raw === '1') return { ok: true, value: true };
            if (raw === 'false' || raw === 'off' || raw === 0 || raw === '0' || raw === '') return { ok: true, value: false };
            return { ok: false, error: 'expects a yes/no answer' };
        }
        case 'file': {
            let v = raw;
            if (Array.isArray(v)) {
                if (v.length === 1) v = v[0];
                else return { ok: false, error: 'expects one file' };
            }
            if (!isPlainObject(v) || v.kind !== 'form_upload' || typeof v.fileId !== 'string' || !v.fileId) {
                return { ok: false, error: 'expects a file uploaded through this form' };
            }
            return { ok: true, isFile: true, value: { kind: 'form_upload', fileId: v.fileId } };
        }
        case 'app_pick': return coercePick(field, raw);
        default:
            return { ok: false, error: `has unknown type "${field.type}"` };
    }
}

function coercePick(field, raw) {
    // The DECLARED source decides what may be picked; a body naming a
    // different one is a tampered submission, not a hint. Without this
    // check a form asking for a transcript would accept, and then dutifully
    // read, a mail message id.
    const declared = pickSources.getSource(field.source);
    if (!declared) return { ok: false, error: 'points at an app that is not available' };
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length === 1 && (list[0] === null || list[0] === '')) return { ok: true, value: field.multiple ? [] : null };
    if (list.length > field.maxItems) return { ok: false, error: `takes at most ${field.maxItems} ${field.maxItems === 1 ? 'record' : 'records'}` };
    const picks = [];
    const seen = new Set();
    for (const v of list) {
        if (!isPlainObject(v) || v.kind !== 'app_pick') return { ok: false, error: 'expects a record picked through this form' };
        if (typeof v.source === 'string' && v.source && v.source !== field.source) {
            return { ok: false, error: 'expects a record from the app this question asks for' };
        }
        const recordId = typeof v.recordId === 'string' ? v.recordId.trim() : '';
        if (!recordId || recordId.length > pickSources.MAX_RECORD_ID_LEN) {
            return { ok: false, error: 'expects a record picked through this form' };
        }
        if (seen.has(recordId)) continue;   // the same record twice is one pick
        seen.add(recordId);
        picks.push({
            kind: 'app_pick',
            source: field.source,
            app: declared.app,
            recordId,
            // The title the picker showed. Carried so a run that cannot
            // re-read the record still knows WHAT was chosen; replaced
            // by the record's own title when the read succeeds.
            title: typeof v.title === 'string' ? v.title.slice(0, pickSources.MAX_TITLE_LEN) : '',
        });
    }
    return { ok: true, isPick: true, value: field.multiple ? picks : (picks[0] || null) };
}

function isBlank(field, value) {
    if (field.type === 'checkbox') return value !== true;
    if (field.type === 'file') return !value;
    if (field.type === 'app_pick') return Array.isArray(value) ? value.length === 0 : !value;
    if (field.type === 'multiselect') return !Array.isArray(value) || value.length === 0;
    if (field.type === 'number') return value === undefined || value === null || value === '';
    return typeof value !== 'string' || value.trim() === '';
}

/**
 * What an unanswered field of each type carries into the run.
 *
 * One function: the "nothing was answered" value has to be the SAME on the
 * missing-value path, the failed-coercion path and the hidden path.
 */
function emptyValue(field) {
    if (field.fieldsFrom) return [];
    if (field.type === 'checkbox') return false;
    if (field.type === 'file') return null;
    if (field.type === 'app_pick') return field.multiple ? [] : null;
    if (field.type === 'multiselect') return [];
    return '';
}

/** Make an answer readable by the showIf of the questions below it. */
function remember(scope, field, value) {
    scope[field.name] = value;
    if (field.group) {
        if (!Array.isArray(scope[field.group])) scope[field.group] = [];
        scope[field.group].push({ key: field.groupKey ?? '', label: field.label, answer: value });
    }
}

/**
 * Coerce a whole submission against the declared fields.
 *
 * Returns `{ values, files, picks, errors }`. `values` is a null-prototype
 * object keyed ONLY by declared field names (a group's questions folded into
 * one list under the group's name); the body is never iterated. `files` lists
 * the descriptors the caller still has to verify against the upload ledger.
 */
function coerceSubmission(fields, body) {
    const src = isPlainObject(body) ? body : {};
    const values = Object.create(null);
    const files = [];
    const picks = [];
    const errors = [];
    // The answers of earlier visible questions, which a showIf can read.
    const scope = Object.create(null);

    for (const field of fields) {
        if (field.groupHeader) scope[field.group] = [];
        // A display field collects nothing. It gets no entry in `values` at
        // all, so a browser that posts one back cannot smuggle a value into the
        // run under its name.
        if (isDisplayField(field)) continue;
        if (!isVisible(field.showIf, scope)) {
            values[field.name] = emptyValue(field);
            remember(scope, field, values[field.name]);
            continue;
        }
        // Own-property read: a prototype-polluted global Object.prototype must
        // not be able to supply a value for a field the visitor left out.
        const raw = Object.prototype.hasOwnProperty.call(src, field.name) ? src[field.name] : undefined;
        const checked = raw === undefined || raw === null ? null : coerceFieldValue(field, raw);

        if (checked === null) {
            if (field.required) errors.push({ field: field.name, message: `${field.label} is required.` });
            values[field.name] = emptyValue(field);
        } else if (!checked.ok) {
            errors.push({ field: field.name, message: `${field.label} ${checked.error}.` });
            values[field.name] = emptyValue(field);
        } else {
            const blank = isBlank(field, checked.value);
            const broken = blank ? null : ruleError(field, checked.value);
            if (field.required && blank) errors.push({ field: field.name, message: `${field.label} is required.` });
            else if (broken) errors.push({ field: field.name, message: broken });
            values[field.name] = checked.value;
            if (checked.isFile && checked.value) files.push({ field: field.name, fileId: checked.value.fileId });
            if (checked.isPick) {
                // One entry per RECORD, not per field: a `multiple` question sends
                // the route several reads to do, and each one has to be able to
                // fail on its own without taking the others down with it.
                const chosen = Array.isArray(checked.value) ? checked.value : (checked.value ? [checked.value] : []);
                chosen.forEach((pick, index) => picks.push({ field: field.name, index, multiple: !!field.multiple, withText: field.withText !== false, pick }));
            }
        }
        remember(scope, field, values[field.name]);
    }

    return { values: foldGroups(values, fields), files, picks, errors };
}

module.exports = {
    coerceFieldValue,
    coerceSubmission,
    isBlank,
    emptyValue,
};
