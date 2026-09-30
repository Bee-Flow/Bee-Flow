/**
 * The connected repository (GitHubSyncPanel.jsx sync dashboard): which repo
 * and branch, auto-sync, the resources per state, and the actions — open it
 * on GitHub, edit, disconnect, push everything or just what changed.
 */

import * as WebBrowser from 'expo-web-browser';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { absoluteDate } from '@/shared/lib/display';
import { Badge, Button, Group, InfoRow, ListRow, SettingRow } from '@/shared/ui';

import { repoUrl } from '../model/github';
import type { GithubSyncConfig, GithubSyncOverview } from '../model/githubTypes';

export interface GithubRepoActions {
    busy: boolean;
    onEdit: () => void;
    onDisconnect: () => void;
    onPushAll: () => void;
    onPushPending: () => void;
    onDetails: () => void;
}

export function GithubRepoGroup({
    config,
    overview,
    actions,
}: {
    config: GithubSyncConfig;
    overview: GithubSyncOverview | null;
    actions: GithubRepoActions;
}) {
    const t = useTranslation();
    const pending = overview?.pending ?? 0;
    return (
        <>
            <Group>
                <ListRow
                    title={`${config.repoOwner}/${config.repoName}`}
                    subtitle={[config.branch, config.autoSync ? t('mobile.orgIntegrations.gh_auto', 'auto-sync') : null].filter(Boolean).join(' · ')}
                    trailing={<Badge label={t('mobile.orgIntegrations.n8n_connected', 'Connected')} tone="success" />}
                    wrapTitle
                />
                <SettingRow label={t('mobile.orgIntegrations.gh_open', 'Open in GitHub')} onPress={() => void WebBrowser.openBrowserAsync(repoUrl(config), { createTask: false })} />
                <SettingRow testID="gh-edit" label={t('mobile.orgIntegrations.gh_edit', 'Edit configuration')} onPress={actions.onEdit} />
                <SettingRow testID="gh-disconnect" label={t('mobile.orgIntegrations.gh_disconnect', 'Disconnect')} destructive onPress={actions.onDisconnect} />
            </Group>
            {overview ? (
                <Group title={t('mobile.orgIntegrations.gh_overview', 'Sync overview')}>
                    <InfoRow label={t('mobile.orgIntegrations.gh_synced', 'Synced')} value={String(overview.synced)} tone="success" />
                    <InfoRow label={t('mobile.orgIntegrations.gh_pending', 'Pending')} value={String(overview.pending)} tone="warning" />
                    <InfoRow label={t('mobile.orgIntegrations.gh_errors', 'Errors')} value={String(overview.error)} tone="error" />
                    <InfoRow label={t('mobile.orgIntegrations.gh_total', 'Total')} value={String(overview.total)} />
                    {config.lastFullSync ? (
                        <InfoRow label={t('mobile.orgIntegrations.gh_last_full', 'Last full sync')} value={absoluteDate(config.lastFullSync)} />
                    ) : null}
                    <SettingRow testID="gh-details" label={t('mobile.orgIntegrations.gh_details', 'Sync details')} onPress={actions.onDetails} />
                </Group>
            ) : null}
            <Button testID="gh-push-all" label={t('mobile.orgIntegrations.gh_push_all', 'Push All to GitHub')} iconName="Upload" loading={actions.busy} onPress={actions.onPushAll} fullWidth />
            {pending > 0 ? (
                <Button
                    testID="gh-push-pending"
                    label={t('mobile.orgIntegrations.gh_push_pending', 'Push {n} Pending', { n: pending })}
                    variant="secondary"
                    iconName="RefreshCw"
                    disabled={actions.busy}
                    onPress={actions.onPushPending}
                    fullWidth
                />
            ) : null}
        </>
    );
}
