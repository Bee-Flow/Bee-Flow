import type { SoaControl } from '../pages/soa/SoaTable';
import type { AccessAuditRow } from '../pages/accessAuditLabels';

/** A row id as the server hands it over: a number, a string or a flag. */
export type Id = string | number;

export interface UseDsrArgs {
    enabled?: boolean;
    onChanged?: () => void;
    refreshCore?: (() => Promise<void>) | (() => void);
}

export interface UseRopaArgs {
    enabled?: boolean;
    onChanged?: () => void;
    refreshCore?: (() => Promise<void>) | (() => void);
}

export interface UseDpiaArgs {
    enabled?: boolean;
    onChanged?: () => void;
    refreshCore?: (() => Promise<void>) | (() => void);
}

export interface UseIncidentsArgs {
    enabled?: boolean;
    onChanged?: () => void;
    refreshCore?: (() => Promise<void>) | (() => void);
    kind?: string | null;
}

export interface UseSoaArgs {
    enabled?: boolean;
    onChanged?: () => void;
}

/** GET /iso/soa: the controls and their tally, or `{ error }` after a failed read. */
export interface SoaBody {
    controls?: SoaControl[];
    stats?: { approved?: number; total?: number; todo?: number };
    error?: string;
    [key: string]: unknown;
}

export interface UsePoliciesArgs {
    enabled?: boolean;
    onChanged?: () => void;
}

export interface UseConnectorsArgs {
    enabled?: boolean;
    onChanged?: () => void;
}

export interface UseRisksArgs {
    enabled?: boolean;
    onChanged?: () => void;
}

export interface UseAuditArgs {
    enabled?: boolean;
    onChanged?: () => void;
}

export interface UseTrainingArgs {
    enabled?: boolean;
    onChanged?: () => void;
}

export interface UseAccessAuditArgs {
    enabled?: boolean;
}

/** GET /access-audit: one page of the log, or `{ error }` after a failed read. */
export interface AccessAuditLog {
    entries?: AccessAuditRow[] | null;
    total?: number | null;
    limit?: number;
    offset?: number;
    error?: string;
}

/** The server-side filter the view and the export are both built from. */
export interface AccessAuditFilter {
    action?: string;
    since?: string;
    until?: string;
    actor?: string;
}

/** A member of the organisation, as the pickers list them. */
export interface OrgUserRow {
    id: string;
    displayName?: string;
    email?: string;
}

export interface UseOrgUsersArgs {
    enabled?: boolean;
}
