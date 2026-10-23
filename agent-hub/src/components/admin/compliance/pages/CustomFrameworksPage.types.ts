import type { CustomCheckDef, CustomResult } from './custom/CustomChecksTable';

/** A framework row, whether it came from /frameworks or from /custom/frameworks. */
export interface FrameworkSource {
    custom_id?: string | number | null;
    id?: string | number | null;
    code?: string | null;
    name?: string | null;
    reference?: string | null;
    description?: string | null;
    status?: string | null;
    attestation_valid_months?: number | null;
    checks_count?: unknown;
    score?: unknown;
    locked?: unknown;
}

/** An own framework, normalised for the list and the detail. */
export interface CustomFramework {
    id: string;
    code: string;
    name: string;
    reference: string | null;
    description: string | null;
    status: string;
    attestation_valid_months: number | null;
    checks_count: number | null;
    score: number | null;
    locked: unknown;
}

/** GET /custom/frameworks/:id: the definition and its items. */
export interface CustomFrameworkDetail {
    checks?: CustomCheckDef[] | null;
}

export interface CustomFrameworksPageProps {
    navigate?: (section: string) => void;
    focusId?: string | null;
    exportsEnabled?: boolean;
    dl?: (url: string) => string | null;
    isMobile?: boolean;
    setHeaderActions?: (actions: { onAddFramework?: () => void }) => void;
    data?: {
        frameworks?: { custom?: readonly unknown[] | null; refresh?: () => unknown } | null;
        core?: { checks?: readonly (CustomResult | null)[] | null; refresh?: () => unknown } | null;
        bump?: () => void;
    };
    now?: number;
}
