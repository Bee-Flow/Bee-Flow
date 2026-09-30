/**
 * Web search, in the ＋ sheet: on a privacy product "did my question leave the
 * building" is a per-turn decision and belongs in front of the person making
 * it, not in a settings screen they visited once.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Switch, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
        gap: theme.spacing.lg,
    },
    text: { flex: 1, gap: 2 },
});

export function WebSearchToggle({ value, onChange }: { value: boolean; onChange: (next: boolean) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            <View style={styles.text}>
                <Text variant="subheading">{t('chat.composer.tools_web_search', 'Web search')}</Text>
                <Text variant="caption" tone="tertiary">
                    {t('mobile.chat.web_search_hint', 'When on, this question can leave your server.')}
                </Text>
            </View>
            <Switch
                value={value}
                onValueChange={onChange}
                accessibilityLabel={t('mobile.chat.web_search_label', 'Search the web for this chat')}
            />
        </View>
    );
}
