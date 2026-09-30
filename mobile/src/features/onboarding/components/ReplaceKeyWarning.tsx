/**
 * The server refused to overwrite an existing key (HTTP 409). Replacing it
 * orphans every encrypted row the account owns, so the question is asked in
 * as many words, with the safe answer one tap away.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => StyleSheet.create({ stack: { gap: theme.spacing.md } });

export function ReplaceKeyWarning({
    warning,
    busy,
    onReplace,
    onCancel,
}: {
    warning: string;
    busy: boolean;
    onReplace: () => void;
    onCancel: () => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <View style={styles.stack}>
            <Banner tone="error" icon="OctagonAlert">
                {warning}
            </Banner>
            <Text variant="caption" tone="secondary">
                {t(
                    'mobile.onboarding.replace_key_warning',
                    'This account already has an encryption key. Setting a new one makes everything encrypted under the old key permanently unreadable — there is no undo and no copy anywhere else.',
                )}
            </Text>
            <Button
                label={t('mobile.onboarding.replace_key', 'Replace the key and lose that data')}
                onPress={onReplace}
                variant="danger"
                fullWidth
                loading={busy}
            />
            <Button label={t('common.cancel', 'Cancel')} onPress={onCancel} variant="ghost" fullWidth />
        </View>
    );
}
