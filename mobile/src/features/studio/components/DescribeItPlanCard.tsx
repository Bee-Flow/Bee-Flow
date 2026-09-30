/**
 * The Describe-it plan — the web's PlanCard (studioAi/DescribeItPanel.jsx):
 * "New <kind>: <name>" beside the kind's tile, on a 4% tint of its colour;
 * the building blocks (the chosen one, then the companions, shown for
 * context only); a lock notice when the kind is no door for this person; and
 * the caveats. Its two buttons live in the sheet's footer.
 */

import React from 'react';
import { View, type TextStyle, type ViewStyle } from 'react-native';

import { lockHint } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { perTheme, useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, KIND_KEYS, kindColor, KindTile, Text, tint, type KindKey } from '@/shared/ui';

import { DescribeItBlock } from './DescribeItBlock';
import { DescribeItCaveats } from './DescribeItCaveats';
import { kindWord, type DescribeItDoor, type DescribeItPlan } from '../model/describeIt';

export interface DescribeItPlanCardProps {
    plan: DescribeItPlan;
    door: DescribeItDoor;
}

export function DescribeItPlanCard({ plan, door }: DescribeItPlanCardProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const word = kindWord(plan.kind, t);
    const title = plan.name
        ? t('studio.ai.plan_title', 'New {kind}: {name}', { kind: word, name: plan.name })
        : t('studio.ai.plan_title_unnamed', 'New {kind}', { kind: word });
    const open = door.state === 'open';
    return (
        <View testID="studio-ai-plan" style={[styles.card, styles.fill[plan.kind]]}>
            <View style={styles.head}>
                <KindTile kind={plan.kind} />
                <Text variant="subheading" accessibilityRole="header" style={styles.title}>
                    {title}
                </Text>
            </View>
            <View style={styles.blocks}>
                <Text variant="label" tone="tertiary" style={styles.caps}>
                    {t('studio.ai.blocks', 'Building blocks')}
                </Text>
                <DescribeItBlock kind={plan.kind} name={plan.name} />
                {plan.companions.map((c) => (
                    <DescribeItBlock
                        key={c.kind}
                        kind={c.kind}
                        name={c.name}
                        note={t('studio.ai.companion_note', 'Shown for context — this version does not create it yet.')}
                    />
                ))}
            </View>
            {open ? null : (
                <View testID="studio-ai-lock" style={styles.lock}>
                    <Icon name="Lock" size={14} color={theme.colors.textTertiary} style={styles.lockGlyph} />
                    <Text variant="caption" tone="tertiary" style={styles.lockText}>
                        {door.state === 'locked'
                            ? lockHint(door.reason, t)
                            : t('studio.ai.unavailable', 'This building block is not available in your workspace.')}
                    </Text>
                </View>
            )}
            <DescribeItCaveats plan={plan} open={open} />
        </View>
    );
}

const makeStyles = perTheme((theme: Theme) => ({
    card: {
        gap: theme.spacing[2.5],
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        borderRadius: theme.radii.md,
        paddingHorizontal: theme.spacing[3.5],
        paddingVertical: theme.spacing[3],
    } satisfies ViewStyle,
    head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] } satisfies ViewStyle,
    title: { flex: 1 } satisfies TextStyle,
    blocks: { gap: theme.spacing[1] } satisfies ViewStyle,
    caps: { textTransform: 'uppercase', letterSpacing: 0.44 } satisfies TextStyle,
    lock: { flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing[1.5] } satisfies ViewStyle,
    lockGlyph: { marginTop: 2 } satisfies ViewStyle,
    lockText: { flex: 1 } satisfies TextStyle,
    /** kindTint(kind, 4) per kind: the card wears its kind's colour. */
    fill: Object.fromEntries(KIND_KEYS.map((k) => [k, { backgroundColor: tint(kindColor(theme, k), 4) }])) as Record<KindKey, ViewStyle>,
}));
