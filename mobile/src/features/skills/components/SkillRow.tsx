/**
 * One row of the skill library: the icon, the name, the web's usage subline
 * ("3 agents · 1 automation", or "draft · empty") over its meta line
 * ("4 steps · 3 rules · 2 examples"), the test chip, and the phone's own
 * "use in new chats" switch.
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Switch, Text, type BadgeTone } from '@/shared/ui';

import { metaLine, testChip, usageSubline, type TestTone } from '../model/skillModel';
import type { Skill, UsageSummaryEntry } from '../model/types';

const TONE: Readonly<Record<TestTone, BadgeTone>> = { idle: 'neutral', ok: 'success', warning: 'warning', error: 'error' };

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'center',
            minHeight: 72,
            gap: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
        },
        pressed: { backgroundColor: theme.colors.itemHoverBg },
        tile: {
            width: 40,
            height: 40,
            borderRadius: theme.radii.md,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.bgTertiary,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: 'transparent',
        },
        tileOn: { backgroundColor: theme.colors.itemActiveBg, borderColor: theme.colors.accentPrimary },
        body: { flex: 1, gap: 4 },
        badges: { flexDirection: 'row', gap: theme.spacing.xs, flexWrap: 'wrap' },
    });

export function SkillRow({
    skill,
    summary,
    active,
    onPress,
    onToggle,
    onLongPress,
}: {
    skill: Skill;
    summary: UsageSummaryEntry | undefined;
    active: boolean;
    onPress: () => void;
    onToggle: () => void;
    onLongPress?: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const chip = testChip(skill.lastTest, t);
    // An automation-linked skill is forced dynamic by the runtime whatever the flag says.
    const dynamic = skill.dynamicActivation || Boolean(skill.automationId);
    const usage = usageSubline(skill, summary, t);
    return (
        <Pressable
            onPress={onPress}
            onLongPress={onLongPress}
            accessibilityRole="button"
            accessibilityLabel={skill.name}
            accessibilityHint={skill.description || undefined}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
        >
            <View style={[styles.tile, active ? styles.tileOn : null]}>
                <Text variant="heading" accessibilityElementsHidden>
                    {skill.icon}
                </Text>
            </View>
            <View style={styles.body}>
                <Text variant="subheading" numberOfLines={1}>
                    {skill.name}
                </Text>
                <Text variant="caption" tone="tertiary" numberOfLines={1}>
                    {[usage, metaLine(skill, t)].filter((s, i, all) => s && all.indexOf(s) === i).join(' · ')}
                </Text>
                <View style={styles.badges}>
                    <Badge label={chip.label} tone={TONE[chip.tone]} />
                    {skill.isShared ? (
                        <Badge
                            label={skill.sharedGroups.length > 0 ? t('mobile.skills.shared_groups', 'Shared with groups') : t('mobile.skills.shared', 'Shared')}
                        />
                    ) : null}
                    {dynamic ? <Badge label={t('mobile.skills.when_relevant', 'When relevant')} tone="accent" /> : null}
                </View>
            </View>
            <Switch value={active} onValueChange={onToggle} accessibilityLabel={t('mobile.skills.use_named', 'Use {name} in new chats', { name: skill.name })} />
        </Pressable>
    );
}
