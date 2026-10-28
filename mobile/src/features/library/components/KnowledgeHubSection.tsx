/** The hub's Knowledge bases block. */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { countLabel, type KnowledgeBase, type useKnowledgeBases } from '@/features/knowledge';
import { nOf } from '@/shared/lib/plural';
import { Icon, ListRow } from '@/shared/ui';

import { HubRows } from './HubRows';
import { HubSection } from './HubSection';

function KnowledgeHubRow({ kb }: { kb: KnowledgeBase }) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    const chunks = Number(kb.total_chunks ?? 0);
    return (
        <ListRow
            title={kb.name}
            subtitle={kb.description || undefined}
            meta={countLabel([
                nOf(t, 'mobile.library.n_docs', Number(kb.document_count ?? 0), ['{count} doc', '{count} docs']),
                chunks > 0 ? nOf(t, 'mobile.library.n_chunks', chunks, ['{count} chunk', '{count} chunks']) : null,
            ])}
            leading={<Icon name="Database" size={16} color={theme.colors.textMuted} />}
            onPress={() => router.push(`/knowledge/${kb.id}`)}
        />
    );
}

export function KnowledgeHubSection({ bases }: { bases: ReturnType<typeof useKnowledgeBases> }) {
    const t = useTranslation();
    const router = useRouter();
    return (
        <HubSection
            title={t('knowledge.title', 'Knowledge bases')}
            icon="Database"
            count={bases.data?.length}
            onSeeAll={() => router.push('/knowledge')}
            loading={bases.isLoading}
            error={bases.isError ? bases.error : undefined}
            onRetry={() => void bases.refetch()}
            isEmpty={(bases.data?.length ?? 0) === 0}
            emptyTitle={t('mobile.library.kb_empty', 'No knowledge bases')}
            emptyMessage={t('mobile.library.kb_empty_hint', 'A knowledge base is the searchable memory your agents read from.')}
            emptyActionLabel={t('mobile.library.create_one', 'Create one')}
            onEmptyAction={() => router.push('/knowledge')}
        >
            <HubRows items={bases.data ?? []} renderRow={(kb) => <KnowledgeHubRow kb={kb} />} />
        </HubSection>
    );
}
