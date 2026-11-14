import { useCallback, useEffect, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOrgGroupsQuery, type OrgGroup } from '@/api/queries/orgGroups';
import { DEPTH_TIER_KEYS, configuredTierKeys } from '@/components/licensing/tierMeta';
import { datatablesApi } from '../Datatables/datatablesApi';
import { DESCRIBE_MAX_PX, DESCRIBE_MIN_PX, type PickableTable } from './NewPlaybookDialogParts';

/**
 * The new-playbook dialog's loaders and the tier list it offers. Moved out of
 * NewPlaybookDialog.tsx verbatim; the state they fill stays in the dialog.
 */

// Until the server answers (and when it answers with nothing usable) the
// picker keeps the two tiers the playbook has always had — dropping to Auto
// alone because a fetch failed would silently change what gets built.
const FALLBACK_TIERS = Object.freeze(['fast', 'auto']);

/** The DEPTH tiers this person may pick, or the fallback pair. */
export function depthTierKeys(modelTiers: Record<string, unknown> | null): readonly string[] {
    const keys = configuredTierKeys(modelTiers || {}).filter((k) => DEPTH_TIER_KEYS.includes(k));
    // Auto alone means nothing is configured for this user yet — that is
    // the "no answer" case, not a one-option picker.
    return keys.filter((k) => k !== 'auto').length ? keys : FALLBACK_TIERS;
}

// Grow to the content instead of scrolling inside itself. Reset to `auto`
// first, or the box can only ever get taller.
export function useGrowDescribe(describeRef: RefObject<HTMLTextAreaElement | null>, description: string) {
    const growDescribe = useCallback((el: HTMLTextAreaElement | null) => {
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(Math.max(el.scrollHeight, DESCRIBE_MIN_PX), DESCRIBE_MAX_PX)}px`;
    }, []);
    useEffect(() => { growDescribe(describeRef.current); }, [growDescribe, description, describeRef]);
    return growDescribe;
}

/** The person's datatables, read once the existing-table mode is picked (once per dialog: no cache across mounts). A failure reads as []. */
export function useExistingTables(hasTable: boolean, tableMode: string): PickableTable[] | null {
    const query = useQuery<PickableTable[]>({
        queryKey: ['datatables', 'playbookPicker'],
        enabled: hasTable && tableMode === 'existing',
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
        queryFn: async () => {
            try {
                const b = await datatablesApi.list();
                return Array.isArray(b?.datatables) ? b.datatables : [];
            } catch {
                return [];
            }
        },
    });
    return query.data ?? null;
}

/** The org's groups, read once a phase needs an approver and approvals are allowed. A failure reads as []. */
export function useApproverGroups(approvalsAllowed: boolean | null, wantsApprover: boolean): OrgGroup[] | null {
    const query = useOrgGroupsQuery(!!approvalsAllowed && wantsApprover);
    return query.data ?? (query.isError ? [] : null);
}
