/**
 * What a Sync now just reported (SSOSection.jsx's result and error panels):
 * the counts, the groups or users it could not bring in, and the run's log a
 * tap away; or why it failed.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { Banner, Group, NoteRow, SettingRow } from '@/shared/ui';

import type { AzureSyncResult } from '../model/azureTypes';

export function AzureSyncOutcome({ result, error }: { result: AzureSyncResult | null; error: string | null }) {
    const t = useTranslation();
    const [open, setOpen] = useState(false);
    if (error) {
        return <Banner tone="error">{`${t('azure.sync_groups_error', 'Sync failed')}: ${error}`}</Banner>;
    }
    if (!result) return null;
    const counts = t('mobile.orgIntegrations.sync_new', '{groups} group(s), {users} new user(s)', { groups: result.groups, users: result.users });
    return (
        <>
            <Group>
                <SettingRow
                    testID="azure-sync-log"
                    label={`${t('azure.sync_groups_success', 'Sync completed')}: ${counts}`}
                    onPress={result.details.length ? () => setOpen((v) => !v) : undefined}
                />
                {open ? <NoteRow>{result.details.join('\n')}</NoteRow> : null}
            </Group>
            {result.errors.length ? <Banner tone="warning">{result.errors.join('\n')}</Banner> : null}
        </>
    );
}
