/**
 * The web's recurring phrases, worded through the catalogue with the web's own
 * keys (DatatableCard, DatatableDetail), so a translation an administrator made
 * for the browser appears here too.
 */

import type { TranslateFn } from '@/core/i18n';

import { audienceOf } from './access';
import type { CellErrorCode } from './csvImport';
import type { Datatable, Grade, UsageRow } from './types';

export function gradeLabel(t: TranslateFn, grade: Grade | null): string {
    switch (grade) {
        case 'owner':
            return t('datatables.grade_owner', 'You own this table');
        case 'editor':
            return t('datatables.grade_editor', 'You can read and change rows');
        case 'viewer':
            return t('datatables.grade_viewer', 'You can read rows');
        default:
            return t('datatables.grade_shared', 'Shared with you');
    }
}

/** "1,284 rows" — grouped, because four digits without a separator read as a year. */
export function rowsWord(t: TranslateFn, n: number): string {
    if (n === 1) return t('datatables.one_row', '1 row');
    return t('datatables.n_rows', '{n} rows', { n: n.toLocaleString() });
}

export function columnsWord(t: TranslateFn, n: number): string {
    return n === 1 ? t('datatables.one_column', '1 column') : t('datatables.n_columns', '{n} columns', { n });
}

/** A personal table says "Personal", never "Private": there is no sharing to have. */
export function audienceLabel(t: TranslateFn, table: Pick<Datatable, 'scopeKind' | 'isPublished' | 'sharedGroups'>): string {
    if (table.scopeKind === 'user') return t('datatables.audience_personal', 'Personal');
    switch (audienceOf(table)) {
        case 'org':
            return t('datatables.audience_org', 'Whole organisation');
        case 'groups':
            return t('datatables.audience_groups', 'Shared with groups');
        default:
            return t('datatables.audience_private', 'Private');
    }
}

/** ["a","b","c"] → "a, b and c" (datatableDisplay.joinNames). */
export function joinNames(t: TranslateFn, names: readonly string[]): string {
    const list = names.filter(Boolean);
    if (list.length <= 1) return list[0] ?? '';
    return t('mobile.datatables.names_and', '{list} and {last}', { list: list.slice(0, -1).join(', '), last: list[list.length - 1] ?? '' });
}

/**
 * Who can READ the rows and, separately, who can CHANGE them — two columns on
 * the server (datatableDisplay.describeAccess), because publishing a table
 * must never be what made it writable by everyone.
 */
export function describeAccess(
    t: TranslateFn,
    table: Pick<Datatable, 'isPublished' | 'sharedGroups' | 'writeMode'>,
    groupName: (id: string) => string,
): { readers: string; writers: string; broad: boolean } {
    const audience = audienceOf(table);
    const readers =
        audience === 'private'
            ? t('mobile.datatables.readers_private', 'Only you and the people you share it with')
            : audience === 'org'
              ? t('mobile.datatables.readers_org', 'Everyone in your organisation')
              : t('mobile.datatables.readers_groups', 'Members of {groups}', { groups: joinNames(t, table.sharedGroups.map(groupName)) });
    const writers =
        table.writeMode === 'audience'
            ? audience === 'private'
                ? t('mobile.datatables.writers_same', 'the same people')
                : t('mobile.datatables.writers_all', 'all of them')
            : t('mobile.datatables.writers_invited', 'only the people you invite');
    return { readers, writers, broad: audience === 'org' && table.writeMode === 'audience' };
}

/** Each filter operator with the web's RowFilterBuilder key and words. */
const OP_WORDS: Readonly<Record<string, readonly [string, string]>> = {
    eq: ['datatables.op_eq', 'is'],
    neq: ['datatables.op_neq', 'is not'],
    gt: ['datatables.op_gt', 'is more than'],
    gte: ['datatables.op_gte', 'is at least'],
    lt: ['datatables.op_lt', 'is less than'],
    lte: ['datatables.op_lte', 'is at most'],
    contains: ['datatables.op_contains', 'contains'],
    notContains: ['datatables.op_not_contains', 'does not contain'],
    startsWith: ['datatables.op_starts_with', 'starts with'],
    endsWith: ['datatables.op_ends_with', 'ends with'],
    in: ['datatables.op_in', 'is one of'],
    notIn: ['datatables.op_not_in', 'is none of'],
    between: ['datatables.op_between', 'is between'],
    isNull: ['datatables.op_is_null', 'is empty'],
    isNotNull: ['datatables.op_is_not_null', 'is filled in'],
};

export function opLabel(t: TranslateFn, op: string): string {
    const words = OP_WORDS[op];
    return words ? t(words[0], words[1]) : op;
}

export function yesNo(t: TranslateFn): { yes: string; no: string } {
    return { yes: t('common.yes', 'Yes'), no: t('common.no', 'No') };
}

/** Why one cell or editor value will not do. */
export function cellErrorText(t: TranslateFn, code: CellErrorCode, text = ''): string {
    switch (code) {
        case 'required':
            return t('mobile.datatables.cell_required', 'This can’t be empty');
        case 'number':
            return t('mobile.datatables.cell_number', '“{text}” is not a number', { text });
        case 'yesno':
            return t('mobile.datatables.cell_yesno', '“{text}” is not a yes or a no', { text });
        case 'date':
            return t('mobile.datatables.cell_date', '“{text}” is not a date (try 2026-03-14 or 14-03-2026)', { text });
        case 'datetime':
            return t('mobile.datatables.cell_datetime', '“{text}” is not a date and time (try 2026-03-14 09:30)', { text });
        default:
            return t('mobile.datatables.cell_choice', '“{text}” is not one of the choices', { text });
    }
}

/** Where inside a consumer the table is used: "step 3 · insert", else the columns it names. */
export function siteText(t: TranslateFn, row: UsageRow): string {
    const parts: string[] = [];
    if (row.stepOrdinal) parts.push(t('mobile.datatables.step_n', 'step {n}', { n: row.stepOrdinal }));
    if (row.stepOp) parts.push(row.stepOp.replace(/_/g, ' '));
    if (!parts.length && row.columns.length) parts.push(row.columns.join(', '));
    return parts.join(' · ');
}
