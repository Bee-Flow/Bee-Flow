/**
 * Save a patch of the organisation record with the sections' feedback: a
 * "Saved" toast, or the server's refusal in words. Resolves whether it saved,
 * so a form drops its edits only after a save that landed.
 *
 * The organisation's name also lives in the signed-in user (/auth/user's
 * `organization`), which Settings, Account and the drawer read. A save that
 * renames it re-reads the user, as a profile edit does; other fields do not.
 */

import { describeError } from '@/core/api/errors';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { useToast } from '@/shared/ui';

import { useUpdateOrganization } from './mutations';
import type { OrgPatch } from '../model/types';

export function useSaveOrgRecord(orgId: string | null) {
    const t = useTranslation();
    const { toast } = useToast();
    const { refresh } = useAuth();
    const update = useUpdateOrganization(orgId);
    const save = async (patch: OrgPatch): Promise<boolean> => {
        try {
            await update.mutateAsync(patch);
            toast(t('common.saved', 'Saved'), 'success');
            if (patch.name !== undefined) void refresh();
            return true;
        } catch (err) {
            toast(describeError(err).message, 'error');
            return false;
        }
    };
    return { save, saving: update.isPending };
}
