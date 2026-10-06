/**
 * The field menu of a rule row while a Condition works through a list —
 * one builder for the web and the phone (both pass their own field tree and
 * labels), so the two menus offer the same fields in the same groups.
 * Re-exported by rules.mjs; pure.
 */

import { parseJsonText } from './path.mjs';
import { fileTypeField, fileTypeOf, isFileRecord, isPlainObject } from './fileTypes.mjs';

const hasWildcard = (path) => typeof path === 'string' && path.includes('[*]');

/** The first record of a list (or of a list held as JSON text); undefined when it holds none. */
function firstRecordOf(value) {
    const list = Array.isArray(value) ? value : parseJsonText(value);
    if (!Array.isArray(list)) return undefined;
    const first = list.find((el) => el != null);
    return isPlainObject(first) ? first : undefined;
}

/** A list of records inside the item: one "has at least one / has none" entry, then its own group. */
function recordListOptions(f, opts, itemGroup) {
    const { name, group, itemName } = opts;
    const entry = { path: f.path, label: name(f.key), sample: f.sample, group: itemGroup, kind: 'records' };
    const innerGroup = group('inner', { list: name(f.key), name: itemName });
    const inner = [];
    const first = firstRecordOf(f.sample);
    if (isFileRecord(first)) {
        inner.push({ path: fileTypeField(f.path, { list: true }), label: fileTypeLabel(opts), sample: fileTypeOf(first), group: innerGroup, quantified: true, kind: 'fileType' });
    }
    const plain = [];
    for (const c of f.children || []) {
        if (hasWildcard(c.path)) inner.push({ path: c.path, label: name(c.key), sample: c.sample, group: innerGroup, quantified: true });
        else plain.push({ path: c.path, label: `${name(f.key)} · ${name(c.key)}`, sample: c.sample, group: itemGroup });
    }
    return { entries: [entry, ...plain], inner };
}

const fileTypeLabel = (opts) => (opts.fileTypeLabel != null ? opts.fileTypeLabel : opts.name('fileType'));

/** A field and its non-list children ("Fields · Story Points"), all in one group. */
function plainOptions(fields, name, groupText) {
    const out = [];
    for (const f of fields || []) {
        out.push({ path: f.path, label: name(f.key), sample: f.sample, group: groupText });
        for (const c of f.children || []) {
            if (!hasWildcard(c.path)) out.push({ path: c.path, label: `${name(f.key)} · ${name(c.key)}`, sample: c.sample, group: groupText });
        }
    }
    return out;
}

/**
 * The options of a rule row's field menu while working through a list.
 * `fields` is the platform's field tree of one item (`sampleToFields(element,
 * 'item')`). Order: File type of the item (when it is a file), the item's
 * fields (a list of records once, as "has at least one / has none"), then per
 * list of records a group with its File type first and its columns, each
 * `quantified` (the row picks any / every / no entry). A list column is
 * never offered as a plain field. `parent` (Tier 2: `{ fields, element,
 * name }`, fields rooted at `loop.<var>` by the caller, name its display
 * name) adds the fields of the record each item came from.
 * `fileTypeLabel` (optional) names File type; default `name('fileType')`.
 */
export function ruleFieldOptions(fields, opts) {
    const { element, name, group, itemName, parent = null } = opts;
    const itemGroup = group('item', { name: itemName });
    const out = [];
    const inner = [];
    if (isFileRecord(element)) {
        out.push({ path: fileTypeField('item'), label: fileTypeLabel(opts), sample: fileTypeOf(element), group: itemGroup, kind: 'fileType' });
    }
    for (const f of fields || []) {
        if (firstRecordOf(f.sample) !== undefined) {
            const r = recordListOptions(f, opts, itemGroup);
            out.push(...r.entries);
            inner.push(...r.inner);
        } else {
            out.push(...plainOptions([f], name, itemGroup));
        }
    }
    const parentOptions = parent ? plainOptions(parent.fields, name, group('parent', { name: parent.name })) : [];
    return [...out, ...inner, ...parentOptions];
}
