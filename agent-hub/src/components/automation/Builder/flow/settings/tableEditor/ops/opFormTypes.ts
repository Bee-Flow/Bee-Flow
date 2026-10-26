import type { TableColumn } from '@/api/queries/automation/runTables';
import type { DescribedColumn } from '@/api/queries/automation/tablePreview';
import type { OpHelp } from '../opHelp';
import type { FieldIssue, TableOp } from '../tableOpModel';

/** What every operation form is handed besides its own operation. */
export interface OpContext {
    /** The columns that flow into this operation; null while they are not known. */
    columns: TableColumn[] | null;
    /** What the sample says each column holds (by key); empty before a preview. */
    described: ReadonlyMap<string, DescribedColumn>;
    /** The findings and errors of this operation, with the field they name. */
    issues: readonly (FieldIssue & { rest: string })[];
    help: OpHelp;
    /** The columns of the second table of a join, when known. */
    otherColumns: TableColumn[] | null;
    /** The first row of the table that reaches this operation, to show real values while building. */
    sampleRow: Record<string, unknown> | null;
    onFocusField?: unknown;
    previewSample?: unknown;
    groups?: unknown[];
}

export interface OpFormProps<T extends TableOp> {
    op: T;
    onChange: (next: T) => void;
    ctx: OpContext;
}
