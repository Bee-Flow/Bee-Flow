/**
 * The web's sticky "unsaved changes" bar, for a settings form that saves as a
 * whole (org info, the Privacy Shield, AI context): shown only while the form
 * differs from what the server holds, with Discard and Save.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { Button } from './Button';
import { Text } from './Text';

export interface SaveBarProps {
    dirty: boolean;
    saving: boolean;
    onSave: () => void;
    onDiscard: () => void;
    /** Why Save is off (a validation error), shown in place of the prompt. */
    blockedReason?: string | null;
}

export function SaveBar({ dirty, saving, onSave, onDiscard, blockedReason }: SaveBarProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (!dirty) return null;
    return (
        <View style={styles.bar} testID="save-bar">
            <Text variant="caption" tone={blockedReason ? 'error' : 'secondary'} style={styles.text} numberOfLines={2}>
                {blockedReason || t('common.unsaved_changes', 'You have unsaved changes')}
            </Text>
            <Button
                label={t('mobile.ui.discard', 'Discard')}
                variant="ghost"
                size="sm"
                disabled={saving}
                onPress={onDiscard}
            />
            <Button
                label={t('common.save', 'Save')}
                size="sm"
                loading={saving}
                disabled={saving || Boolean(blockedReason)}
                onPress={onSave}
            />
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        bar: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderTopColor: theme.colors.borderDefault,
            backgroundColor: theme.colors.bgCard,
        },
        text: { flex: 1 },
    });
