import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { readOrgGroups, type OrgGroup } from '@/api/queries/orgGroups';
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

/** The person's datatables, read once the existing-table mode is picked. */
export function useExistingTables(
    hasTable: boolean,
    tableMode: string,
    tables: PickableTable[] | null,
    setTables: Dispatch<SetStateAction<PickableTable[] | null>>,
) {
    useEffect(() => {
        if (!hasTable || tableMode !== 'existing' || tables) return;
        let alive = true;
        datatablesApi.list().then((b) => { if (alive) setTables(Array.isArray(b?.datatables) ? b.datatables : []); }).catch(() => { if (alive) setTables([]); });
        return () => { alive = false; };
    }, [hasTable, tableMode, tables, setTables]);
}

/** The org's groups, read once a phase needs an approver and approvals are allowed. */
export function useApproverGroups(
    approvalsAllowed: boolean | null,
    wantsApprover: boolean,
    groups: OrgGroup[] | null,
    setGroups: Dispatch<SetStateAction<OrgGroup[] | null>>,
) {
    useEffect(() => {
        if (!approvalsAllowed || !wantsApprover || groups) return;
        let alive = true;
        readOrgGroups().then((list) => {
            if (alive) setGroups(list ?? []);
        }).catch(() => { if (alive) setGroups([]); });
        return () => { alive = false; };
    }, [approvalsAllowed, wantsApprover, groups, setGroups]);
}
