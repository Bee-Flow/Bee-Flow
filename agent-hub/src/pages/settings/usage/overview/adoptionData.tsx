// The adoption reads the Overview and Spend tabs borrow (spend deltas, member
// counts, spend per area). They only run with the `advanced_usage_monitoring`
// licence feature, so the hooks live in a component that is only rendered then.

import type { ReactNode } from 'react';
import { useAdoptionAreas, useAdoptionStudio, useAdoptionSummary } from '@/api/queries/usageAdoption';
import type { RangeParams } from '@/utils/usageHelpers';
import type { AdoptionAreas, AdoptionStudio, AdoptionSummary } from '../adoption/adoption.types';
import { adoptionQuery } from '../adoption/AdoptionTab';

export interface OverviewAdoption {
    summary: AdoptionSummary | null;
    areas: AdoptionAreas | null;
    studio: AdoptionStudio | null;
}

interface GateProps {
    enabled: boolean;
    rangeParams: RangeParams;
    rangePreset?: string;
    /** The organisation the reads cover; none: the caller's own. */
    orgId?: string | null;
}

function AllReads({ rangeParams, rangePreset, children }: Omit<GateProps, 'enabled'> & { children: (a: OverviewAdoption) => ReactNode }) {
    const qs = adoptionQuery(rangeParams, rangePreset, '');
    const summary = useAdoptionSummary<AdoptionSummary>(qs).data ?? null;
    const areas = useAdoptionAreas<AdoptionAreas>(qs).data ?? null;
    const studio = useAdoptionStudio<AdoptionStudio>(qs).data ?? null;
    return <>{children({ summary, areas, studio })}</>;
}

/** Summary, areas and Studio kinds; the child gets null while the feature is off. */
export function AdoptionGate({ enabled, children, ...range }: GateProps & { children: (a: OverviewAdoption | null) => ReactNode }) {
    if (!enabled) return <>{children(null)}</>;
    return <AllReads {...range}>{children}</AllReads>;
}

function SummaryRead({ rangeParams, rangePreset, orgId, children }: Omit<GateProps, 'enabled'> & { children: (s: AdoptionSummary | null) => ReactNode }) {
    const summary = useAdoptionSummary<AdoptionSummary>(adoptionQuery(rangeParams, rangePreset, '', orgId)).data ?? null;
    return <>{children(summary)}</>;
}

/** Only the summary (the Spend hero needs the previous period's cost). */
export function SummaryGate({ enabled, children, ...range }: GateProps & { children: (s: AdoptionSummary | null) => ReactNode }) {
    if (!enabled) return <>{children(null)}</>;
    return <SummaryRead {...range}>{children}</SummaryRead>;
}
