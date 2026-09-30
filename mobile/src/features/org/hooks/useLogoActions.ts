/**
 * Upload and remove the organisation logo, with the web's feedback: a pick
 * uploads at once, a removal asks first (the file is deleted on the server).
 *
 * The drawer header draws the logo from the signed-in user (/auth/user's
 * `organization`, via the access snapshot), not from this screen's query, so
 * a change re-reads the user as a profile edit does. Every upload gets a new
 * file name on the server, so the new logo is not served from the image cache.
 */

import { describeError } from '@/core/api/errors';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { useToast } from '@/shared/ui';

import { useDeleteOrgLogo, useUploadOrgLogo } from './sectionMutations';
import { usePickLogo } from './usePickLogo';

export function useLogoActions(orgId: string | null) {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const { refresh } = useAuth();
    const pick = usePickLogo();
    const upload = useUploadOrgLogo(orgId);
    const remove = useDeleteOrgLogo(orgId);

    const onUpload = async () => {
        const picked = await pick();
        if (!picked) return;
        if ('error' in picked) {
            toast(picked.error, 'error');
            return;
        }
        try {
            await upload.mutateAsync(picked.file);
            toast(t('mobile.org.logo_uploaded', 'Logo updated'), 'success');
            void refresh();
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };

    const onRemove = async () => {
        const ok = await confirm({
            title: t('org.remove_logo', 'Remove logo'),
            message: t('mobile.org.logo_remove_message', 'The logo is deleted from the server. You can upload a new one at any time.'),
            confirmLabel: t('org.remove_logo', 'Remove logo'),
            tone: 'destructive',
        });
        if (!ok) return;
        try {
            await remove.mutateAsync();
            void refresh();
        } catch (err) {
            toast(describeError(err).message || t('mobile.org.logo_remove_failed', 'Failed to remove logo'), 'error');
        }
    };

    return {
        busy: upload.isPending || remove.isPending,
        upload: () => void onUpload(),
        remove: () => void onRemove(),
    };
}
