/** Done — the only way out of the secret sheet, disabled until both acts are done. */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => StyleSheet.create({ box: { gap: theme.spacing.sm } });

function hintFor(t: TranslateFn, taken: boolean, acknowledged: boolean): string | undefined {
    if (!taken) return t('mobile.secret.hint_take', 'Copy or share the token first');
    return acknowledged ? undefined : t('mobile.secret.hint_confirm', 'Confirm that you have saved it');
}

export function SecretDone({
    taken,
    acknowledged,
    onDone,
}: {
    taken: boolean;
    acknowledged: boolean;
    onDone: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const ready = taken && acknowledged;

    return (
        <View style={styles.box}>
            <Button
                label={t('automations.sharing.done', 'Done')}
                onPress={onDone}
                size="lg"
                fullWidth
                disabled={!ready}
                accessibilityHint={hintFor(t, taken, acknowledged)}
            />
            {ready ? null : (
                <Text variant="caption" tone="tertiary" center accessibilityLiveRegion="polite">
                    {!taken
                        ? t('mobile.secret.caption_take', 'Copy or share the token, then tick the box.')
                        : t('mobile.secret.caption_confirm', 'Tick the box to confirm you have saved it.')}
                </Text>
            )}
        </View>
    );
}
