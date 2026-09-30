/**
 * The datatable step, the pure half of the web's DatatableFields
 * (datatableEditors.jsx). NOTHING IS FREE TEXT: the table comes from a list
 * the server filtered by what this person may use, a column from that
 * table's declared columns, the test from a closed operator list narrowed by
 * the column's type; only the VALUE is a binding. Pinned by
 * datatable.lockstep.test.ts.
 */

import type { CatalogDatatable, CatalogDatatableOp } from '@/features/flow-editor/api';
import { buildPatch, extractFormState, type FormDraft, type StepPatch } from '@/features/flow-editor/formState';

import { msg, type Msg } from '../declarative/spec';
import type { StepForm } from '../types';

/** core/dataEngine FILTER_OPS, in the words a person would use. */
export const OPS: readonly { op: string; label: Msg }[] = [
    { op: 'eq', label: msg('mobile.flow.datatable.op_eq', 'is') },
    { op: 'neq', label: msg('mobile.flow.datatable.op_neq', 'is not') },
    { op: 'contains', label: msg('mobile.flow.datatable.op_contains', 'contains') },
    { op: 'notContains', label: msg('mobile.flow.datatable.op_not_contains', 'does not contain') },
    { op: 'startsWith', label: msg('mobile.flow.datatable.op_starts_with', 'starts with') },
    { op: 'endsWith', label: msg('mobile.flow.datatable.op_ends_with', 'ends with') },
    { op: 'gt', label: msg('mobile.flow.datatable.op_gt', 'is more than') },
    { op: 'gte', label: msg('mobile.flow.datatable.op_gte', 'is at least') },
    { op: 'lt', label: msg('mobile.flow.datatable.op_lt', 'is less than') },
    { op: 'lte', label: msg('mobile.flow.datatable.op_lte', 'is at most') },
    { op: 'in', label: msg('mobile.flow.datatable.op_in', 'is one of') },
    { op: 'notIn', label: msg('mobile.flow.datatable.op_not_in', 'is none of') },
    { op: 'between', label: msg('mobile.flow.datatable.op_between', 'is between') },
    { op: 'isNull', label: msg('mobile.flow.datatable.op_is_null', 'is empty') },
    { op: 'isNotNull', label: msg('mobile.flow.datatable.op_is_not_null', 'is not empty') },
];

const TEXTUAL = new Set(['text', 'richtext', 'select', 'multiselect', 'relation', 'file']);
const ORDERED = new Set(['number', 'date', 'datetime']);
const TEXT_ONLY = ['contains', 'notContains', 'startsWith', 'endsWith'];

/** A date never offers "contains"; a yes/no only is, is not, empty. */
export function opsForType(type: string | null | undefined): readonly { op: string; label: Msg }[] {
    if (!type) return OPS;
    if (TEXTUAL.has(type)) return OPS.filter((o) => !['gt', 'gte', 'lt', 'lte', 'between'].includes(o.op));
    if (ORDERED.has(type)) return OPS.filter((o) => !TEXT_ONLY.includes(o.op));
    if (type === 'bool') return OPS.filter((o) => ['eq', 'neq', 'isNull', 'isNotNull'].includes(o.op));
    return OPS;
}

/** `isNull` / `isNotNull` are the whole condition on their own. */
export const opTakesNoValue = (op: unknown): boolean => op === 'isNull' || op === 'isNotNull';

/** What the chosen operation needs from the form. */
export function opNeeds(op: string): { writes: boolean; values: boolean; match: boolean; where: boolean } {
    // count_rows READS: how many rows match — the number find_rows cannot give.
    const writes = op !== 'find_rows' && op !== 'count_rows';
    return { writes, values: writes && op !== 'delete_rows', match: op === 'save_row', where: op === 'update_rows' || op === 'delete_rows' };
}

/** The ops the server offers, or find_rows alone. */
export const opChoices = (ops: readonly CatalogDatatableOp[]): readonly { op: string; label: Msg | string; blurb?: string }[] =>
    ops.length ? ops.map((o) => ({ op: o.op, label: o.label, blurb: o.blurb })) : [{ op: 'find_rows', label: msg('mobile.flow.datatable.find_rows', 'Find rows') }];

/** A table's option: its name, where it comes from, whether it is shared, and — for a write — whether this person may. */
export function tableOption(table: CatalogDatatable, writes: boolean): { value: string; label: string; notes: Msg[]; disabled: boolean } {
    const notes: Msg[] = [];
    if (table.managedKind === 'nextcloud_table') notes.push(msg('mobile.flow.datatable.from_nextcloud', 'from Nextcloud'));
    else if (table.managedKind === 'spreadsheet_file') notes.push(msg('mobile.flow.datatable.from_spreadsheet', 'from a spreadsheet'));
    if (table.scope !== 'personal') notes.push(msg('mobile.flow.datatable.shared', 'shared'));
    const readOnly = writes && !table.canWrite;
    if (readOnly) notes.push(msg('mobile.flow.datatable.read_only', 'you can only read this one'));
    return { value: table.id, label: table.name, notes, disabled: readOnly };
}

export interface WhereRow {
    field?: string;
    op?: string;
    value?: unknown;
}

export const newCondition = (): WhereRow => ({ field: '', op: 'eq', value: '' });

/** The one sort entry the list compiler honours (`sort[0]`): a second would read as a tie-break it ignores. */
export function sortEntry(sort: unknown): { field: string; dir: string } | null {
    const first = Array.isArray(sort) ? (sort[0] as { field?: unknown; dir?: unknown } | undefined) : undefined;
    return first && typeof first.field === 'string' && first.field ? { field: first.field, dir: first.dir === 'asc' ? 'asc' : 'desc' } : null;
}

export const setSort = (field: string, dir: string | undefined): { field: string; dir: string }[] => (field ? [{ field, dir: dir || 'desc' }] : []);

/**
 * The step's draft and patch: formState's, plus the two keys the web's form
 * shows but its formState never carries — `match` (all / any) and `sort` —
 * so a choice made here is saved rather than dropped on the next save. Each
 * is written only when it changed; the defaults (all, newest first) are
 * stored as absence.
 */
export const DATATABLE_FORM: StepForm = {
    extract: (step) => ({ ...extractFormState(step), match: step.match === 'any' ? 'any' : 'all', sort: setSort(sortEntry(step.sort)?.field ?? '', sortEntry(step.sort)?.dir) }),
    patch: (step, draft: FormDraft): StepPatch => {
        const patch = buildPatch(step, draft);
        const match = draft.match === 'any' ? 'any' : undefined;
        if (match !== (step.match === 'any' ? 'any' : undefined)) patch.match = match;
        const entry = sortEntry(draft.sort);
        const before = sortEntry(step.sort);
        if (JSON.stringify(entry) !== JSON.stringify(before)) patch.sort = entry ? [entry] : undefined;
        return patch;
    },
};
