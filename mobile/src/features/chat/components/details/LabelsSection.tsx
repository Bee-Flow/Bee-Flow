/**
 * Labels are GLOBAL to the user, not to the chat: `labels_json` on the
 * conversation is a JSON array of label ids, and the labels themselves live
 * under /ai/labels. Deleting one therefore removes it from every conversation,
 * which is why that action confirms and the assign action does not.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ChatDetails } from '@/features/chat/hooks/useChatDetails';
import { Button, Section, TextField } from '@/shared/ui';

import { LabelChips } from './LabelChips';
import { ManageLabels } from './ManageLabels';

const makeStyles = (theme: Theme) => ({
    newRow: { flexDirection: 'row' as const, alignItems: 'flex-end' as const, gap: theme.spacing.sm },
    field: { flex: 1 },
});

export function LabelsSection({ details }: { details: ChatDetails }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { newLabel, setNewLabel, addLabel } = details;
    return (
        <Section
            title={t('sidebar.labels', 'Labels')}
            subtitle={t('mobile.chat.details.labels_subtitle', 'Labels are shared across all your chats — deleting one removes it everywhere.')}
        >
            <LabelChips details={details} />

            <View style={styles.newRow}>
                <TextField
                    label={t('sidebar.new_label', 'New label')}
                    value={newLabel}
                    onChangeText={setNewLabel}
                    placeholder={t('mobile.chat.details.label_example', 'Invoices')}
                    returnKeyType="done"
                    containerStyle={styles.field}
                    onSubmitEditing={() => newLabel.trim() && addLabel.mutate(newLabel.trim())}
                />
                <Button
                    label={t('common.add', 'Add')}
                    variant="secondary"
                    onPress={() => addLabel.mutate(newLabel.trim())}
                    disabled={!newLabel.trim() || addLabel.isPending}
                    loading={addLabel.isPending}
                />
            </View>

            <ManageLabels details={details} />
        </Section>
    );
}
