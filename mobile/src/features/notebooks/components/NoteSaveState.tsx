/**
 * Where the notes stand, in the web's four words (NotebookWorkspace.jsx
 * SaveStateIndicator): Unsaved changes, Saving…, Saved, Save failed — retry.
 * The failure is a button, because retrying is the only useful next step.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Spinner, Text } from '@/shared/ui';

import type { NoteStatus } from '../model/noteSaver';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs, minHeight: 24 },
    });

export function NoteSaveState({ status, error, onRetry }: { status: NoteStatus; error: string | null; onRetry: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);

    if (status === 'error') {
        return (
            <Pressable
                style={styles.row}
                onPress={onRetry}
                accessibilityRole="button"
                accessibilityHint={error ?? undefined}
                accessibilityLiveRegion="polite"
                hitSlop={8}
            >
                <Icon name="CircleAlert" size={14} color={theme.colors.error} />
                <Text variant="caption" tone="error">
                    {t('notebooks.save_failed_retry', 'Save failed — retry')}
                </Text>
            </Pressable>
        );
    }
    const words: Partial<Record<NoteStatus, string>> = {
        dirty: t('notebooks.unsaved_changes', 'Unsaved changes'),
        saving: t('notebooks.saving', 'Saving…'),
        saved: t('notebooks.saved', 'Saved'),
    };
    const label = words[status];
    return (
        <View style={styles.row} accessibilityLiveRegion="polite">
            {status === 'saving' ? <Spinner size="small" /> : null}
            {status === 'saved' ? <Icon name="CircleCheck" size={14} color={theme.colors.textMuted} /> : null}
            {label ? (
                <Text variant="caption" tone="tertiary">
                    {label}
                </Text>
            ) : null}
        </View>
    );
}
