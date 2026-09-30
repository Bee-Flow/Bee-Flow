/**
 * Nextcloud Sync's page state (NextcloudSyncPanel.jsx): the binding, its
 * groups and mirrored accounts, the settings as edited, Save, and Sync now
 * with the web's result sentence.
 */

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useDraft } from '@/features/org';
import { useToast } from '@/shared/ui';

import { useRunNcSync, useSaveNcSync } from './nextcloudMutations';
import { useNcGroupNames, useNcSync, useNcSyncUsers } from './nextcloudQueries';
import type { NcSyncSettings } from '../model/nextcloudTypes';

export function useNcSyncPage(orgId: string | null) {
    const t = useTranslation();
    const { toast } = useToast();
    const sync = useNcSync(orgId);
    const groups = useNcGroupNames(sync.data ? orgId : null);
    const users = useNcSyncUsers(sync.data ? orgId : null);
    const save = useSaveNcSync(orgId);
    const run = useRunNcSync(orgId);
    const data = sync.data;
    const form = useDraft<NcSyncSettings>(
        data
            ? { mode: data.mode, syncGroups: data.syncGroups, excludedGroups: data.excludedGroups, newUserDefaultStatus: data.newUserDefaultStatus }
            : null,
    );

    return {
        sync,
        form,
        groupNames: groups.data ?? [],
        groupsError: groups.isError ? describeError(groups.error).message : null,
        users: users.data ?? [],
        saving: save.isPending,
        syncing: run.isPending,
        refetch: () => Promise.all([sync.refetch(), groups.refetch(), users.refetch()]),
        save: async () => {
            if (!form.draft) return;
            try {
                await save.mutateAsync(form.draft);
                form.reset();
                toast(t('mobile.orgIntegrations.nc_saved', 'Settings saved'), 'success');
            } catch (err) {
                toast(describeError(err).message, 'error');
            }
        },
        syncNow: async () => {
            try {
                const result = await run.mutateAsync();
                if (result.error) throw new Error(result.error);
                await users.refetch();
                toast(
                    t('mobile.orgIntegrations.nc_sync_done', 'Sync done: created {created}, deactivated {deactivated}', {
                        created: result.created,
                        deactivated: result.deactivated,
                    }),
                    'success',
                );
            } catch (err) {
                toast(describeError(err).message, 'error');
            }
        },
    };
}
