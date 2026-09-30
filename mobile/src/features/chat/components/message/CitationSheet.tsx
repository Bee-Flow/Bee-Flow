/**
 * The passage behind a citation chip (the web's CitationOverlay): the
 * document's title, where in it the passage sits — page, table rows, heading —
 * and the passage itself. The page is the point of a citation: it can be
 * checked. It is shown when known and left out when not, never guessed.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { chipLabel } from '@/features/chat/model/citationLabel';
import type { KbSource } from '@/features/chat/model/types';
import { Sheet, Text } from '@/shared/ui';

export function CitationSheet({
    citation,
    onClose,
}: {
    citation: { source: KbSource; index: number } | null;
    onClose: () => void;
}) {
    const t = useTranslation();
    const source = citation?.source;
    // The sheet shows ONE passage, so it names that passage's page and rows
    // even when its chip folds several (a folded chip leaves them out).
    const where = source ? chipLabel({ ...source, title: undefined, passageCount: undefined }, citation.index, t).split(' · ').slice(1) : [];
    const subtitle = [...where, source?.section].filter(Boolean).join(' · ');

    return (
        <Sheet
            visible={citation !== null}
            onClose={onClose}
            title={source?.title || `${t('notebooks.source', 'Source')} ${(citation?.index ?? 0) + 1}`}
            subtitle={subtitle || undefined}
            footer={
                <Text variant="label" tone="tertiary">
                    {t('notebooks.source_number', 'Source #{index}', { index: (citation?.index ?? 0) + 1 })}
                </Text>
            }
        >
            <Text variant="body" tone="secondary" selectable>
                {source?.snippet || t('notebooks.no_content_preview', 'No content preview available.')}
            </Text>
        </Sheet>
    );
}
