/** A Google Keep note the assistant drafted — a note or a checklist, new or to delete — and Confirm. */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { executeDraft } from '@/features/chat/api/drafts';
import { useDraftAction } from '@/features/chat/hooks/useDraftAction';
import { checklistOf, text } from '@/features/chat/model/draftView';
import { executeHeader } from '@/features/chat/model/executeHeader';
import type { DraftRecord } from '@/features/chat/model/types';
import { Button, Icon, Text } from '@/shared/ui';

import { DraftCardShell } from './DraftCardShell';

const makeStyles = (theme: Theme) => ({
    item: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing.sm },
    ticked: { textDecorationLine: 'line-through' as const, opacity: 0.6 },
});

export function KeepDraftCard({ draft, draftKey }: { draft: DraftRecord; draftKey: string }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const state = useDraftAction(draftKey, draft.status);
    const remove = draft.action === 'delete';
    const label = remove ? t('mobile.chat.draft_keep_delete', 'Delete Note') : t('mobile.chat.draft_keep_new', 'New Note');
    return (
        <DraftCardShell
            state={state}
            header={executeHeader(state, label, t('chat.draft.saving', 'Saving...'), t)}
            icon={remove ? 'Trash2' : 'Plus'}
            tone={remove ? 'error' : 'warning'}
            title={text(draft, 'title') || t('chat.draft.untitled', '(untitled)')}
            titleIcon={draft.type === 'list' ? 'ListChecks' : 'StickyNote'}
            actions={
                <Button
                    label={remove ? t('common.delete', 'Delete') : t('chat.draft.confirm', 'Confirm')}
                    iconName="Check"
                    variant={remove ? 'danger' : 'primary'}
                    size="sm"
                    loading={state.status === 'working'}
                    onPress={() => state.run(() => executeDraft('keep', draft))}
                />
            }
        >
            {text(draft, 'content') ? (
                <Text variant="caption" tone="secondary" selectable>
                    {text(draft, 'content')}
                </Text>
            ) : null}
            {checklistOf(draft).map((item, index) => (
                <View key={index} style={styles.item}>
                    <Icon name={item.checked ? 'SquareCheckBig' : 'Square'} size={14} color={theme.colors.textTertiary} />
                    <Text variant="caption" tone="secondary" style={item.checked ? styles.ticked : null}>
                        {item.text}
                    </Text>
                </View>
            ))}
        </DraftCardShell>
    );
}
