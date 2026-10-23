import type { DtColumn, DtTable } from './rowBrowser/rowBrowserModel';
import type { MirrorSource, SourceError } from './sourceMirrors';
import type { SourceMirror } from './useSourceMirror';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type React from 'react';
import type { destructiveChanges } from './datatableDisplay';

/** A column as the designer edits it. */
export interface Field extends DtColumn {
    options?: string[];
    unique?: boolean;
}

/** The table as the designer reads it. */
export interface DesignerTable extends DtTable {
    name?: string;
    description?: string | null;
    source?: MirrorSource | null;
}

/** An automation step that touches a column, as the usage index lists it. */
export interface UsageReader {
    consumerTitle?: string | null;
    consumerId?: string;
    automationId?: string;
    automationTitle?: string | null;
    stepOrdinal?: number | string;
    mode?: string;
    columns?: (string | null | undefined)[];
}

/** A failed save: the server's code and status, and a managing stage if one holds the table. */
export type SaveError = SourceError & { status?: number; managed?: { message?: string } | null };

/** The same, once `managed` is known to be there. */
export type ManagedSaveError = SaveError & { managed: { message: string } };

/**
 * The columns of one table (Datatables artboard 1d).
 *
 * Three things make this different from an ordinary settings form:
 *
 * 1. SAVING CAN DESTROY DATA. Removing a column drops it, and retyping one
 *    rewrites it; both are irreversible against live rows. So the Save button
 *    does not save — it shows what would be lost, names the automations that
 *    read the affected columns, and only then offers to go ahead.
 * 2. IT IS SHARED. Another owner may be editing the same table. The read hands
 *    back `modelVersion` and the write sends it back, so a concurrent edit
 *    comes back as a 409 with the other person's version rather than silently
 *    overwriting them — and the panel says so instead of losing the work.
 * 3. SOME COLUMNS ARE NOT THE AUTHOR'S. On a MANAGED table (`managedKind`) a
 *    feature writes named columns on a schedule, so dropping or retyping one is
 *    a 500 at 3am that the person who did it will never see. The server refuses
 *    it (409 `managed_column`); this refuses it here, because a control you can
 *    only find out is forbidden by using it is not a control.
 *
 * ── WHY THE SAVE BAR STAYS, AGAINST THE ARTBOARD ────────────────────
 * 1d draws inline editing with no save bar. That works for a form whose
 * every write succeeds; it cannot work here, because `doSave` has a
 * three-way 409 — `managed_column` (the server owns this column),
 * `breaking_change` (something still reads it, confirm against the list) and
 * a bare version conflict (reload, someone else won) — and each one needs a
 * different answer from the person. An autosave that hits any of them has
 * nowhere to put the question. So the bar stays, sticky at the foot of the
 * list, with its aria-live region: every one of those messages appears
 * WITHOUT the focus moving.
 *
 * ── THE GRIP IS THE REORDER (Ronde 2, 2a) ───────────────────────────
 * Order is what putSchema persists and what the Rows table renders
 * left-to-right; migrationPlan diffs BY ID, so a pure reorder emits no DDL
 * and touches no data. The second design round drops the two arrow buttons
 * beside the grip: the handle drags (HTML5 drag and drop, row by row), and
 * because a handle a keyboard cannot reach would be the arrows' loss with
 * nothing in their place, the grip is a BUTTON — focus it and ↑/↓ move the
 * column, which is what the arrows did. The rows are compact: the name and
 * its "n automations" pill, the kind, the example (a choice column shows
 * its options as chips), the remove — no technical name, no "your own
 * column"; a locked or source column keeps its one-line hint because that
 * is information, not decoration.
 */
export interface ColumnDesignerProps {
    table: DesignerTable;
    canEdit: boolean;
    usage?: UsageReader[];
    mirror?: SourceMirror | null;
    onChanged?: () => Promise<void>;
    onOpenUsage?: (() => void) | null;
}

/** The pill's hover card: which automation step touches this column, and how. */
export interface UsageSummaryProps {
    t: TranslateFn;
    readers: UsageReader[];
}

export interface ColumnRowProps {
    t: TranslateFn;
    field: Field;
    managedKind: string | null;
    sample: Record<string, unknown> | null;
    readers: UsageReader[];
    onChange: (patch: Partial<Field>) => void;
    drag?: {
        start: () => void;
        over: React.DragEventHandler<HTMLLIElement>;
        drop: React.DragEventHandler<HTMLLIElement>;
        end: () => void;
    } | null;
    onOpenUsage?: (() => void) | null;
    canEdit: boolean;
    locked: boolean;
    first: boolean;
    last: boolean;
    onMove: (value: number) => void;
    onRemove: () => void;
    ncColumn?: string | null;
    onRemoveRetired?: (() => Promise<void>) | null;
}

/**
 * The dialog that stands between a column list and a data loss.
 *
 * It names three things a bare "are you sure?" leaves out: WHAT is going
 * (which columns), HOW MUCH (the row count — "deletes a column" and "deletes
 * 40,000 values" are different decisions), and WHO ELSE (the automations that
 * read those columns, which is the part the person cannot look up themselves).
 *
 * Through the shared Modal, so ESC closes it, focus is trapped inside it and
 * restored behind it. It used to be a bare `fixed inset-0` div: keyboard focus
 * stayed on the Save button underneath, which is a destructive dialog you can
 * tab straight past.
 */
export interface DestructiveConfirmProps {
    t: TranslateFn;
    changes: ReturnType<typeof destructiveChanges> | null;
    usage: UsageReader[];
    rowCount: number;
    busy: boolean;
    onCancel: () => void;
    onConfirm: () => Promise<void>;
}
