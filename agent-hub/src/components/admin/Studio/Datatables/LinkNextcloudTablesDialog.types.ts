import type { RelTable, RelColumn, Relation, LockedRelation } from './linkWizardShared';
import type { SourceError } from './sourceMirrors';
import type { WizardError } from './spreadsheet/wizardState';
import type { Linkable } from './newDatatable/useLinkSources';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type React from 'react';

export type NcId = number | string;

/** A view of a Nextcloud table, as the linkable list carries it. */
export interface NcView {
    ncViewId: NcId;
    title: string;
    linkedAs?: unknown[];
}

/** A Nextcloud table (or, in a selection, a view) as the linkable list carries it. */
export interface NcTableEntry {
    ncTableId: NcId;
    ncViewId?: NcId | null;
    title: string;
    emoji?: string | null;
    views?: NcView[];
    linkedAs?: unknown[];
    rowsCount?: number | null;
    columnsCount?: number | null;
}

/** A column of a Nextcloud table, as describeNc previews it. */
export interface NcColumn {
    ncColumnId: NcId;
    title: string;
    type: string;
    subtype?: string;
    mappedType: string;
    mandatory?: boolean;
    relationTarget?: { ncTableId: NcId } | null;
}

/** A ticked table or view, with the names it will get. */
export interface NcSelection extends RelTable {
    refKey: string;
    ncTableId: NcId;
    ncViewId: NcId | null;
    title: string;
    emoji: string | null;
    description: string;
    keyTouched: boolean;
}

/** The column preview of one selection: in flight, failed or read. */
export interface NcDescribe {
    loading: boolean;
    columns: NcColumn[];
    error?: string | null;
}

/** A relation column the editor shows, plus the integer Nextcloud knows it by. */
export interface NcRelColumn extends RelColumn {
    ncColumnId: NcId;
}

/** A relation as the wire body reads it. */
export interface NcRelation extends Relation {
    from: NcSelection;
    to: NcSelection;
    localColumn: NcRelColumn;
    targetColumn: NcRelColumn;
}

/** A failed link: the refusal code, and the row it is about. */
export type LinkError = SourceError & WizardError & { body?: { ncTableId?: NcId; key?: string } | null };

/**
 * Link one or several Nextcloud tables as datatables — four steps in one
 * dialog (Datatables artboard 1c, second sheet).
 *
 *   1. Which tables?     the linkable list, views as sub-rows, already-linked
 *                        rows disabled
 *   2. Names and columns per table: name, technical name, purpose, and a
 *                        preview of the columns as they will arrive
 *   3. Relations         Nextcloud's own relation columns, locked; same-title
 *                        suggestions, opt-in; and your own "A.x matches B.y"
 *   4. Review            the audience, the list, the relations, then Link
 *
 * A separate dialog from NewDatatableDialog because the 520px form cannot
 * hold a multi-select with views, per-table names, column previews and a
 * relation editor; and a separate file so it has tests of its own.
 *
 * The relations editor is a LIST, not the App Studio ReactFlow map: that map
 * pulls in @xyflow and its stylesheet for two to four tables that need four
 * selects, not a canvas.
 *
 * Relations name their columns by NEXTCLOUD ids (`{ncTableId, ncColumnId}`):
 * the datatable fields do not exist until the link is made, so there is
 * nothing else to name them by yet. The server resolves them.
 *
 * The step strip, the relations editor and the review's relation list are
 * shared with the spreadsheet wizard (linkWizardShared.jsx). That editor
 * knows a column as `{id, title, type}`; the mapping below keeps
 * `ncColumnId` on each column object so the body sent to the server is the
 * integer Nextcloud knows — the wire is unchanged by the extraction.
 */
export interface LinkNextcloudTablesDialogProps {
    scope: string;
    linkable: Linkable | null;
    onBack: () => void;
    onClose: () => void;
    /** A method type, so a handler that reads the linked tables stays assignable. */
    onLinked(body: unknown): void;
}

export interface TablesStepProps {
    t: TranslateFn;
    tables: NcTableEntry[];
    selection: Map<string, NcSelection>;
    onToggle: (row: NcTableEntry) => void;
    marks: Map<string, string>;
    query: string;
    onQuery: React.Dispatch<React.SetStateAction<string>>;
    total: number;
}

export interface TableRowProps {
    t: TranslateFn;
    row: Pick<NcTableEntry, 'title' | 'emoji' | 'linkedAs' | 'rowsCount' | 'columnsCount'> & { ncTableId?: NcId };
    refKey?: string;
    checked: boolean;
    onToggle: React.ChangeEventHandler<HTMLInputElement, HTMLInputElement>;
    mark?: string;
    isView?: boolean;
}

export interface NamesStepProps {
    t: TranslateFn;
    selected: NcSelection[];
    describes: Map<string, NcDescribe>;
    onChange: (refKey: string, patch: Partial<NcSelection>) => void;
    keyDup: string[];
    marks: Map<string, string>;
    onSelectTarget: (ncTableId: NcId | undefined) => void;
    selectedTableIds: Set<NcId>;
}

export interface ReviewStepProps {
    t: TranslateFn;
    selected: NcSelection[];
    relations: Relation[];
    locked: LockedRelation[];
    scope: string;
    onChangeScope: React.MouseEventHandler<HTMLButtonElement>;
}
