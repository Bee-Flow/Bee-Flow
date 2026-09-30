/**
 * A settings document the server REPLACES on save (the Talk and Meet
 * meeting-notes settings): the admin's edits over what was read, and a save
 * that sends the whole document back — never a partial one, which the server
 * would read as every other field at its default.
 */

import type { UseMutationResult } from '@tanstack/react-query';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useDraft } from '@/features/org';
import { useToast } from '@/shared/ui';

export function useSettingsForm<T extends object>(read: T | undefined, save: UseMutationResult<void, Error, T>) {
    const t = useTranslation();
    const { toast } = useToast();
    const form = useDraft<T>(read ?? null);
    return {
        form,
        saving: save.isPending,
        save: async () => {
            if (!form.draft) return;
            try {
                await save.mutateAsync(form.draft);
                form.reset();
                toast(t('common.saved', 'Saved'), 'success');
            } catch (err) {
                toast(describeError(err).message, 'error');
            }
        },
    };
}
