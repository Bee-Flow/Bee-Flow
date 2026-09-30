/** The hub's Notebooks block: the most recently active few. */

import { useRouter } from 'expo-router';
import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { countLabel } from '@/features/knowledge';
import type { NotebookCard, useNotebookSearch } from '@/features/notebooks';
import { plural } from '@/shared/lib/format';
import { Icon, ListRow } from '@/shared/ui';

import { HubRows } from './HubRows';
import { HubSection } from './HubSection';

function NotebookHubRow({ nb }: { nb: NotebookCard }) {
    useTranslation(); // re-render when the language changes: timeAgo speaks it
    const theme = useTheme();
    const router = useRouter();
    return (
        <ListRow
            title={nb.name}
            subtitle={
                countLabel([
                    plural(nb.sourceCount, 'source'),
                    nb.processingCount > 0 ? `${nb.processingCount} processing` : null,
                    nb.messageCount > 0 ? plural(nb.messageCount, 'message') : null,
                ]) || undefined
            }
            meta={timeAgo(nb.lastActivityAt ?? nb.updatedAt)}
            leading={
                <Icon
                    name={nb.pinned ? 'Bookmark' : 'Book'}
                    size={16}
                    color={nb.pinned ? theme.colors.accentPrimary : theme.colors.textMuted}
                />
            }
            onPress={() => router.push(`/notebooks/${nb.id}`)}
        />
    );
}

export function NotebooksHubSection({ notebooks }: { notebooks: ReturnType<typeof useNotebookSearch> }) {
    const router = useRouter();
    const page = notebooks.data;
    return (
        <HubSection
            title="Notebooks"
            icon="Book"
            // Only a truthful count: the hub asks for one page, so showing its
            // length when the server says there is more would understate it.
            count={page && !page.hasMore ? page.notebooks.length : undefined}
            onSeeAll={() => router.push('/notebooks')}
            loading={notebooks.isLoading}
            error={notebooks.isError ? notebooks.error : undefined}
            onRetry={() => void notebooks.refetch()}
            isEmpty={(page?.notebooks.length ?? 0) === 0}
            emptyTitle="No notebooks yet"
            emptyMessage="A notebook gathers sources — files, links, meetings — and lets you ask questions across all of them."
            emptyActionLabel="Create one"
            onEmptyAction={() => router.push('/notebooks')}
        >
            <HubRows items={page?.notebooks ?? []} renderRow={(nb) => <NotebookHubRow nb={nb} />} />
        </HubSection>
    );
}
