/**
 * One Azure section as a form: the admin's edits over what was read, and a
 * save that sends that section's body (a secret only when a new one was
 * typed — blank keeps the stored one, as the server promises).
 */

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useDraft } from '@/features/org';
import { useToast } from '@/shared/ui';

import { useSaveAzureSection } from './azureHooks';
import type { AzureSectionBody } from '../api/azure';

export function useAzureSectionForm<T extends object>(orgId: string | null, base: T | null, toBody: (draft: T) => AzureSectionBody) {
    const t = useTranslation();
    const { toast } = useToast();
    const save = useSaveAzureSection(orgId);
    const form = useDraft<T>(base);
    return {
        form,
        saving: save.isPending,
        save: async () => {
            if (!form.draft) return;
            try {
                await save.mutateAsync(toBody(form.draft));
                form.reset();
                toast(t('azure.saved', 'Saved'), 'success');
            } catch (err) {
                toast(describeError(err).message, 'error');
            }
        },
    };
}
