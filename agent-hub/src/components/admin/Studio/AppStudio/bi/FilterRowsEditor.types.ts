import type { AppDefinition, AppNode } from '../inspector/appDefinition';

/**
 * App Studio — the shared filter-row editor.
 *
 * A repeatable list of structured `{ field, op, value?, required? }` rows over a
 * table's fields, using the closed FILTER_OPS vocabulary the server query
 * compiler consumes (server/appStudio/queryCompiler.js). Extracted from
 * QueryBuilder so both the BI dataset builder and the inspector's
 * record/records BindingField share ONE filter UI and one shape.
 *
 * The value control follows the chosen field's type (yes/no, date, number, one
 * of its choices, a list for `is one of`, a pair for `between`), with a per-row
 * "type any value" escape back to free text.
 *
 * ── WHY THE ESCAPE IS DERIVED, NOT REMEMBERED ───────────────────────
 * That escape used to be UI-only state keyed by row INDEX, which broke twice
 * over. Deleting or reordering a row left the marker pointing at a different
 * row; and because it did not survive a reload, a SAVED value the typed control
 * cannot represent — `value: 'maybe'` on a yes/no column, a select value no
 * longer among the options — rendered as an empty control with the real value
 * invisible, and the first click overwrote it. So representability is now read
 * off the data (isRepresentable) and the remembered set only records the
 * "I just clicked the pencil" case, keyed by the row OBJECT: RepeatableList
 * removes with filter() and reorders with a swap, so row objects keep their
 * identity across both.
 *
 * `allowFormula` (BindingField only) adds a per-row Literal↔Formula toggle: a
 * formula row emits `value: { kind:'formula', expr }`, resolved client-side
 * against the live scope before fetch (validate.js accepts both forms). It also
 * turns on the `required` toggle, because a formula is the only value that can
 * fail to resolve. The dataset builder leaves it off — aggregate filters are
 * always literals.
 */

/** A formula value: resolved client-side against the live scope before fetch. */
export interface FormulaValue {
    kind: string;
    expr: string;
}

/** What a filter row compares against: a literal, a list or pair, or a formula. */
export type FilterValue = string | number | boolean | string[] | FormulaValue;

/** What the other mode of a row held, kept for the way back. */
export interface Stash {
    literal?: FilterValue;
    formula?: string;
}

/** One structured filter row. With `otherField` it compares two columns of the row and carries no value. */
export interface FilterRow {
    field: string;
    op: string;
    value?: FilterValue;
    otherField?: string;
    required?: boolean;
    /** `eq` on text without regard to upper/lower case. Written only when switched on. */
    ci?: boolean;
}

/** An `{ any: [...] }` OR group: its entries OR each other, the group ANDs with the other entries. */
export interface FilterAnyGroupRow {
    any: FilterEntry[];
    required?: boolean;
}

/** An `{ all: [...] }` AND group: what "(a and b) or c" needs inside an OR group. */
export interface FilterAllGroupRow {
    all: FilterEntry[];
    required?: boolean;
}

/** A `{ not: entry }` group: the rows its entry does not match. */
export interface FilterNotGroupRow {
    not: FilterEntry;
    required?: boolean;
}

/** One entry of a filter list: a row or a group (groups nest three deep). */
export type FilterEntry = FilterRow | FilterAnyGroupRow | FilterAllGroupRow | FilterNotGroupRow;

/** Where a filter list sits: the top level, or inside a group of this kind. */
export type FilterGroupKind = 'any' | 'all' | 'none';

/** A column a filter may name; select choices are strings or { value, label } objects. */
export interface FilterField {
    key: string;
    name?: string;
    type?: string;
    options?: Array<string | number | boolean | null | { value?: unknown; key?: unknown; label?: unknown }>;
}

/** The typed literal control for one row (never rendered for a formula row). */
export interface ValueControlProps {
    control: string;
    f: FilterRow;
    field: FilterField | null;
    update: (next: FilterRow) => void;
}

export interface FilterRowsEditorProps {
    fields?: FilterField[];
    filters: FilterEntry[];
    onChange: (next: FilterEntry[]) => void;
    /** Offer the "Add a group" buttons. Groups already saved always render as groups. */
    allowGroups?: boolean;
    /** Group levels above this list (0 at the top) and the kind of the group it is in. */
    depth?: number;
    parentKind?: FilterGroupKind | null;
    /** At most this many entries (a "none of these" group that has no level left for a second one). */
    maxItems?: number;
    definition?: AppDefinition | null;
    node?: AppNode | null;
    allowFormula?: boolean;
    /** Offer "ignore upper/lower case" on an `is` row over a text column (reads only: bindings). */
    allowIgnoreCase?: boolean;
    label?: string;
    disabled?: boolean;
}
