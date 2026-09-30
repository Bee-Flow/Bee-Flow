/**
 * Switch a system knowledge base on or off for the organisation
 * (SystemKnowledgeBasesPanel.jsx toggle). A system base is usable when its
 * beta feature is in BOTH the super admin's allow-list and the org admin's
 * active list; the org admin flips the active one (PUT /auth/me/active-features,
 * sending the whole list back). A platform operator switching one on that
 * the organisation is not allowed yet grants it first, as the web does.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import type { SystemKb } from '@/features/knowledge';

import { getActiveFeatures, getBetaAllowList, setActiveBetaFeatures, setBetaAllowList } from '../api/integrations';
import { integrationKeys } from '../api/keys';

async function toggle(kb: SystemKb, orgId: string | null, isSuperAdmin: boolean): Promise<void> {
    const id = kb.slug;
    if (!id) throw new Error('This knowledge base has no feature to switch.');
    const goingOn = !kb.enabledForOrg;
    if (isSuperAdmin && goingOn && !kb.allowedForOrg && orgId) {
        const allowed = await getBetaAllowList(orgId);
        if (!allowed.includes(id)) await setBetaAllowList(orgId, [...allowed, id]);
    }
    const active = new Set((await getActiveFeatures()).enabledBetaFeatures);
    if (goingOn) active.add(id);
    else active.delete(id);
    await setActiveBetaFeatures([...active]);
}

export function useToggleSystemKb(orgId: string | null, isSuperAdmin: boolean, onDone: () => Promise<unknown>) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (kb: SystemKb) => toggle(kb, orgId, isSuperAdmin),
        onSuccess: async () => {
            await onDone();
            await queryClient.invalidateQueries({ queryKey: integrationKeys.activeFeatures });
        },
    });
}
