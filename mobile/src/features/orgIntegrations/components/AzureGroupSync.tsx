/**
 * Azure AD group sync (the lower half of SSOSection.jsx): when it last ran and
 * what it brought in, when the periodic run is due, Sync now, and what the
 * run just reported — its log a tap away. Needs Microsoft SSO credentials, as
 * the server's sync does. After a run the configuration is re-read, so the
 * status is the server's rather than one this screen made up.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { timeAgo, useTranslation } from '@/core/i18n';
import { Banner, Button, Group, InfoRow, NoteRow } from '@/shared/ui';

import { AzureSyncOutcome } from './AzureSyncOutcome';
import { useSyncAzureGroups } from '../hooks/azureHooks';
import { useNow } from '../hooks/useNow';
import { nextSync } from '../model/azure';
import type { AzureConfig, AzureSyncResult } from '../model/azureTypes';

const RESULT_TONE = { success: 'success', partial: 'warning', error: 'error' } as const;

function resultTone(result: string | null): 'success' | 'warning' | 'error' | 'tertiary' {
    return result && result in RESULT_TONE ? RESULT_TONE[result as keyof typeof RESULT_TONE] : 'tertiary';
}

export function AzureGroupSync({ orgId, config, ready }: { orgId: string | null; config: AzureConfig; ready: boolean }) {
    const t = useTranslation();
    const sync = useSyncAzureGroups(orgId);
    const [result, setResult] = useState<AzureSyncResult | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { groupSyncStatus: status, groupSyncSettings: settings } = config;
    const now = useNow(settings.periodicSync, 60_000);
    const next = settings.periodicSync ? nextSync(status.lastSyncAt, settings.syncIntervalHours, now) : null;

    const run = async () => {
        setResult(null);
        setError(null);
        try {
            const outcome = await sync.mutateAsync();
            if (outcome.ok) setResult(outcome);
            else setError(outcome.errors[0] ?? t('azure.sync_groups_error', 'Sync failed'));
        } catch (err) {
            setError(describeError(err).message);
        }
    };

    return (
        <>
            <Group
                title={t('azure.sync_groups_title', 'Azure AD Group Sync')}
                footer={t('azure.sync_groups_desc', 'Automatically sync groups and users assigned to your Azure AD enterprise app to BeeFlow.')}
            >
                {status.lastSyncAt ? (
                    <>
                        <InfoRow
                            label={t('azure.sync_last_synced', 'Last synced')}
                            value={timeAgo(status.lastSyncAt, { suffix: true })}
                            tone={resultTone(status.lastSyncResult)}
                        />
                        <InfoRow
                            label={t('mobile.orgIntegrations.sync_synced', 'Synced')}
                            value={t('mobile.orgIntegrations.sync_counts', '{groups} group(s), {users} user(s)', {
                                groups: status.syncedGroups,
                                users: status.syncedUsers,
                            })}
                        />
                    </>
                ) : (
                    <NoteRow>{t('azure.sync_never', 'Never synced')}</NoteRow>
                )}
                {next ? (
                    <InfoRow
                        label={t('azure.sync_next', 'Next sync')}
                        value={
                            next.kind === 'overdue'
                                ? t('azure.sync_overdue', 'Overdue')
                                : next.kind === 'imminent'
                                  ? t('azure.sync_next_imminent', 'Any moment')
                                  : next.text
                        }
                        tone={next.kind === 'overdue' ? 'warning' : 'success'}
                    />
                ) : null}
                <Button
                    testID="azure-sync-now"
                    label={sync.isPending ? t('azure.sync_syncing', 'Syncing...') : t('azure.sync_groups_button', 'Sync Now')}
                    iconName="RefreshCw"
                    loading={sync.isPending}
                    disabled={!ready}
                    onPress={() => void run()}
                />
            </Group>
            {ready ? null : (
                <Banner tone="info">{t('azure.sync_requires_sso', 'Configure Microsoft SSO credentials above before using group sync.')}</Banner>
            )}
            <AzureSyncOutcome result={result} error={error} />
        </>
    );
}
