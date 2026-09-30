/**
 * The group sync's settings (SSOSection.jsx, "Sync Settings"): each switch is
 * saved the moment it flips, one key per request as the web sends it, and the
 * server's answer becomes the stored settings — the group says so, since the
 * screen's Save bar does not cover them. Destructive sync is confirmed before
 * it is switched on; off is instant. The permissions the sync needs are in
 * the setup guide. Shown once Microsoft SSO is configured, as on the web.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { ChoiceGroup } from '@/features/org';
import { useConfirm } from '@/shared/patterns';
import { Banner, Group, ToggleRow, useToast } from '@/shared/ui';

import { useSaveAzureSyncSettings } from '../hooks/azureHooks';
import { SYNC_INTERVALS } from '../model/azure';
import type { AzureGroupSyncSettings } from '../model/azureTypes';

export function AzureSyncSettings({ orgId, settings }: { orgId: string | null; settings: AzureGroupSyncSettings }) {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const save = useSaveAzureSyncSettings(orgId);
    const set = <K extends keyof AzureGroupSyncSettings>(key: K, value: AzureGroupSyncSettings[K]) =>
        save.mutate({ [key]: value }, { onError: (err) => toast(describeError(err).message, 'error') });
    const warning = t('azure.sync_destructive_warning', 'Warning: This will remove users from BeeFlow groups and delete Azure-synced groups that are no longer assigned to the enterprise app.');
    const setDestructive = async (on: boolean) => {
        const ok = !on || (await confirm({ title: t('azure.sync_destructive', 'Destructive sync'), message: warning, confirmLabel: t('mobile.orgIntegrations.sync_destructive_on', 'Switch on') }));
        if (ok) set('destructiveSync', on);
    };
    const hours = (h: number) =>
        h === 168 ? t('mobile.orgIntegrations.sync_weekly', 'Weekly') : t('mobile.orgIntegrations.sync_hours', '{n} hour(s)', { n: h });

    return (
        <>
            <Group title={t('azure.sync_settings', 'Sync Settings')} footer={t('mobile.orgIntegrations.sync_instant', 'Saved as you switch')}>
                <ToggleRow
                    testID="azure-sync-auto-activate"
                    label={t('azure.sync_auto_activate', 'Auto-activate synced users')}
                    description={t('azure.sync_auto_activate_desc', 'When enabled, new users from Azure groups are immediately active. When disabled, they require admin approval.')}
                    value={settings.autoActivateUsers}
                    disabled={save.isPending}
                    onValueChange={(v) => set('autoActivateUsers', v)}
                />
                <ToggleRow
                    testID="azure-sync-destructive"
                    label={t('azure.sync_destructive', 'Destructive sync')}
                    description={t('azure.sync_destructive_desc', 'Remove groups and group memberships from BeeFlow when they are no longer assigned in Azure AD.')}
                    value={settings.destructiveSync}
                    disabled={save.isPending}
                    onValueChange={(v) => void setDestructive(v)}
                />
                <ToggleRow
                    testID="azure-sync-periodic"
                    label={t('azure.sync_periodic', 'Automatic periodic sync')}
                    description={t('azure.sync_periodic_desc', 'Automatically sync groups from Azure AD at a regular interval.')}
                    value={settings.periodicSync}
                    disabled={save.isPending}
                    onValueChange={(v) => set('periodicSync', v)}
                />
            </Group>
            {settings.destructiveSync ? (
                <Banner tone="error">{warning}</Banner>
            ) : null}
            {settings.periodicSync ? (
                <ChoiceGroup
                    title={t('azure.sync_interval', 'Sync every')}
                    choices={SYNC_INTERVALS.map((h) => ({ value: String(h), label: hours(h) }))}
                    value={String(settings.syncIntervalHours)}
                    disabled={save.isPending}
                    onChange={(v) => set('syncIntervalHours', Number(v))}
                />
            ) : null}
        </>
    );
}
