/** The hub's Knowledge bases block. */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { countLabel, type KnowledgeBase, type useKnowledgeBases } from '@/features/knowledge';
import { plural } from '@/shared/lib/format';
import { Icon, ListRow } from '@/shared/ui';

import { HubRows } from './HubRows';
import { HubSection } from './HubSection';

function KnowledgeHubRow({ kb }: { kb: KnowledgeBase }) {
    const theme = useTheme();
    const router = useRouter();
    const chunks = Number(kb.total_chunks ?? 0);
    return (
        <ListRow
            title={kb.name}
            subtitle={kb.description || undefined}
            meta={countLabel([plural(Number(kb.document_count ?? 0), 'doc'), chunks > 0 ? `${chunks} chunks` : null])}
            leading={<Icon name="Database" size={16} color={theme.colors.textMuted} />}
            onPress={() => router.push(`/knowledge/${kb.id}`)}
        />
    );
}

export function KnowledgeHubSection({ bases }: { bases: ReturnType<typeof useKnowledgeBases> }) {
    const router = useRouter();
    return (
        <HubSection
            title="Knowledge bases"
            icon="Database"
            count={bases.data?.length}
            onSeeAll={() => router.push('/knowledge')}
            loading={bases.isLoading}
            error={bases.isError ? bases.error : undefined}
            onRetry={() => void bases.refetch()}
            isEmpty={(bases.data?.length ?? 0) === 0}
            emptyTitle="No knowledge bases"
            emptyMessage="A knowledge base is the searchable memory your agents read from."
            emptyActionLabel="Create one"
            onEmptyAction={() => router.push('/knowledge')}
        >
            <HubRows items={bases.data ?? []} renderRow={(kb) => <KnowledgeHubRow kb={kb} />} />
        </HubSection>
    );
}
