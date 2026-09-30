/**
 * Knowledge bases in the ＋ sheet — the reason the sheet exists.
 * `knowledgeBaseIds` rides on the turn and the server runs access-validated
 * retrieval against it (promptAssembly.js); without this there was no way
 * anywhere in the app to ask a question of an uploaded document.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { CHOICE_LIST_STALE_MS } from '@/features/chat/hooks/queries';
import type { ChatContext } from '@/features/chat/model/types';
import { useKnowledgeBases } from '@/features/knowledge';
import { Button, Chip, ListSkeleton, Text } from '@/shared/ui';

import { ContextSectionLabel } from './ContextSectionLabel';

const makeStyles = (theme: Theme) => ({
    chips: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: theme.spacing.sm },
    empty: { gap: theme.spacing.md, alignItems: 'flex-start' as const },
});

export function ContextBases({
    visible,
    context,
    onChange,
    onClose,
}: {
    /** Fetched only while the sheet is open: the composer is on every chat. */
    visible: boolean;
    context: ChatContext;
    onChange: (next: ChatContext) => void;
    onClose: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const bases = useKnowledgeBases({ enabled: visible, staleTime: CHOICE_LIST_STALE_MS });

    const toggleBase = (id: string) => {
        const on = context.knowledgeBaseIds.includes(id);
        onChange({
            ...context,
            knowledgeBaseIds: on ? context.knowledgeBaseIds.filter((v) => v !== id) : [...context.knowledgeBaseIds, id],
        });
    };

    return (
        <View>
            <ContextSectionLabel
                hint={t(
                    'mobile.chat.kb_hint',
                    'The assistant reads the passages most relevant to your question, not the whole base.',
                )}
            >
                {t('chat.composer.kb_panel_title', 'Knowledge bases')}
            </ContextSectionLabel>
            {bases.isLoading ? (
                <ListSkeleton rows={3} />
            ) : bases.data?.length ? (
                <View style={styles.chips}>
                    {bases.data.map((kb) => (
                        <Chip
                            key={kb.id}
                            label={kb.name}
                            selected={context.knowledgeBaseIds.includes(kb.id)}
                            onPress={() => toggleBase(kb.id)}
                        />
                    ))}
                </View>
            ) : (
                <View style={styles.empty}>
                    <Text variant="caption" tone="tertiary">
                        {t(
                            'mobile.chat.kb_empty',
                            'You have no knowledge bases yet. They are where documents go so the assistant can answer from them.',
                        )}
                    </Text>
                    <Button
                        label={t('mobile.chat.kb_go_library', 'Go to Library')}
                        variant="secondary"
                        onPress={() => {
                            onClose();
                            router.push('/knowledge');
                        }}
                    />
                </View>
            )}
        </View>
    );
}
