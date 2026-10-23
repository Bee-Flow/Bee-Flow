import type { MirrorTable } from './sourceMirrors';

/** What the display helpers read of a datatable in the list. */
export interface DatatableCardTable extends MirrorTable {
    isPublished?: boolean;
    sharedGroups?: string[] | null;
    writeMode?: string;
}

/** A column every table of a managed kind must carry. */
export interface ManagedColumn {
    key: string;
    type: string;
    required?: boolean;
    unique?: boolean;
}
