import type { RowLike } from '../../../../shared/DataTable';
import type { SetHeaderActions } from '../audits/useHeaderPrimary';
import type { ProjectRecordBody, RopaProjectsBody } from './RopaProjects';
import type { SccCellProps } from './RopaScc';

/** One processing activity of GET /ropa (routes/compliance/ropa.js `_buildRopa`). */
export interface RopaActivity extends RowLike {
    activity_id: string;
    name: string;
    purpose?: string;
    data_categories?: string[];
    retention?: string | null;
    transfers: string[];
    source?: { kind?: string; id?: string | number | null } | null;
}

/** A processor row: the measured ledger fields plus the admin's SCC / DORA facts (`critical` and `country` are null when unset). */
export interface RopaProcessor extends RowLike {
    operator?: string | null;
    is_eu?: boolean;
    country_name?: string | null;
    country_code?: string | null;
    country?: string | null;
    calls?: number;
    last_seen?: string | null;
    scc_confirmed?: boolean;
    contract_ref?: string | null;
    critical?: boolean | null;
}

export interface RopaBody {
    error?: boolean;
    controller?: { name?: string | null; dpo_name?: string | null; dpo_email?: string | null };
    legal_bases?: string[];
    data_residency?: string | null;
    scc_confirmed_operators?: Array<{ operator?: string | null }>;
    activities?: RopaActivity[];
    processors?: RopaProcessor[];
}

export interface RopaState {
    ropa?: RopaBody | null;
    busy?: boolean;
    refresh?: () => unknown;
    review?: () => unknown;
    sccToggle?: SccCellProps['onToggle'];
    projects?: RopaProjectsBody | null;
    saveProject?: (projectId: string, body: ProjectRecordBody) => Promise<unknown>;
    removeProject?: (projectId: string) => Promise<unknown>;
}

export interface RopaPageProps {
    data?: { ropa?: RopaState };
    isMobile?: boolean;
    exportsEnabled?: boolean;
    dl?: (url: string) => string | null;
    api?: string;
    onNavigate?: ((path: string) => void) | null;
    setHeaderActions?: SetHeaderActions;
}
