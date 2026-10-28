/** The hub's Documents block: the newest few, fanned out over the most recent bases. */

import { useRouter } from 'expo-router';
import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import type { OwnedDocument, useDocumentsAcross } from '@/features/documents';
import { documentIcon } from '@/features/knowledge';
import { Icon, ListRow } from '@/shared/ui';

import { HubRows } from './HubRows';
import { HubSection } from './HubSection';

function DocumentHubRow({ doc }: { doc: OwnedDocument }) {
    const t = useTranslation(); // also re-renders when the language changes: timeAgo speaks it
    const theme = useTheme();
    const router = useRouter();
    return (
        <ListRow
            title={doc.title || t('mobile.knowledge.untitled_document', 'Untitled document')}
            subtitle={doc.kbName}
            meta={timeAgo(doc.created_at)}
            wrapTitle
            leading={<Icon name={documentIcon(doc.source_type)} size={16} color={theme.colors.textMuted} />}
            // The row names a document; it must open THAT document, not the
            // list of them — which was a dead end that cost four taps.
            onPress={() => router.push(`/knowledge/documents?open=${encodeURIComponent(doc.id)}`)}
        />
    );
}

export function DocumentsHubSection({
    documents,
    basesLoading,
}: {
    documents: ReturnType<typeof useDocumentsAcross>;
    /** The fan-out waits for the bases, so their loading is this section's too. */
    basesLoading: boolean;
}) {
    const t = useTranslation();
    const router = useRouter();
    return (
        <HubSection
            title={t('mobile.knowledge.tab_documents', 'Documents')}
            icon="FileText"
            onSeeAll={() => router.push('/knowledge/documents')}
            loading={documents.isLoading || basesLoading}
            error={documents.isError ? documents.error : undefined}
            onRetry={() => void documents.refetch()}
            isEmpty={(documents.data?.documents.length ?? 0) === 0}
            emptyTitle={t('mobile.knowledge.no_documents', 'No documents yet')}
            emptyMessage={t('mobile.library.docs_empty_hint', 'Upload a file or scan a page and it becomes searchable across your knowledge bases.')}
            emptyActionLabel={t('automations.approval_editors.add_a_document', 'Add a document')}
            onEmptyAction={() => router.push('/knowledge/documents')}
        >
            <HubRows items={documents.data?.documents ?? []} renderRow={(doc) => <DocumentHubRow doc={doc} />} />
        </HubSection>
    );
}
