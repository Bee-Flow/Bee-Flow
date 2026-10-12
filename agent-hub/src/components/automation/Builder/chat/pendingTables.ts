/**
 * Tables the assistant proposed but that do not exist yet.
 *
 * In a preview work mode builder_create_datatable only STAGES a table: the
 * steps point at a "pending:<n>" id, and the table is created by the server
 * when the user presses Apply. Everything the client needs to show or check
 * that lives here. The regex mirrors server/automation/validate/constants.js
 * (PENDING_DATATABLE_RE); change both together.
 */

const PENDING_RE = /^pending:[1-9]\d{0,2}$/;

export interface PendingTableField {
    key: string;
    name: string;
    type: string;
    options?: unknown[];
    required?: boolean;
}

export interface PendingTable {
    ref: string;
    name: string;
    key: string;
    description?: string;
    fields: PendingTableField[];
    scope?: 'org' | 'personal';
}

export interface UsedTable {
    id: string;
    key?: string;
    name: string;
    pending?: boolean;
    newlyBound?: boolean;
    stepIds?: string[];
}

export interface CatalogTable {
    id: string;
    key?: string;
    name: string;
    pending?: boolean;
    scope?: string;
    columns?: { key: string; name: string; type: string }[];
    [extra: string]: unknown;
}

export const isPendingDatatableId = (id: unknown): id is string => typeof id === 'string' && PENDING_RE.test(id);

/** A pending ref anywhere in the definition: any key named datatableId (steps, layers, loop bodies, cacheInto). */
export function hasPendingDatatableRefs(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasPendingDatatableRefs);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => (key === 'datatableId' && isPendingDatatableId(child)) || hasPendingDatatableRefs(child));
}

/**
 * The catalog the preview canvas reads, with the proposal's staged tables
 * added, so a datatable card names "Facturen" instead of showing "pending:1".
 * Returns the input itself when there is nothing to add, and null when the
 * catalog has not loaded (the cards then stay muted, as before).
 */
export function previewCatalog<C extends { datatables?: CatalogTable[] } | null | undefined>(catalog: C, proposal: { pendingDatatables?: PendingTable[] } | null | undefined): C {
    const pending = Array.isArray(proposal?.pendingDatatables) ? proposal.pendingDatatables : [];
    if (!catalog || !pending.length) return catalog;
    const known = new Set((catalog.datatables || []).map(t => t.id));
    const added: CatalogTable[] = pending.filter(p => p?.ref && !known.has(p.ref)).map(p => ({
        id: p.ref,
        key: p.key,
        name: p.name,
        pending: true,
        scope: p.scope,
        columns: (p.fields || []).map(f => ({ key: f.key, name: f.name, type: f.type })),
    }));
    return { ...catalog, datatables: [...(catalog.datatables || []), ...added] };
}
