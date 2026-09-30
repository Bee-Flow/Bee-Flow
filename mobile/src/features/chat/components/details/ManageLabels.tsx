/**
 * Every label, renamable in place and deletable. Deleting takes the label off
 * every conversation, so it asks first.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import type { ChatDetails } from '@/features/chat/hooks/useChatDetails';
import type { ChatLabel } from '@/features/chat/model/types';
import { useConfirm } from '@/shared/patterns';
import { Card, Divider, Icon, IconButton, ListRow } from '@/shared/ui';

import { LabelRenameRow } from './LabelRenameRow';

export function ManageLabels({ details }: { details: ChatDetails }) {
    const theme = useTheme();
    const t = useTranslation();
    const confirm = useConfirm();
    const { labelsQuery, appliedLabelIds, editingLabelId, setEditingLabelId, renameLabel, dropLabel } = details;
    const labels = labelsQuery.data ?? [];
    if (labels.length === 0) return null;

    const askToDelete = async (label: ChatLabel) => {
        const ok = await confirm({
            title: t('mobile.chat.details.delete_label_title', 'Delete “{name}”?', { name: label.name }),
            message: t(
                'mobile.chat.details.delete_label_message',
                'It will be removed from every conversation that uses it. This cannot be undone.',
            ),
            confirmLabel: t('common.delete', 'Delete'),
        });
        if (ok) dropLabel.mutate(label.id);
    };

    return (
        <Card padded={false}>
            {labels.map((label, index) => (
                <View key={`manage-${label.id}`}>
                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                    {editingLabelId === label.id ? (
                        <LabelRenameRow
                            initial={label.name}
                            busy={renameLabel.isPending}
                            onCancel={() => setEditingLabelId(null)}
                            onSave={(name) => renameLabel.mutate({ labelId: label.id, name })}
                        />
                    ) : (
                        <ListRow
                            title={label.name}
                            subtitle={appliedLabelIds.includes(label.id) ? t('mobile.chat.details.label_applied', 'On this chat') : undefined}
                            onPress={() => setEditingLabelId(label.id)}
                            chevron={false}
                            trailing={
                                <IconButton
                                    icon={<Icon name="Trash2" size={16} color={theme.colors.error} />}
                                    tone="danger"
                                    accessibilityLabel={t('mobile.chat.details.delete_label', 'Delete the label {name}', { name: label.name })}
                                    onPress={() => void askToDelete(label)}
                                />
                            }
                        />
                    )}
                </View>
            ))}
        </Card>
    );
}
