/**
 * Dynamic form fields: choices and questions that come from run data.
 *
 *   optionsFrom  one choice question whose options are a list from an earlier
 *                step ("pick one of the rows the lookup found").
 *   fieldsFrom   a TEMPLATE question asked once per item of such a list
 *                ("rate each of these"), whose answers fold back into one list.
 *
 * Both exist only on a later Form page step: the first page is shown before
 * anything has run. The author writes a source spec
 * `{ ref, value?, label?, hint?, limit? }`; at render time the runtime hands
 * `resolveList(ref)` (a run-state read) to the functions below, which turn the
 * spec into plain options or expanded questions. The rendered config never
 * contains the spec itself, and the strings that come out of run data are
 * NEVER interpolated again: they are data, not template.
 *
 * Pure: no I/O. No module in here requires formTriggerContract.js.
 */

'use strict';

const { getRelativePath, parsePath } = require('../shared/expr/index.mjs');
const log = require('../telemetry/log');
const { capped } = require('./mcpRunReadCaps');
const {
    isPlainObject, formOptionsCap, formFieldsFromCap,
    MAX_OPTION_LEN, MAX_OPTION_HINT_LEN, MAX_LABEL_LEN, MAX_PLACEHOLDER_LEN,
    MAX_SOURCE_PATH_LEN, MAX_SOURCE_LIMIT, MAX_FIELDS_FROM_NAME_LEN, MAX_GROUP_ITEMS,
} = require('./formFieldTypes');

/** Template types a `fieldsFrom` may repeat. */
const FIELDS_FROM_TYPES = Object.freeze(['text', 'textarea', 'number', 'date', 'select', 'radio', 'checkbox']);
/** Run-state roots a source ref may start from (never `secrets`). */
const SOURCE_ROOTS = Object.freeze(['trigger', 'steps', 'vars', 'loop']);

// ── Spec ───────────────────────────────────────────────

function pathText(v) {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_SOURCE_PATH_LEN) : null;
}

/** An authored source spec, trimmed and bounded; null when it is not an object. */
function normalizeSourceSpec(raw) {
    if (!isPlainObject(raw)) return null;
    const spec = { ref: pathText(raw.ref) || '' };
    for (const key of ['value', 'label', 'hint']) {
        const p = pathText(raw[key]);
        if (p) spec[key] = p;
    }
    const limit = Number(raw.limit);
    if (raw.limit !== undefined && raw.limit !== null && raw.limit !== '' && Number.isInteger(limit) && limit >= 1 && limit <= MAX_SOURCE_LIMIT) {
        spec.limit = limit;
    }
    return spec;
}

/**
 * Check a source spec on save. `spec` is the RAW authored value, `kind` is
 * 'optionsFrom' or 'fieldsFrom', and `field` (optional) is the declaration it
 * sits on, so a template can be checked for its type and name length.
 */
function validateSourceSpec(spec, at, push, { allowRunData = false, kind = 'optionsFrom', field = null } = {}) {
    const what = kind === 'fieldsFrom' ? 'questions per item' : 'choices from a list';
    if (!allowRunData) {
        push('field_options_from_on_trigger', at,
            `Choices from earlier steps only work on a later Form page step, because the first page is shown before anything has run (${what}).`,
            'Move this question to a Form page step after the step that produces the list.');
        return;
    }
    if (kind === 'fieldsFrom' && field) validateTemplate(field, at, push);
    if (!isPlainObject(spec)) {
        push('field_options_from_invalid', at, `The list for ${what} must say where it comes from.`, 'Pick the step output that holds the list.');
        return;
    }
    const bad = (sub, message, hint) => push('field_options_from_invalid', sub ? `${at}.${sub}` : at, message, hint);
    const ref = typeof spec.ref === 'string' ? spec.ref.trim() : '';
    if (!ref) {
        push('field_options_from_no_ref', `${at}.ref`, `The list for ${what} does not say where it comes from.`, 'Pick the step output that holds the list, e.g. steps.<id>.output.rows.');
    } else if (ref.includes('{{') || ref.length > MAX_SOURCE_PATH_LEN) {
        bad('ref', 'The list location must be a plain path such as steps.<id>.output.rows, without {{ }}.', `Use at most ${MAX_SOURCE_PATH_LEN} characters.`);
    } else if (!parsePath(ref) || !SOURCE_ROOTS.includes(ref.split(/[.[]/)[0])) {
        bad('ref', `"${ref}" is not a path into the run.`, `Start it with one of: ${SOURCE_ROOTS.join(', ')}.`);
    }
    for (const key of ['value', 'label', 'hint']) {
        const v = spec[key];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string' || v.includes('{{') || v.length > MAX_SOURCE_PATH_LEN) {
            bad(key, `${key} must be a short path inside each list item, without {{ }}.`, 'Use the name of the field of each item, e.g. name.');
        }
    }
    if (spec.limit !== undefined && spec.limit !== null && spec.limit !== '') {
        const n = Number(spec.limit);
        if (!Number.isInteger(n) || n < 1 || n > MAX_SOURCE_LIMIT) {
            bad('limit', `limit must be a whole number between 1 and ${MAX_SOURCE_LIMIT}.`, 'Lower it, or remove it to use the default.');
        }
    }
}

/** The extra rules for a field that carries `fieldsFrom`. */
function validateTemplate(f, at, push) {
    const base = at.replace(/\.fieldsFrom$/, '');
    if (!FIELDS_FROM_TYPES.includes(f.type) || f.optionsFrom) {
        push('field_fields_from_type', `${base}.type`,
            `"${f.name}" cannot be asked once per item: ${f.optionsFrom ? 'its choices already come from a list' : `a ${f.type || 'text'} question cannot be repeated`}.`,
            `Use one of: ${FIELDS_FROM_TYPES.join(', ')}, with fixed choices if it has any.`);
    }
    if (typeof f.name === 'string' && f.name.length > MAX_FIELDS_FROM_NAME_LEN) {
        push('field_rule_invalid', `${base}.name`,
            `The name "${f.name}" is too long for a question that is asked once per item (at most ${MAX_FIELDS_FROM_NAME_LEN} characters).`,
            'Shorten the name.');
    }
}

// ── Resolving ──────────────────────────────────────────

function readList(spec, resolveList) {
    if (!spec || !spec.ref || typeof resolveList !== 'function') return [];
    try {
        const list = resolveList(spec.ref);
        return Array.isArray(list) ? list : [];
    } catch (err) {
        log.warn('form list could not be read; showing no choices', { error: String(err?.message || err).slice(0, 200) });
        return [];
    }
}

const isScalar = (v) => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));
const asText = (v, max) => String(v).trim().slice(0, max).trim();

