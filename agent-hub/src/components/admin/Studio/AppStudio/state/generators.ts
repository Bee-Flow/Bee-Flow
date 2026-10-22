/**
 * App Studio — structural GENERATORS: turn a data-model table into a valid
 * component subtree (a form or a data grid) plus any action it needs.
 *
 * Both builders are PURE: they take a public table meta (the shape served by
 * GET /:id/data/tables and useAppTables — { id, key, name, fields:[{ id, key,
 * name, type, required, unique, options?, relation? }] }) and return plain data
 * validated against the component catalog (componentRegistry / server
 * componentSpecs). Every produced node/action id is minted against an optional
 * `taken` id set so a caller can insert many generated subtrees into one
 * definition without id collisions (insertNode only re-ids the ROOT node, so
 * children MUST be pre-uniqued — passing collectIds(def) guarantees that).
 *
 *   buildFormForTable(table, opts) → { node, actions }
 *       A `form` container with one input per WRITABLE field (computed fields
 *       are read-only and skipped) and an onSubmit wired to a create_record
 *       sequence action ({ [fieldKey]: { kind:'field', name } } value map).
 *
 *   buildGridForTable(table, opts) → { node }
 *       A `data_grid` bound to { kind:'records', tableId } with a column per
 *       field (format inferred from the field type).
 */

import { APP_COMPONENT_TYPES } from '../runtime/componentRegistry';
import { deepClone, newId } from './definitionOps';
import type { ImportField, ImportTable } from '../tables/spreadsheetPaste';
import type { AppNode } from '../inspector/appDefinition';

// field type → input component type (writable fields only; computed is skipped).
export const FIELD_INPUT_TYPE: Readonly<Record<string, string>> = Object.freeze({
    text: 'input_text',
    richtext: 'input_richtext',
    number: 'input_number',
    date: 'input_date',
    datetime: 'input_datetime',
    bool: 'input_checkbox',
    select: 'input_select',
    multiselect: 'input_multiselect',
    relation: 'input_relation',
    file: 'input_file',
});

// field type → data_grid column format (the grid's own format vocabulary).
export const FIELD_COLUMN_FORMAT: Readonly<Record<string, string>> = Object.freeze({
    number: 'number',
    date: 'date',
    datetime: 'date',
    bool: 'boolean',
    relation: 'relation',
    select: 'badge',
    multiselect: 'badge',
});

/** newId that avoids everything in `taken`; claims the id so the next call differs. */
function uniqueId(kind: string, taken: Set<string>) {
    let id = newId(kind);
    while (taken.has(id)) id = newId(kind);
    taken.add(id);
    return id;
}

/** Build a component node from the registry defaults with prop overrides. */
function makeNode(type: string, taken: Set<string>, propOverrides: Record<string, unknown> | null | undefined) {
    const entry = APP_COMPONENT_TYPES[type];
    if (!entry) return null;
    const node: AppNode = {
        id: uniqueId('component', taken),
        type,
        visible: true,
        props: { ...deepClone(entry.defaultProps || {}), ...(propOverrides || {}) },
        style: { ...(entry.defaultStyle || {}) },
    };
    if (entry.container) node.children = [];
    return node;
}

/** A select option as the data model may store it besides a plain string. */
interface OptionLike {
    value?: unknown;
    key?: unknown;
    label?: unknown;
}

/** Normalize a data-model select option into the input's { value, label } shape. */
function normalizeOption(opt: unknown) {
    if (opt && typeof opt === 'object') {
        const value = (opt as OptionLike).value ?? (opt as OptionLike).key ?? '';
        return { value: String(value), label: (opt as OptionLike).label != null ? String((opt as OptionLike).label) : String(value) };
    }
    return { value: String(opt), label: String(opt) };
}

/** A field is writable (gets a form input) when it maps to an input component. */
export function isWritableField(field: { type?: string | number }) {
    return !!(field && typeof field.type === 'string' && FIELD_INPUT_TYPE[field.type]);
}

/** Build one form input node for a table field (null for non-writable fields). */
function buildInputNode(field: ImportField & { relation?: { table: string } }, taken: Set<string>) {
    const type = FIELD_INPUT_TYPE[field.type ?? ''];
    if (!type) return null;
    const props: { name: string; label: string; required?: boolean; options?: { value: string; label: string; }[]; tableId?: string | null } = { name: field.key, label: field.name || field.key };
    // Only stamp `required` where the component supports it (checkbox has none).
    if (type !== 'input_checkbox') props.required = !!field.required;
    if (type === 'input_select' || type === 'input_multiselect') {
        props.options = Array.isArray(field.options) ? field.options.map(normalizeOption) : [];
    }
    if (type === 'input_relation') {
        props.tableId = (field.relation && field.relation.table) || null;
    }
    return makeNode(type, taken, props);
}

/**
 * Build a `form` subtree that creates a record in `table`.
 * Returns { node, actions } — `actions` is a { [actionId]: action } map the
 * caller merges into definition.actions; the form's onSubmit already references
 * that id.
 */
export function buildFormForTable(table: ImportTable, { taken }: { taken?: Iterable<string> | null } = {}) {
    const seen = taken instanceof Set ? taken : new Set(taken || []);
    const fields = Array.isArray(table?.fields) ? table.fields : [];
    const writable = fields.filter(isWritableField);

    const children = writable.map((f) => buildInputNode(f, seen)).filter(Boolean) as AppNode[];

    // The create_record action: pull each writable field from the submitted
    // form values by the input's `name` (which we set to the field key).
    const values: Record<string, { kind: string; name: string; }> = {};
    for (const f of writable) values[f.key] = { kind: 'field', name: f.key };

    const actionId = uniqueId('action', seen);
    const action = {
        kind: 'sequence',
        steps: [
            { kind: 'create_record', tableId: table?.id ?? table?.key ?? null, values },
            { kind: 'toast', tone: 'success', message: `${table?.name || 'Record'} saved` },
        ],
    };

    const node = makeNode('form', seen, {
        name: null,
        submitLabel: `Add ${table?.name || 'record'}`,
        showReset: false,
    });
    if (node) {
        node.children = children;
        node.onSubmit = actionId;
    }

    return { node, actions: { [actionId]: action } };
}

/**
 * Build a `data_grid` bound to the table's records, one column per field.
 * Returns { node }.
 */
export function buildGridForTable(table: ImportTable, { taken }: { taken?: Iterable<string> | null } = {}) {
    const seen = taken instanceof Set ? taken : new Set(taken || []);
    const fields = Array.isArray(table?.fields) ? table.fields : [];
    const columns = fields.map((f) => ({
        key: f.key,
        label: f.name || f.key,
        format: FIELD_COLUMN_FORMAT[f.type ?? ''] || 'text',
    }));

    const node = makeNode('data_grid', seen, {
        source: { kind: 'records', tableId: table?.id ?? table?.key ?? null },
        columns,
        searchable: true,
    });

    return { node };
}

export default { buildFormForTable, buildGridForTable, FIELD_INPUT_TYPE, FIELD_COLUMN_FORMAT, isWritableField };
