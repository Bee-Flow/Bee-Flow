/** The buttons at the end of a source row: stop waiting, retry, remove. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs } });

export function SourceActions({
    name,
    onCancel,
    onRetry,
    onDelete,
}: {
    name: string;
    /** Only while the source is still working. */
    onCancel?: () => void;
    /** Only once it has failed. */
    onRetry?: () => void;
    onDelete?: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            {onCancel ? (
                <IconButton
                    icon={<Icon name="Ban" size={16} color={theme.colors.textMuted} />}
                    accessibilityLabel={t('notebooks.cancel_ingestion', 'Cancel ingestion')}
                    accessibilityHint={name}
                    onPress={onCancel}
                />
            ) : null}
            {onRetry ? (
                <IconButton
                    icon={<Icon name="RotateCw" size={16} color={theme.colors.accentPrimary} />}
                    accessibilityLabel={t('notebooks.retry_ingestion', 'Retry ingestion')}
                    accessibilityHint={name}
                    onPress={onRetry}
                />
            ) : null}
            {onDelete ? (
                <IconButton
                    icon={<Icon name="Trash2" size={16} color={theme.colors.textMuted} />}
                    accessibilityLabel={t('notebooks.remove_source', 'Remove source')}
                    accessibilityHint={name}
                    onPress={onDelete}
                />
            ) : null}
        </View>
    );
}
