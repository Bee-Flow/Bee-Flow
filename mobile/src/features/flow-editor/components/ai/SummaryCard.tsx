/**
 * The AI-written summary of what the routine does, over the builder
 * conversation — the web header's AutomationSummary, folded to a line until
 * opened.
 */

import React, { useState } from 'react';
import { Pressable, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles } from '@/core/theme/ThemeProvider';
import { Markdown } from '@/shared/markdown';
import { Icon, Text } from '@/shared/ui';

import { makeSessionCardStyles } from './sessionCardStyles';

export function SummaryCard({ summary }: { summary: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeSessionCardStyles);
    const [open, setOpen] = useState(false);
    if (!summary.trim()) return null;
    return (
        <Pressable style={styles.card} onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }}>
            <View style={styles.head}>
                <Icon name="Info" size={14} color={styles.open.color} />
                <Text variant="label" tone="tertiary">{t('mobile.flow.ai.summary', 'What this routine does').toUpperCase()}</Text>
            </View>
            {open ? <Markdown value={summary} /> : <Text variant="caption" tone="secondary" numberOfLines={2}>{summary}</Text>}
        </Pressable>
    );
}
