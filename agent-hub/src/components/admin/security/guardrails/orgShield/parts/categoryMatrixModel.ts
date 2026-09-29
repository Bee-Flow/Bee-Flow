/**
 * The kinds-of-personal-data matrix, as data. Pure.
 *
 * One row per kind, three questions per row: is it hidden from the AI, is it
 * held back from tools outside the organisation, is it held back from tools on
 * the organisation's own server. The columns are NOT equivalent: the first
 * decides what gets FOUND, the other two what may LEAVE. An unticked first
 * column means the kind is never even asked of the model.
 *
 * Kept apart from the markup so the counts the headers print, and the
 * "half protected" finding, can be tested without a render.
 */

import type { PiiGroup } from '../../../../../../config/piiCategories';

export type MatrixColumn = 'detect' | 'external' | 'internal';

export const MATRIX_COLUMNS: MatrixColumn[] = ['detect', 'external', 'internal'];

/** What the matrix needs of a localised category (see piiCategoriesLocalized). */
export interface MatrixKind {
    id: string;
    group: PiiGroup | string;
    label: string;
}

export interface MatrixToolPolicy {
    external?: { blockCategories?: string[] };
    internal?: { blockCategories?: string[] };
}

export type MatrixSelection = Record<MatrixColumn, Set<string>>;

export interface MatrixGroup<K extends MatrixKind = MatrixKind> {
    name: string;
    items: K[];
}

/**
 * The short column names, used where a cell has to name its column (a
 * checkbox's accessible name, "Person names — Outside tools"). The visible
 * headers are longer; see MatrixHead.
 */
export const COLUMN_NAME: Record<MatrixColumn, [string, string]> = {
    detect: ['admin.shield_matrix_col_detect', 'Hide from AI'],
    external: ['admin.shield_matrix_col_external', 'Outside tools'],
    internal: ['admin.shield_matrix_col_internal', 'Own server'],
};

/**
 * Group → i18n key. The catalogue's `group` values are internal English
 * ('EU / Netherlands'), so they need their own keys to be shown.
 */
export const GROUP_KEYS: Record<string, [string, string]> = {
    Personal: ['pii.group_personal', 'Personal'],
    Contact: ['pii.group_contact', 'Contact'],
    Financial: ['pii.group_financial', 'Financial'],
    Identity: ['pii.group_identity', 'Identity'],
    Digital: ['pii.group_digital', 'Digital'],
    Organization: ['pii.group_organization', 'Organisation'],
    'EU / Netherlands': ['pii.group_eu_nl', 'EU / Netherlands'],
};

/**
 * The group's dot, on the validated categorical palette every other surface
 * uses for these groups (PII_GROUP_COLOR_TOKEN). Written out in full because
 * Tailwind only generates classes it can see in the source.
 */
export const GROUP_DOT: Record<string, string> = {
    Personal: 'bg-[var(--pii-cat-1)]',
    Contact: 'bg-[var(--pii-cat-2)]',
    Financial: 'bg-[var(--pii-cat-3)]',
    Identity: 'bg-[var(--pii-cat-4)]',
    Digital: 'bg-[var(--pii-cat-5)]',
    Organization: 'bg-[var(--pii-cat-6)]',
    'EU / Netherlands': 'bg-[var(--pii-cat-7)]',
};

/** A group missing from the catalogue above still gets a dot, in the "other" slot. */
export const OTHER_GROUP_DOT = 'bg-[var(--pii-cat-8)]';

export function selectionOf(detect: readonly string[] | undefined, tools: MatrixToolPolicy | undefined): MatrixSelection {
    return {
        detect: new Set(detect || []),
        external: new Set(tools?.external?.blockCategories || []),
        internal: new Set(tools?.internal?.blockCategories || []),
    };
}

/**
 * How many of the kinds ON SCREEN each column holds.
 *
 * Counted against the rows, not the stored lists: a stored id that is not one
 * of the rows (a kind that left the catalogue) would otherwise make the
 * header read "22 of 21".
 */
export function columnCounts(kinds: readonly MatrixKind[], sel: MatrixSelection): Record<MatrixColumn, number> {
    const count = (col: MatrixColumn) => kinds.filter(k => sel[col].has(k.id)).length;
    return { detect: count('detect'), external: count('external'), internal: count('internal') };
}

/** Groups in catalogue order, which is already meaningful (Personal → … → EU/NL). */
export function groupsOf<K extends MatrixKind>(kinds: readonly K[]): MatrixGroup<K>[] {
    const out: MatrixGroup<K>[] = [];
    for (const kind of kinds) {
        let group = out.find(g => g.name === kind.group);
        if (!group) {
            group = { name: kind.group, items: [] };
            out.push(group);
        }
        group.items.push(kind);
    }
    return out;
}

/** "1 of 2 hidden": how many of a group's kinds the AI never sees. */
export function hiddenInGroup(group: MatrixGroup, sel: MatrixSelection): number {
    return group.items.filter(k => sel.detect.has(k.id)).length;
}

/**
 * Kinds we look for but let every tool carry out anyway.
 *
 * The misconfiguration two separate panes used to produce, and the reason this
 * is one table. Only meaningful for an org that has started using the tool
 * columns at all: with both lists empty, every detected kind is "half open",
 * and saying so 21 times is noise, not a finding. (The outside-tools header
 * already says "anything may leave" in that case.)
 */
export function halfOpen<K extends MatrixKind>(kinds: readonly K[], sel: MatrixSelection): K[] {
    if (sel.external.size === 0 && sel.internal.size === 0) return [];
    return kinds.filter(k => sel.detect.has(k.id) && !sel.external.has(k.id) && !sel.internal.has(k.id));
}

/**
 * "{n} left with tools" for one row, or null when there is nothing to say.
 *
 * `toolKinds` is null when the last 30 days are UNKNOWN (no licence for the
 * figures, or a mount that pins another organisation): that must render
 * nothing, never a zero.
 */
export function leftWithTools(toolKinds: Record<string, number> | null | undefined, id: string): number | null {
    const n = toolKinds ? Number(toolKinds[id]) || 0 : 0;
    return n > 0 ? n : null;
}
