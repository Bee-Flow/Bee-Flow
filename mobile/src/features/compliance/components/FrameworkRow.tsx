/**
 * One framework on More frameworks (web pages/frameworks/FrameworkCandidateCard.jsx),
 * adapted to touch: the name with its "Recommended" and status chips, the
 * description clamped to three lines (More / Less), "Affects you:" with the
 * counts, and a footer — locked: the lock line and "View plan"; enabled:
 * "Enabled · {n} checks"; available: "Not relevant" (gated frameworks) or
 * the meta line. The switch enables and disables; tapping the row opens the
 * framework sheet (description, sources, review).
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { lockHint } from '@/core/access';
import { useLocale, useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Button, Chip, Switch, Text } from '@/shared/ui';

import type { Framework } from '../api/hubReaders';
import { formatCalDate } from '../model/calendarMath';
import { affectsCounts, countLabel, frameworkMeta, isGated, isLocked, recommendedReason, statusChipOf } from '../model/frameworkCard';

/** Above this length a description needs More / Less (the web's CLAMP_CHARS). */
const CLAMP_CHARS = 160;

export interface FrameworkRowProps {
    framework: Framework;
    busy: boolean;
    now?: number;
    onToggle: (fw: Framework, enabled: boolean) => void;
    onRelevance: (fw: Framework) => void;
    onOpen: (fw: Framework) => void;
    onViewPlan: () => void;
}

export const frameworkName = (fw: Pick<Framework, 'id' | 'name' | 'name_key'>, t: TranslateFn) => (fw.name_key ? t(fw.name_key, fw.name || fw.id) : fw.name || fw.id);

function Chips({ fw, now, t }: { fw: Framework; now?: number; t: TranslateFn }) {
    const { locale } = useLocale();
    const chip = statusChipOf(fw, now);
    const recommended = !isLocked(fw) && !fw.enabled ? recommendedReason(fw, t) : null;
    if (!chip && !recommended) return null;
    const label = chip ? t(chip.key, chip.fallback, { date: formatCalDate(chip.date, { locale }), days: chip.days ?? '' }) : '';
    return (
        <View style={ROW}>
            {recommended ? <Badge label={t('compliance.fw_recommended', 'Recommended')} tone="accent" icon="Sparkles" testID={`fw-recommended-${fw.id}`} /> : null}
            {chip ? <Badge label={label} tone={chip.tone} testID={`fw-chip-${fw.id}`} /> : null}
            {recommended ? (
                <Text variant="label" tone="tertiary">
                    {recommended}
                </Text>
            ) : null}
        </View>
    );
}

function Description({ text, t }: { text: string; t: TranslateFn }) {
    const [open, setOpen] = useState(false);
    if (!text) return null;
    const long = text.length > CLAMP_CHARS;
    return (
        <View>
            <Text variant="caption" tone="secondary" numberOfLines={open || !long ? undefined : 3}>
                {text}
            </Text>
            {long ? (
                <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }} hitSlop={8}>
                    <Text variant="label" tone="accent" weight="medium">
                        {open ? t('compliance.fw_less', 'Less') : t('compliance.fw_more', 'More')}
                    </Text>
                </Pressable>
            ) : null}
        </View>
    );
}

function Footer({ fw, busy, onRelevance, onViewPlan, t }: Pick<FrameworkRowProps, 'busy' | 'onRelevance' | 'onViewPlan'> & { fw: Framework; t: TranslateFn }) {
    if (isLocked(fw)) {
        return (
            <View style={ROW}>
                <Text variant="label" tone="tertiary" style={FLEX} testID={`fw-locked-${fw.id}`}>
                    {lockHint(fw.locked ?? '', t)}
                </Text>
                <Button variant="secondary" size="sm" iconName="ExternalLink" label={t('compliance.fw_view_plan', 'View plan')} onPress={onViewPlan} testID={`fw-view-plan-${fw.id}`} />
            </View>
        );
    }
    if (fw.enabled) {
        const text = fw.checks_count !== null ? countLabel(t, 'compliance.fw_enabled_checks', fw.checks_count, { many: 'Enabled · {n} checks', one: 'Enabled · 1 check' }) : t('compliance.fw_enabled', 'Enabled');
        return (
            <Text variant="label" tone="success">
                {text}
            </Text>
        );
    }
    const meta = frameworkMeta(fw, t);
    if (!isGated(fw)) return meta ? <Text variant="label" tone="tertiary">{meta}</Text> : null;
    return (
        <View style={ROW}>
            <Chip label={t('compliance.fw_not_relevant', 'Not relevant')} selected={fw.relevance === 'not_relevant'} disabled={busy} onPress={() => onRelevance(fw)} testID={`fw-relevance-${fw.id}`} />
            {meta ? <Text variant="label" tone="tertiary">{meta}</Text> : null}
        </View>
    );
}

export function FrameworkRow(props: FrameworkRowProps) {
    const { framework: fw, busy, now, onToggle, onOpen } = props;
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const name = frameworkName(fw, t);
    const locked = isLocked(fw);
    const affects = affectsCounts(fw.affects, t);
    return (
        <Pressable onPress={() => onOpen(fw)} style={styles.row} accessibilityRole="button" accessibilityLabel={name} testID={`framework-row-${fw.id}`}>
            <View style={styles.head}>
                <Text variant="subheading" style={FLEX}>
                    {name}
                </Text>
                <Switch value={fw.enabled} disabled={locked || busy} onValueChange={(next) => onToggle(fw, next)} accessibilityLabel={name} testID={`framework-toggle-${fw.id}`} />
            </View>
            <Chips fw={fw} now={now} t={t} />
            {!locked && fw.description_key ? <Description text={t(fw.description_key, '')} t={t} /> : null}
            {fw.affects_key ? (
                <Text variant="label" tone="tertiary" testID={`fw-affects-${fw.id}`}>
                    <Text variant="label" tone="secondary" weight="semibold">{`${t('compliance.fw_affects_label', 'Affects you:')} `}</Text>
                    {t(fw.affects_key, '')}
                    {affects ? ` · ${affects}` : ''}
                </Text>
            ) : null}
            <Footer fw={fw} t={t} busy={busy} onRelevance={props.onRelevance} onViewPlan={props.onViewPlan} />
        </Pressable>
    );
}

const { ROW, FLEX } = StyleSheet.create({
    ROW: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
    FLEX: { flex: 1, minWidth: 0 },
});

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { paddingHorizontal: theme.spacing[3.5], paddingVertical: theme.spacing[3], gap: theme.spacing[1.5] },
        head: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] },
    });
