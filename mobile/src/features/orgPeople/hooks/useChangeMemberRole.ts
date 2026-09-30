/**
 * Change a member's org role, answering the server's two refusals the way the
 * web's useOrgMemberRoles does:
 *   - 409 `confirm_self_demotion`: you are giving up your own admin rights.
 *     Allowed, but only deliberately — confirm, then re-send with
 *     `confirmSelfDemotion: true`.
 *   - `last_org_admin` (and anything else): thrown, for the screen to say.
 */

import { ApiError } from '@/core/api/client';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';

import { useUpdateMember } from './memberMutations';

export function isSelfDemotionRefusal(error: unknown): boolean {
    return error instanceof ApiError && error.status === 409 && error.code === 'confirm_self_demotion';
}

export function useChangeMemberRole() {
    const t = useTranslation();
    const confirm = useConfirm();
    const update = useUpdateMember();

    /** Resolves true when the role changed, false when you stepped back. */
    const change = async (id: string, orgRole: string): Promise<boolean> => {
        try {
            await update.mutateAsync({ id, patch: { orgRole } });
            return true;
        } catch (error) {
            if (!isSelfDemotionRefusal(error)) throw error;
        }
        const ok = await confirm({
            title: t('admin.sec_self_demote_title', 'Give up your admin rights?'),
            message: t(
                'admin.sec_self_demote_desc',
                'This removes your own administrator rights over this organisation. Another administrator would have to give them back.',
            ),
            confirmLabel: t('admin.sec_self_demote_confirm', 'Yes, step down'),
        });
        if (!ok) return false;
        await update.mutateAsync({ id, patch: { orgRole, confirmSelfDemotion: true } });
        return true;
    };

    return { change, isPending: update.isPending };
}
