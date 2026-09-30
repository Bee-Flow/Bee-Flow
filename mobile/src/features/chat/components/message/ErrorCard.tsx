/**
 * An answer that failed, as the web's error card draws it: a heading that
 * names the kind of failure, the server's sentence under it, and "Try again"
 * when the transcript offers one. A usage or subscription limit is amber, not
 * red — it is a state of the account, not a fault, and retrying will not help.
 */

import React from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { errorKindOf } from '@/features/chat/model/errorKind';
import { Icon, Text, tint } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    card: {
        flexDirection: 'row' as const,
        gap: theme.spacing.md,
        padding: theme.spacing.md,
        borderRadius: theme.radii.lg,
        borderWidth: 1,
    },
    fault: { backgroundColor: tint(theme.colors.error, 12), borderColor: tint(theme.colors.error, 45) },
    limit: { backgroundColor: tint(theme.colors.warning, 12), borderColor: tint(theme.colors.warning, 45) },
    body: { flex: 1, gap: theme.spacing.xs },
    retry: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6, minHeight: 32, marginTop: theme.spacing.xs },
});

export function ErrorCard({ error, onRetry }: { error: string; onRetry?: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const kind = errorKindOf(error);
    const tone = kind.limit ? 'warning' : 'error';

    return (
        <View style={[styles.card, kind.limit ? styles.limit : styles.fault]} accessibilityRole="alert">
            <Icon name={kind.limit ? 'TriangleAlert' : 'CircleX'} size={18} color={theme.colors[tone]} />
            <View style={styles.body}>
                <Text variant="body" tone={tone} weight="semibold">
                    {t(kind.i18nKey, kind.en)}
                </Text>
                <Text variant="caption" tone={tone} selectable>
                    {error}
                </Text>
                {onRetry ? (
                    <Pressable onPress={onRetry} accessibilityRole="button" style={styles.retry}>
                        <Icon name="RefreshCw" size={14} color={theme.colors.accentText} />
                        <Text variant="caption" tone="accent">
                            {t('chat.retry', 'Retry')}
                        </Text>
                    </Pressable>
                ) : null}
            </View>
        </View>
    );
}
