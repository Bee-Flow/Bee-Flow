/** Where the prompt is going, and whether that is outside the workspace. */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { DlpDecision } from '@/features/chat/model/types';
import { Badge, Icon, Text, tint } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    head: { flexDirection: 'row' as const, gap: theme.spacing.md, padding: theme.spacing.lg, borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle },
    tile: {
        width: 40,
        height: 40,
        borderRadius: theme.radii.lg,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        backgroundColor: tint(theme.colors.warning, 12),
    },
    words: { flex: 1, gap: theme.spacing.xs },
    sent: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, alignItems: 'center' as const, gap: theme.spacing.xs },
});

export function DlpReviewHeader({ decision }: { decision: DlpDecision }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const provider = decision.provider ?? {};
    return (
        <View style={styles.head}>
            <View style={styles.tile}>
                <Icon name="ShieldAlert" size={20} color={theme.colors.warning} />
            </View>
            <View style={styles.words}>
                <Text variant="subheading" accessibilityRole="header">
                    {decision.kind === 'attachment'
                        ? t('dlp.review_title_attachment', 'Check this attachment before it goes to the AI')
                        : t('dlp.review_title', 'Check this before it goes to the AI')}
                </Text>
                <View style={styles.sent}>
                    <Text variant="caption" tone="tertiary">
                        {`${t('dlp.preview_subtitle', 'This prompt will be sent to')} `}
                        <Text variant="caption" weight="semibold">
                            {provider.displayName || t('mobile.chat.dlp_external_provider', 'external provider')}
                        </Text>
                    </Text>
                    {provider.isExternal !== false ? <Badge label={t('dlp.external_badge', 'external')} tone="warning" icon="Lock" /> : null}
                </View>
            </View>
        </View>
    );
}
