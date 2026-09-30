/**
 * Datatables — the shapes the phone reads from `/api/datatables`
 * (server/routes/datatables/**). Every one of them is produced by a reader in
 * api/readers.ts; nothing here is trusted straight off the wire.
 */

/** What the caller may do with a table (auth/datatableAccess). */
export type Grade = 'owner' | 'editor' | 'viewer';

/** The column types a datatable may hold (dataModel/datatableFields DATATABLE_FIELD_TYPES). */
export const COLUMN_TYPE_IDS = [
    'text', 'richtext', 'number', 'date', 'datetime', 'bool', 'select', 'multiselect', 'file',
] as const;
export type ColumnType = (typeof COLUMN_TYPE_IDS)[number];

/** One column, as `normalizeFields` stores it. `relation` arrives only on a Nextcloud mirror. */
export interface Column {
    id: string;
    key: string;
    name: string;
    type: ColumnType | 'relation' | 'unknown';
    options: string[];
    required: boolean;
    unique: boolean;
}

/** A column as the designer holds it before the server has minted an id. */
export interface ColumnDraft {
    id?: string;
    key: string;
    name: string;
    type: ColumnType;
    options?: string[];
    required?: boolean;
    unique?: boolean;
}

/** routes/datatables/projection.publicTable, as far as the phone reads it. */
export interface Datatable {
    id: string;
    name: string;
    key: string;
    description: string;
    rowCount: number;
    rowScope: 'all' | 'own';
    isPublished: boolean;
    sharedGroups: string[];
    writeMode: 'grants' | 'audience';
    /** Days a row is kept, counted from `retentionField`; null keeps rows until something deletes them. */
    retentionDays: number | null;
    /**
     * The date column the age is counted from. The server column is NOT NULL
     * with a `created_at` default, so it carries a value even while no window
     * is set — only `retentionDays` says whether rows are ever deleted.
     */
    retentionField: string | null;
    /** When the retention sweep last ran over this table. */
    lastRetentionAt: string | null;
    managedKind: string | null;
    /** A mirror's source block; the phone only asks whether writes go through. */
    sourceWritable: boolean | null;
    ownerUserId: string | null;
    updatedAt: string | null;
    scopeKind: 'org' | 'user';
    grade: Grade | null;
    /** Only on the list: distinct consumers of any kind. */
    usageCount: number;
}

/**
 * The retention half of PATCH /:id. The window and the column it counts from
 * travel TOGETHER: the server refuses a non-null `retentionDays` without a
 * `retentionField` in the same request (`retention_field_required`), and
 * turning the window off sends the null alone.
 */
export type RetentionPatch = { retentionDays: null; retentionField?: undefined } | { retentionDays: number; retentionField: string };

/** What PATCH /:id may carry from the phone: name, purpose, and the retention pair. */
export type TablePatch = { name?: string; description?: string } & (
    | RetentionPatch
    | { retentionDays?: undefined; retentionField?: undefined }
);

/** Where a NEW table would go — the list's `scope` descriptor. */
export interface CreateScope {
    kind: 'org' | 'user';
    id: string;
}

export interface DatatableList {
    tables: Datatable[];
    scope: CreateScope | null;
}

export interface Schema {
    fields: Column[];
    modelVersion: number;
}

/** A row exactly as Postgres answered it: the system five plus the table's own keys. */
export type TableRow = Record<string, unknown> & { id: string; updated_at?: unknown };

export interface RowsPage {
    rows: TableRow[];
    hasMore: boolean;
    nextCursor: string | null;
    /** row_count — approximate between retention sweeps. */
    total: number;
}

/** One condition of the closed list descriptor (rowDescriptor.readFilters). */
export interface RowFilter {
    field: string;
    op: string;
    value: unknown;
}

/** What the rows are asked for: filters, sort and search are the server's to apply. */
export interface RowQuery {
    filters: RowFilter[];
    match: 'all' | 'any';
    sort: { field: string; dir: 'asc' | 'desc' } | null;
    q: string;
}

export interface BulkImportResult {
    inserted: number;
    errors: { line: number; error: string }[];
}

/** A `datatable_grants` row (datatableStore/rowMappers.rowToGrant). */
export interface Grant {
    id: string;
    granteeType: 'user' | 'group';
    granteeId: string;
    grade: 'viewer' | 'editor';
}

/** The three audiences the sharing route accepts. */
export type Audience = 'private' | 'organisation' | 'groups';

export interface SharingDescriptor {
    audience?: Audience;
    sharedGroups?: string[];
    writeMode?: 'grants' | 'audience';
}

/** One consumer from GET /:id/usage (the generic usage index). */
export interface UsageRow {
    consumerKind: string;
    consumerId: string;
    /** Null on a consumer owned by someone else, whose name is not the caller's to read. */
    title: string | null;
    ownerId: string | null;
    mode: 'read' | 'write' | 'readwrite';
    stepOrdinal: number | null;
    stepOp: string | null;
    columns: string[];
    lastRunAt: string | null;
}

export interface DirectoryPerson {
    id: string;
    name: string;
}

export interface DirectoryGroup {
    id: string;
    name: string;
}

/** Best-effort names for grant rows: `/auth/users` and `/auth/groups` refuse most people. */
export interface Directory {
    users: DirectoryPerson[];
    groups: DirectoryGroup[];
    available: boolean;
}

/** POST /ai/draft → `draft`, create mode. Nothing is stored. */
export interface TableDraft {
    name: string;
    description: string;
    fields: ColumnDraft[];
    notes: string | null;
}
