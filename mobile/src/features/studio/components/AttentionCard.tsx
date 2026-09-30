/**
 * "Needs attention" on the Studio hub, compact: the heading with how many
 * things, the line that says whether that is the whole picture
 * (model/attentionText), and the first few GROUPS of findings — eighty
 * warnings of one kind are one line with a count (model/attentionGroups).
 * "Show all" opens the whole list (screens/AttentionScreen) with every
 * producer's sentence and its "Show me". Nothing is drawn before the first
 * answer lands.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Card, Icon, Text, tonePair } from '@/shared/ui';

import { AttentionGroupRow } from './AttentionGroupRow';
import type { StudioAttention } from '../model/api';
import { worstSeverity } from '../model/attention';
import { groupAttention } from '../model/attentionGroups';
import { attentionLineText } from '../model/attentionText';
import { nOf } from '../model/plural';

/** The groups the card draws; "Show all" has the rest. */
const SHOWN = 3;

export const ATTENTION_HREF = '/studio/attention';

const SEVERITY_GLYPH = { error: 'CircleAlert', warning: 'TriangleAlert', info: 'Info' } as const;
export const SEVERITY_TONE = { error: 'error', warning: 'warning', info: 'neutral' } as const;

export function AttentionCard({ attention }: { attention: StudioAttention }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const router = useRouter();
    const line = attentionLineText(attention, t);
    const groups = groupAttention(attention.rows);
    const severity = worstSeverity(attention.rows);
    const any = attention.total > 0;
    const showAll = () => router.push(ATTENTION_HREF);
    return (
        <Card testID="studio-attention" padded={false}>
            <View style={styles.body}>
                <View style={styles.heading}>
                    {any ? <Icon name={SEVERITY_GLYPH[severity]} size={16} color={tonePair(theme.colors, SEVERITY_TONE[severity]).ink} /> : null}
                    <Text variant="body" weight="semibold" accessibilityRole="header" style={styles.flex} numberOfLines={1}>
                        {any
                            ? nOf(t, 'studio.attention.count', attention.total, ['{count} thing needs attention', '{count} things need attention'])
                            : t('studio.attention.title', 'Needs attention')}
                    </Text>
                    {any ? (
                        <Pressable onPress={showAll} accessibilityRole="button" hitSlop={12} testID="studio-attention-all">
                            <Text variant="caption" tone="accent" weight="semibold">
                                {t('mobile.studio.attention_show_all', 'Show all')}
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
                {line ? (
                    <Text variant="label" tone={attention.complete ? 'tertiary' : 'secondary'} numberOfLines={3} testID="studio-attention-line">
                        {line}
                    </Text>
                ) : null}
                {groups.slice(0, SHOWN).map((group) => (
                    <AttentionGroupRow key={group.key} group={group} onShowAll={showAll} />
                ))}
            </View>
        </Card>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing[1.5], paddingHorizontal: theme.spacing[3.5], paddingVertical: theme.spacing[3] } satisfies ViewStyle,
    heading: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] } satisfies ViewStyle,
    flex: { flex: 1 },
});
