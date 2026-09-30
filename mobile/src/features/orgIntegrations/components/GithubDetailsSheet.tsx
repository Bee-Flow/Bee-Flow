/**
 * Every synced resource and its state (GitHubSyncPanel.jsx "sync details"):
 * an agent or a skill, when it was last pushed, and the error when there was
 * one.
 */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { QueryList } from '@/shared/patterns';
import { Badge, ListRow, Sheet, type Tone } from '@/shared/ui';

import { useGithubSyncDetails } from '../hooks/githubHooks';
import type { GithubSyncItem } from '../model/githubTypes';

function tone(status: string): Tone {
    if (status === 'synced') return 'success';
    if (status === 'pending') return 'warning';
    if (status === 'error') return 'error';
    return 'neutral';
}

const keyOf = (item: GithubSyncItem) => item.id;

export function GithubDetailsSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const t = useTranslation();
    const query = useGithubSyncDetails(visible);
    return (
        <Sheet visible={visible} onClose={onClose} title={t('mobile.orgIntegrations.gh_details', 'Sync details')} scroll={false} tall>
            <QueryList
                query={query}
                keyExtractor={keyOf}
                renderItem={({ item }) => (
                    <ListRow
                        title={`${item.resourceType}/${item.resourceId.substring(0, 8)}`}
                        subtitle={item.status === 'error' && item.errorMessage ? item.errorMessage : timeAgo(item.lastSyncedAt, { suffix: true }) || undefined}
                        trailing={<Badge label={item.status} tone={tone(item.status)} />}
                    />
                )}
                empty={{
                    icon: 'FolderGit2',
                    title: t('mobile.orgIntegrations.gh_no_details', 'No sync data yet. Push to GitHub to get started.'),
                }}
            />
        </Sheet>
    );
}
