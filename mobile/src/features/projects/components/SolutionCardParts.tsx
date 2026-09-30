/**
 * The parts of an overview card that turn a state into words and colour — the
 * web's SolutionCard.jsx, part for part. They add nothing to the states
 * overview.ts decided; each "we do not know" state has a visible treatment of
 * its own, so none of them can pass for good news.
 */

import React from 'react';
import { View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Icon, KIND_ICON, Text, kindColor, tint, type BadgeTone, type IconName, type KindKey } from '@/shared/ui';

import { chipsOf, healthOf, runsOf, updateOf, type HealthState } from '../model/overview';
import type { SolutionRow } from '../model/solution';
import { byCount, countPhrase, COUNTED_SECTIONS, sectionNames } from '../model/words';

const HEALTH: Record<HealthState, { tone: BadgeTone; icon: IconName }> = {
    unknown: { tone: 'neutral', icon: 'CircleQuestionMark' },
    unread: { tone: 'error', icon: 'TriangleAlert' },
    blocking: { tone: 'error', icon: 'TriangleAlert' },
    advice: { tone: 'warning', icon: 'Info' },
    clear: { tone: 'success', icon: 'CircleCheck' },
};

function healthWords(state: HealthState, count: number, t: TranslateFn): string {
    const p = { count };
    switch (state) {
        case 'blocking':
            return byCount(count, t('solutions.card_health_blocking', '{count} thing to fix', p), t('solutions.card_health_blocking_plural', '{count} things to fix', p));
        case 'advice':
            return byCount(count, t('solutions.card_health_advice', '{count} thing to look at', p), t('solutions.card_health_advice_plural', '{count} things to look at', p));
        case 'unread':
            return t('solutions.card_health_unread', 'Could not be fully read');
        case 'clear':
            return t('solutions.card_health_clear', 'Complete');
        default:
            return t('solutions.card_health_unknown', 'Not checked');
    }
}

export function HealthChip({ row }: { row: SolutionRow }) {
    const t = useTranslation();
    const health = healthOf(row);
    const look = HEALTH[health.state];
    return (
        <Badge label={healthWords(health.state, health.count, t)} tone={look.tone} icon={look.icon} testID={`solution-health-${health.state}`} />
    );
}

/** Icon + number per kind, and the kinds whose number could not be read. */
export function CountChips({ row }: { row: SolutionRow }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { chips, unreadable } = chipsOf(row);
    if (chips.length === 0 && unreadable.length === 0) return null;
    return (
        <View style={styles.chips}>
            {chips.map(({ section, kind, count }) => (
                <View key={section} style={[styles.chip, styles.fill[kind]]} accessible accessibilityLabel={countPhrase(section, count, t) ?? String(count)}>
                    <Icon name={KIND_ICON[kind]} size={10} color={styles.ink[kind].color as string} />
                    <Text variant="label" weight="semibold" style={styles.ink[kind]}>
                        {String(count)}
                    </Text>
                </View>
            ))}
            {unreadable.length > 0 ? (
                <Text variant="caption" tone="tertiary">
                    {t('solutions.card_counts_partial', 'Not everything could be counted: {sections}', {
                        sections: sectionNames(unreadable, t).join(', '),
                    })}
                </Text>
            ) : null}
        </View>
    );
}

/** How often it ran today — including "nobody could tell", which is never silence. */
export function RunLine({ row }: { row: SolutionRow }) {
    const t = useTranslation();
    const runs = runsOf(row);
    if (runs.state === 'unknown') {
        return <Text variant="caption" tone="tertiary">{t('solutions.card_runs_unknown', 'Runs could not be counted')}</Text>;
    }
    if (runs.state === 'idle') {
        return <Text variant="caption" tone="tertiary">{t('solutions.card_runs_idle', 'Nothing ran today')}</Text>;
    }
    const today = runs.today ?? 0;
    const failed = runs.failed ?? 0;
    const p = { count: today };
    const f = { count: failed };
    return (
        <Text variant="caption" tone="tertiary">
            {byCount(today, t('solutions.card_runs_today', '{count} run today', p), t('solutions.card_runs_today_plural', '{count} runs today', p))}
            {runs.state === 'failed' ? (
                <Text variant="caption" tone="error">
                    {` · ${byCount(failed, t('solutions.card_runs_failed', '{count} failed', f), t('solutions.card_runs_failed_plural', '{count} failed', f))}`}
                </Text>
            ) : null}
        </Text>
    );
}

/** "v1.5 available", or the honest "could not be checked". Current and not-installed say nothing. */
export function UpdateChip({ row }: { row: SolutionRow }) {
    const t = useTranslation();
    const update = updateOf(row);
    if (!update || update.state === 'current') return null;
    if (update.state === 'unknown') {
        return (
            <Text variant="caption" tone="tertiary">
                {t('solutions.card_update_unknown', 'Whether there is a newer version could not be checked')}
            </Text>
        );
    }
    const label =
        update.latestVersion === null
            ? t('solutions.card_update_any', 'A newer version is available')
            : t('solutions.card_update_available', 'v{version} available', { version: update.latestVersion });
    return <Badge label={label} tone="warning" icon="ArrowUp" />;
}

/** Role, and where this Solution came from. */
export function subLine(row: SolutionRow, t: TranslateFn): string {
    const role =
        row.permission === 'owner'
            ? t('solutions.card_role_owner', 'owner')
            : row.permission === 'editor'
              ? t('solutions.card_role_editor', 'editor')
              : t('solutions.card_role_viewer', 'viewer');
    if (!row.installedFromBlueprintId) return role;
    const installedVersion = updateOf(row)?.installedVersion ?? null;
    const from =
        installedVersion !== null
            ? t('solutions.card_installed_at', 'installed at v{version}', { version: installedVersion })
            : t('solutions.card_installed_from', 'installed from a Blueprint');
    return `${role} · ${from}`;
}

const makeStyles = (theme: Theme) => {
    const kinds = COUNTED_SECTIONS.map((s) => s.kind);
    return {
        chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing[1.5] } satisfies ViewStyle,
        chip: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing[1],
            paddingHorizontal: theme.spacing[1.5],
            paddingVertical: 2,
            borderRadius: theme.radii.pill,
        } satisfies ViewStyle,
        fill: Object.fromEntries(kinds.map((k) => [k, { backgroundColor: tint(kindColor(theme, k), 14) }])) as Record<KindKey, ViewStyle>,
        ink: Object.fromEntries(kinds.map((k) => [k, { color: kindColor(theme, k) }])) as Record<KindKey, TextStyle>,
    };
};
