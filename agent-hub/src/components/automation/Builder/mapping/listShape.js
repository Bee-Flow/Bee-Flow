/**
 * listShape — the single vocabulary for "this value is a LIST" across the
 * builder's data-picking surfaces (variable tree, {} picker, ValueBuilder,
 * BindingField, the output table's column chooser).
 *
 * Pure and React-free. Everything resolves through bindingHelpers.walkPath —
 * the byte-for-byte mirror of server/automation/bind.js — never a second
 * walker, so the counts and shapes reported here are exactly what the runtime
 * will see.
 *
 * Two kinds of list a user meets:
 *   'list'   — the path points AT an array (`steps.g.output.results`).
 *   'column' — the path contains `[*]`: one value from EACH row of an array
 *              (`steps.g.output.results[*].subject`). The count walkPath
 *              reports for a column is the TRUE flattened total — pickers
 *              used to read `field.sample`, which is the first ELEMENT, and
 *              printed counts that were simply wrong.
 *
 * Sentences are returned as i18n key + params PLUS an English fallback
 * (`badgeEn` / `explainEn`), so React callers pass them through t() and pure
 * callers (tests, tooltips built off-thread) still read English.
 *
 * The only bindings this module ever emits use `{kind:'ref'}` or the
 * whitelisted engine functions first/last/join/count (see
 * server/shared/expr/functions.mjs). `each` (keep the whole list) is a bare
 * ref ON PURPOSE — a `{{path}}` template would make bind.js JSON.stringify
 * the array into the surrounding text, which is the exact silent failure this
 * module exists to prevent.
 */
import { formatPath, parsePath } from '@shared/expr/path.mjs';
import { suggestItemVar } from './upstream';
import { lastPathKey } from './upstream/fieldTree';
import { describeDataPath, escapeExprString } from './valueParts';
import { walkPath, walkRelativePath } from '../../../../utils/bindingHelpers';
import { summariseData } from '../flow/dataSummary';
import { humanizeFieldTail } from '../flow/displayHelpers';

const WILDCARD = '[*]';

/**
 * Split a column path on its FIRST `[*]`.
 * `steps.g.output.results[*].subject` →
 *   { arrayPath: 'steps.g.output.results', tail: '.subject' }
 * The tail is sliced VERBATIM (leading `.` or `[` kept), so bracket-quoted
 * keys (`[*]["content-type"]`) survive re-assembly untouched. The wildcard is
 * found in the PARSED path, so a quoted key that merely contains `[*]` (or a
 * `]`) is not mistaken for one; a path the grammar cannot read falls back to
 * the text.
 */
export function splitColumnPath(path) {
    const s = String(path || '');
    const tokens = parsePath(s);
    if (tokens) {
        const i = tokens.findIndex(t => t.type === 'wild');
        if (i < 0) return { arrayPath: s, tail: '' };
        const arrayPath = formatPath(tokens.slice(0, i));
        const head = `${arrayPath}${WILDCARD}`;
        // Canonical spelling (what discovery writes): slice verbatim.
        if (s.startsWith(head)) return { arrayPath, tail: s.slice(head.length) };
        const rest = formatPath([{ type: 'prop', key: '$' }, ...tokens.slice(i + 1)]).slice(1);
        return { arrayPath, tail: rest };
    }
    const i = s.indexOf(WILDCARD);
    if (i < 0) return { arrayPath: s, tail: '' };
    return { arrayPath: s.slice(0, i), tail: s.slice(i + WILDCARD.length) };
}

/** The tail relative to ONE row (for walkRelativePath): drop a leading dot. */
function rowTail(tail) {
    return String(tail || '').replace(/^\./, '');
}

function ofKind(arr) {
    const s = summariseData(arr);
    return s?.kind === 'records' ? 'records' : 'values';
}

/**
 * Describe what the path resolves to, when that is a list. Returns null for
 * scalars, unresolvable paths, and empty non-arrays — "not a list" is the
 * common case and callers branch on it.
 *
 * ListShape:
 *   kind              'list' | 'column'
 *   count             flattened total (walkPath resolves [*]), or null
 *   rows              for a column: how many rows the base array has
 *   of                'records' | 'values'
 *   elementSample     first resolved element (for nested-shape checks)
 *   rowScopedListTail true when each ROW's value here is itself a list —
 *                     repeating over the column would merge every row's items
 *   badgeKey/badgeParams/badgeEn        the short pill
 *   explainKey/explainParams/explainEn  the tooltip sentence
 */
export function pathListShape(path, sampleRoot) {
    const raw = String(path || '').trim();
    if (!raw || sampleRoot == null) return null;
    const isColumn = raw.includes(WILDCARD);
    const resolved = walkPath(raw, sampleRoot);
    if (!Array.isArray(resolved)) return null;

    const count = resolved.length;
    const of = ofKind(resolved);
    const elementSample = resolved[0];

    if (!isColumn) {
        const noun = of === 'records' ? 'records' : 'items';
        return {
            kind: 'list', count, rows: null, of, elementSample,
            rowScopedListTail: false,
            badgeKey: of === 'records' ? 'automations.builder.badge_list_records' : 'automations.builder.badge_list_items',
            badgeParams: { n: count },
            badgeEn: `A list — ${count} ${noun}`,
            explainKey: 'automations.builder.explain_list',
            explainParams: { field: humanizeFieldTail(raw) || raw, n: count },
            explainEn: `“${humanizeFieldTail(raw) || raw}” is a list of ${count} ${noun}.`,
        };
    }

    const { arrayPath, tail } = splitColumnPath(raw);
    const baseRows = walkPath(arrayPath, sampleRoot);
    const rows = Array.isArray(baseRows) ? baseRows.length : null;
    // Does one ROW still hold a list here? Checked against a row element, not
    // the flattened result — the flatten is exactly what hides this.
    const firstRow = Array.isArray(baseRows) ? baseRows.find(r => r != null) : undefined;
    const perRow = firstRow === undefined ? undefined : walkRelativePath(rowTail(tail), firstRow);
    const rowScopedListTail = Array.isArray(perRow);

    return {
        kind: 'column', count, rows, of, elementSample,
        rowScopedListTail,
        badgeKey: 'automations.builder.badge_column',
        badgeParams: { rows: rows ?? count },
        badgeEn: 'One value per row',
        explainKey: rowScopedListTail ? 'automations.builder.explain_column_nested' : 'automations.builder.explain_column',
        explainParams: { field: humanizeFieldTail(raw), rows: rows ?? count, n: count },
        explainEn: rowScopedListTail
            ? `This list sits inside each row. Repeating over it merges every row’s items into one list — ${count} in total.`
            : `One value from each of the ${rows ?? count} rows — ${count} values in total.`,
    };
}