/** One list item as `{ value, label, hint? }`, or null when it has no usable value. */
function readItem(item, spec) {
    const raw = spec.value === undefined && isScalar(item) ? item : getRelativePath(item, spec.value);
    if (!isScalar(raw)) return null;
    const value = asText(raw, MAX_OPTION_LEN);
    if (!value) return null;
    const out = { value, label: value };
    if (spec.label) {
        const l = getRelativePath(item, spec.label);
        if (isScalar(l) || typeof l === 'boolean') out.label = asText(l, MAX_OPTION_LEN) || value;
    }
    if (spec.hint) {
        const h = getRelativePath(item, spec.hint);
        if ((isScalar(h) || typeof h === 'boolean') && asText(h, MAX_OPTION_HINT_LEN)) out.hint = asText(h, MAX_OPTION_HINT_LEN);
    }
    return out;
}

/** The first `max` distinct usable items of the list the spec points at. */
function resolveItems(spec, resolveList, max) {
    const list = readList(spec, resolveList);
    const out = [];
    const seen = new Set();
    for (const item of list) {
        if (out.length >= max) break;
        const o = readItem(item, spec);
        if (!o || seen.has(o.value)) continue;
        seen.add(o.value);
        out.push(o);
    }
    return out;
}

/**
 * The options an `optionsFrom` spec resolves to: `[{ value, label, hint? }]`.
 * Capped at min(spec.limit, AUTOMATION_FORM_MAX_OPTIONS). Strings from the
 * run are used as they are: never interpolated.
 */
function resolveOptions(spec, resolveList) {
    return resolveItems(spec, resolveList, capped(spec?.limit || Infinity, formOptionsCap()));
}

/**
 * Expand a normalized `fieldsFrom` template into `[header, ...items]`:
 * one question per list item, all sharing `group`, plus a leading info header
 * that guarantees the group exists (as an empty list) when the list is empty.
 */
function expandFieldsFrom(field, spec, resolveList) {
    const { name, label, help, fieldsFrom, optionsFrom, content, ...attrs } = field;
    const max = Math.min(capped(spec?.limit || Infinity, formFieldsFromCap()), MAX_GROUP_ITEMS);
    const header = {
        name: `${name}__0`,
        type: 'info',
        label,
        required: false,
        placeholder: '',
        help: '',
        content: help || '',
        group: name,
        groupHeader: true,
    };
    if (attrs.showIf) header.showIf = attrs.showIf;
    const items = resolveItems(spec, resolveList, max).map((it, i) => ({
        ...attrs,
        ...(Array.isArray(attrs.options) ? { options: attrs.options.map(o => ({ ...o })) } : {}),
        name: `${name}__${i + 1}`,
        label: it.label.slice(0, MAX_LABEL_LEN),
        help: (it.hint || '').slice(0, MAX_PLACEHOLDER_LEN),
        group: name,
        groupKey: it.value,
    }));
    return [header, ...items];
}

/**
 * Fold the answers of expanded questions back into one list per group:
 * `values[group] = [{ key, label, answer }]` in item order, and remove the
 * `<name>__<i>` keys. A header with no items still yields `[]`. Mutates and
 * returns `values`; the group takes the place of its template in field order.
 */
function foldGroups(values, fields) {
    const groups = new Map();
    for (const f of fields) {
        if (!f.group) continue;
        if (!groups.has(f.group)) groups.set(f.group, []);
        if (f.groupHeader || f.type === 'info') continue;
        if (!Object.prototype.hasOwnProperty.call(values, f.name)) continue;
        groups.get(f.group).push({ key: f.groupKey ?? '', label: f.label, answer: values[f.name] });
    }
    if (!groups.size) return values;
    const entries = new Map(Object.keys(values).map(k => [k, values[k]]));
    for (const k of entries.keys()) delete values[k];
    const expanded = new Set(fields.filter(f => f.group).map(f => f.name));
    const placed = new Set();
    for (const f of fields) {
        if (f.group) {
            if (placed.has(f.group)) continue;
            placed.add(f.group);
            values[f.group] = groups.get(f.group);
        } else if (entries.has(f.name)) {
            values[f.name] = entries.get(f.name);
        }
    }
    for (const [k, v] of entries) if (!expanded.has(k) && !Object.prototype.hasOwnProperty.call(values, k)) values[k] = v;
    return values;
}

module.exports = {
    FIELDS_FROM_TYPES,
    normalizeSourceSpec,
    validateSourceSpec,
    resolveOptions,
    expandFieldsFrom,
    foldGroups,
};
