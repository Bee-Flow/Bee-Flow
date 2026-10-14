/**
 * Shapes the Datatables screens read from the server. The server owns them;
 * these describe what the components rely on.
 */

export interface DatatableColumn {
    key: string;
    name?: string | null;
    label?: string | null;
    type?: string | null;
    options?: unknown;
}

/** A datatable as the screens receive it. Fields not listed here are read by the display helpers. */
export interface DatatableRecord {
    id: string;
    name?: string | null;
    key?: string;
    description?: string | null;
    sharedGroups?: string[] | null;
    writeMode?: string | null;
    ownerUserId?: string | null;
    columns?: DatatableColumn[] | null;
    source?: { automationId?: string | null; provider?: string | null; [key: string]: unknown } | null;
    scopeKind?: string | null;
    managedKind?: string | null;
    grade?: string;
    rowCount?: number;
    usageCount?: number | null;
    retentionDays?: number | null;
    retentionField?: string | null;
    lastRetentionAt?: string | null;
    sync?: SourceSync | null;
    [key: string]: unknown;
}

/** The sync state of a mirrored table. */
export interface SourceSync {
    status?: string | null;
    lastError?: string | null;
    lastErrorCode?: string | null;
    lastSuccessAt?: string | null;
    lastSyncAt?: string | null;
    truncated?: boolean | null;
}

/** A column of a table's schema, as the relations and filters read it. */
export interface SchemaField {
    id: string;
    name: string;
    type: string;
    derived?: boolean;
}

/** The three ids a relation between two tables is made of. */
export interface RelationTriple {
    targetDatatableId: string;
    localFieldId: string;
    targetFieldId: string;
}

/** A relation the source carries: its own locked ones (`nc`) or the ones declared here (`match`). */
export interface SourceRelation extends RelationTriple {
    fieldId: string;
    kind: string;
    labelFieldId?: string | null;
}

/** Where a mirrored table comes from and who linked it. */
export interface SourceInfo {
    rowCap?: number | null;
    linkedByUserId?: string | null;
    linkedAt?: string | null;
    provider?: string | null;
    relations?: SourceRelation[] | null;
    keyColumn?: { fieldId: string } | null;
}

export interface RefreshResult {
    alreadyRunning?: boolean;
    warnings?: string[] | null;
}

/** The mirror handle a source tab is drawn from. */
export interface SourceMirror {
    source?: SourceInfo | null;
    sync?: SourceSync | null;
    refreshNow: () => Promise<RefreshResult | null | undefined>;
    setRelations: (relations: RelationTriple[]) => Promise<unknown>;
}

/** Where a new table would go: the organisation, or this account alone. */
export interface DatatableScope {
    kind?: string | null;
    [key: string]: unknown;
}