/**
 * pathListShape for a variable-tree/picker FIELD row. Falls back to the
 * field's own design-time sample when the path doesn't resolve in the merged
 * sample root (no run yet, curated samples only).
 */
export function fieldListShape(field, sampleRoot) {
    if (!field?.path) return null;
    const live = pathListShape(field.path, sampleRoot);
    if (live) return live;
    if (!Array.isArray(field.sample)) return null;
    // Design-time only: sample counts are placeholders, so don't print them
    // as facts — the badge stays shapeful but uncounted.
    const of = ofKind(field.sample);
    return {
        kind: field.path.includes(WILDCARD) ? 'column' : 'list',
        count: null, rows: null, of,
        elementSample: field.sample[0],
        rowScopedListTail: false,
        badgeKey: 'automations.builder.badge_list_plain',
        badgeParams: {},
        badgeEn: 'A list',
        explainKey: 'automations.builder.explain_list_no_sample',
        explainParams: { field: humanizeFieldTail(field.path) || field.key || '' },
        explainEn: 'This is a list. Run the step above to see how many it really holds.',
    };
}

/**
 * The "run this step once for each row" pick, as the two writes it takes:
 * the step's forEach and the field's per-row binding.
 *
 *   column:  forEach over the base array; the field gets that row's value
 *            (`loop.<var>` + the tail verbatim, so seg() quoting survives).
 *   list:    forEach over the list itself; the field gets the whole item.
 */
export function forEachPickFor(path, sampleRoot, { itemVar } = {}) {
    const raw = String(path || '').trim();
    const { arrayPath, tail } = splitColumnPath(raw);
    const lastSeg = lastPathKey(arrayPath) || 'item';
    const v = (itemVar || suggestItemVar(lastSeg) || 'item').replace(/[^A-Za-z0-9_]/g, '') || 'item';
    return {
        forEach: { overRef: arrayPath, itemVar: v, maxIterations: 100 },
        binding: { kind: 'ref', path: `loop.${v}${tail}` },
        itemVar: v,
    };
}

/**
 * The non-iterating choices, each as a stored binding. Only whitelisted
 * engine functions — everything here runs on the server as written.
 */
export function bindingsForList(path, { separator = ', ' } = {}) {
    const p = String(path || '').trim();
    return {
        each: { kind: 'ref', path: p },
        first: { kind: 'expr', value: `first(${p})` },
        last: { kind: 'expr', value: `last(${p})` },
        join: { kind: 'expr', value: `join(${p}, "${escapeExprString(separator)}")` },
        count: { kind: 'expr', value: `count(${p})` },
    };
}

/**
 * What the FIRST iteration of a foreach pick would see — previewBinding
 * cannot answer this (there is no loop scope until the step runs).
 */
export function previewForEachPick(path, sampleRoot) {
    const { arrayPath, tail } = splitColumnPath(String(path || '').trim());
    const arr = walkPath(arrayPath, sampleRoot);
    if (!Array.isArray(arr) || !arr.length) return undefined;
    const first = arr.find(r => r != null);
    if (first === undefined) return undefined;
    return tail ? walkRelativePath(rowTail(tail), first) : first;
}

/**
 * A list path as a person reads it: "gmail search ▸ Subject (inside each
 * row)" for a column, "gmail search ▸ Results" for a plain list. Internal
 * step ids never appear; the raw path belongs in a title attribute.
 */
export function describeListPath(path, stepLabelById = null, t = null) {
    const raw = String(path || '').trim();
    const { arrayPath, tail } = splitColumnPath(raw);
    const isColumn = raw.includes(WILDCARD);
    const base = describeDataPath(isColumn ? arrayPath : raw, stepLabelById);
    const field = isColumn ? humanizeFieldTail(tail) : base.suffix;
    const step = base.name;
    if (!isColumn) return field ? `${step} ▸ ${field}` : step;
    const en = `${step} ▸ ${field} (inside each row)`;
    return t ? t('automations.builder.column_path_label', '{step} ▸ {field} (inside each row)', { step, field }) : en;
}

/**
 * What SHAPE a tool parameter wants, from its JSON schema — THE single shape
 * vocabulary for the chooser gate. 'unknown' (no schema: custom rows, App
 * Studio surfaces) means the chooser never fires and behaviour is unchanged.
 */
export function expectedShapeFor(schemaProp) {
    if (!schemaProp || typeof schemaProp !== 'object') return 'unknown';
    let type = schemaProp.type;
    if (Array.isArray(type)) type = type.find(x => x !== 'null') || type[0];
    if (type === 'array') return 'list';
    if (type === 'string' || type === 'number' || type === 'integer' || type === 'boolean') return 'scalar';
    return 'unknown';
}
