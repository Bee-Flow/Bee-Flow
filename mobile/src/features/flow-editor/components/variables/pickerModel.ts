/**
 * The variable picker's rows, as pure data — the list half of the web's
 * VariablePicker / VariableTree / InputDataPanel (agent-hub
 * `Builder/mapping/`), over the groups `computeUpstreamGroups` describes.
 *
 * One flat list (a FlatList wants one): a header row per group, then its
 * fields, a nested field's children only once it is opened — or, while
 * searching, every surviving descendant, since a hit three levels down is the
 * reason the person searched. The nearest step comes FIRST: the web lists the
 * groups trigger-first in a panel that shows them all at once, and on a phone
 * the step just before this one is the one almost every pick comes from.
 */

import {
    collectArrayPaths,
    filterGroups,
    previewValue,
    walkPath,
    type VariableField,
    type VariableGroup,
} from '@/features/flow-editor/bindings';

export interface GroupRow {
    kind: 'group';
    id: string;
    group: VariableGroup;
    /** How many fields the group offers (after the search). */
    count: number;
}

export interface FieldRow {
    kind: 'field';
    id: string;
    groupId: string;
    field: VariableField;
    depth: number;
    hasChildren: boolean;
    expanded: boolean;
    preview: string;
}

export type PickerRow = GroupRow | FieldRow;

/**
 * A field's sample for display. A `[*]` path's `sample` is its FIRST element
 * (the collection convention), so it is resolved through the sample root
 * instead, as the web's resolveLeafPreview does.
 */
export function fieldPreview(field: Pick<VariableField, 'path' | 'sample'>, sampleRoot: unknown = null): string {
    if (sampleRoot) {
        const v = walkPath(field.path, sampleRoot);
        if (v !== undefined) return previewValue(v, 60);
    }
    return previewValue(field.sample, 60);
}

interface RowOptions {
    expanded: ReadonlySet<string>;
    searching: boolean;
    sampleRoot: unknown;
}

interface Walk extends RowOptions {
    groupId: string;
    out: PickerRow[];
}

function fieldRows(fields: readonly VariableField[], depth: number, walk: Walk): void {
    const { groupId, out, ...opts } = walk;
    for (const field of fields) {
        const children = Array.isArray(field.children) ? field.children : [];
        const expanded = children.length > 0 && (opts.searching || opts.expanded.has(field.path));
        out.push({
            kind: 'field',
            id: `${groupId}:${field.path}`,
            groupId,
            field,
            depth,
            hasChildren: children.length > 0,
            expanded,
            preview: fieldPreview(field, opts.sampleRoot),
        });
        if (expanded) fieldRows(children, depth + 1, walk);
    }
}

/** Every row the picker shows for these groups and this search. */
export function pickerRows(
    groups: readonly VariableGroup[] | null | undefined,
    { query = '', expanded = new Set<string>(), sampleRoot = null }: { query?: string; expanded?: ReadonlySet<string>; sampleRoot?: unknown } = {},
): PickerRow[] {
    const searching = query.trim() !== '';
    const visible = filterGroups([...(groups || [])], query).slice().reverse();
    const out: PickerRow[] = [];
    for (const group of visible) {
        out.push({ kind: 'group', id: `group:${group.id}`, group, count: (group.fields || []).length });
        fieldRows(group.fields || [], 0, { groupId: group.id, out, expanded, searching, sampleRoot });
    }
    return out;
}

/**
 * The picker for a field that wants a LIST: only the lists found upstream
 * (nested and real-run ones included), as the web's quick picks offer them.
 */
export function listRows(
    groups: readonly VariableGroup[] | null | undefined,
    { query = '', sampleRoot = null }: { query?: string; sampleRoot?: unknown } = {},
): FieldRow[] {
    const needle = query.trim().toLowerCase();
    return collectArrayPaths([...(groups || [])], sampleRoot)
        .filter((f) => !needle || f.key.toLowerCase().includes(needle) || f.path.toLowerCase().includes(needle))
        .map((field) => ({
            kind: 'field',
            id: `list:${field.path}`,
            groupId: 'lists',
            field,
            depth: 0,
            hasChildren: false,
            expanded: false,
            preview: fieldPreview(field, sampleRoot),
        }));
}

/** Open or close one nested field. */
export function toggleExpanded(expanded: ReadonlySet<string>, path: string): Set<string> {
    const next = new Set(expanded);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
}
