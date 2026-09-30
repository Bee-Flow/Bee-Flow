/** The head of a raw-payload row: its label, "Click to reveal" while hidden, and Copy. */

import * as Clipboard from 'expo-clipboard';
import React from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text, useToast } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing.sm, minHeight: 32 },
    grow: { flex: 1 },
});

export function PayloadHeader({
    label,
    revealed,
    onReveal,
    copyText,
}: {
    label: string;
    revealed: boolean;
    onReveal: () => void;
    /** What Copy puts on the clipboard — the real text, revealed or not. */
    copyText: string;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const copy = () => {
        void Clipboard.setStringAsync(copyText);
        toast(t('mobile.chat.copied', 'Copied'));
    };
    return (
        <View style={styles.head}>
            <Text variant="label" tone="tertiary" style={styles.grow} numberOfLines={1}>
                {label}
            </Text>
            {!revealed ? (
                <Pressable onPress={onReveal} accessibilityRole="button" hitSlop={8}>
                    <Text variant="label" tone="accent">
                        {t('privacy.click_to_reveal', 'Click to reveal')}
                    </Text>
                </Pressable>
            ) : null}
            <Pressable onPress={copy} accessibilityRole="button" hitSlop={8}>
                <Text variant="label" tone="tertiary">
                    {t('chat.copy', 'Copy')}
                </Text>
            </Pressable>
        </View>
    );
}
