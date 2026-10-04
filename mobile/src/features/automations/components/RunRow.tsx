/**
 * One run in a list.
 *
 * Not `ListRow`, and this is the one place on the tab that departs from it.
 * ListRow renders its subtitle in the muted tone, which is correct for a
 * timestamp and wrong for the sentence that explains why last night's invoice
 * automation did nothing. A failed run has to say what failed on the row itself —
 * the whole reason someone opens this screen on a phone is to find out, and
 * making them tap through to learn it is the failure mode this screen exists
 * to fix. So the row is built here, to ListRow's own metrics (64dp minimum,
 * the same gutters, the same pressed fill).
 */

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { InlineMarkdown } from '@/shared/markdown';
import { Icon, Text } from '@/shared/ui';

import { StatusIcon } from './StatusPill';
import { triggerText } from '../model/runWords';
import { statusLabel, statusToken } from '../model/status';
import { absoluteTime, formatDuration, runElapsedMs } from '../model/time';
import type { AutomationRun } from '../model/types';

/** What the row says out loud: which automation, how it ended, when, and why. */
function spokenLabel(run: AutomationRun, t: TranslateFn, heading: string, automationTitle?: string): string {
    const failed = statusToken(run.status).tone === 'error';
    return [
        heading,
        automationTitle ? statusLabel(t, statusToken(run.status)) : null,
        run.startedAt ? absoluteTime(run.startedAt) : null,
        failed && run.error ? t('mobile.automations.row.spoken_error', 'Error: {error}', { error: run.error }) : null,
    ]
        .filter(Boolean)
        .join('. ');
}

/** The second line: how it started (or its word), how long, and its marks. */
function metaLine(run: AutomationRun, t: TranslateFn, automationTitle?: string): string {
    const elapsed = runElapsedMs(run);
    return [
        // The web's "Started by" words (model/runWords), never the kind's token.
        automationTitle ? statusLabel(t, statusToken(run.status)) : run.triggerKind ? triggerText(run.triggerKind, t) : null,
        elapsed !== null ? formatDuration(elapsed) : null,
        // A dry run keeps its status word and says so separately,
        // rather than "dry-run" masking whether it worked.
        run.mode === 'dry_run' ? t('mobile.runs.trigger.dry_run', 'Test run') : null,
        run.handledErrorCount > 0
            ? t('mobile.automations.row.recovered', '{count} recovered', { count: run.handledErrorCount })
            : null,
    ]
        .filter(Boolean)
        .join(' · ');
}

/**
 * `summary`, not `error` — and the difference is the whole point. The server
 * composes `Failed: <cause>. <remediation>` into summary
 * (core/automationRunner/execution.js), while `error` is the raw cause alone;
 * rendering `error` threw away the half that says what to do about it.
 *
 * And no line clamp: three lines severed "…was not found. — Check…" at the
 * word that introduced the fix, and a failure message that stops before the
 * remedy looks like the whole answer.
 */
function RunFailureNote({ text }: { text: string }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.failure}>
            <Icon name="CircleAlert" size={14} color={theme.colors.error} />
            <InlineMarkdown value={text} variant="caption" tone="error" style={styles.flex} />
        </View>
    );
}

function RunDetailLine({ run, failed }: { run: AutomationRun; failed: boolean }) {
    const note = failed ? run.summary || run.error : null;
    if (note) return <RunFailureNote text={note} />;
    if (!run.summary) return null;
    return <InlineMarkdown value={run.summary} variant="caption" tone="secondary" numberOfLines={2} />;
}

export function RunRow({
    run,
    /** Shown instead of the trigger when a list spans several automations. */
    automationTitle,
    onPress,
    selected = false,
}: {
    run: AutomationRun;
    automationTitle?: string;
    onPress?: () => void;
    selected?: boolean;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const token = statusToken(run.status);
    const heading = automationTitle ?? statusLabel(t, token);
    const when = run.startedAt ? timeAgo(run.startedAt) : '';

    return (
        <Pressable
            onPress={onPress}
            disabled={!onPress}
            accessibilityRole={onPress ? 'button' : undefined}
            accessibilityLabel={spokenLabel(run, t, heading, automationTitle)}
            accessibilityState={{ selected }}
            style={({ pressed }) => [
                styles.row,
                selected ? styles.selected : pressed ? styles.pressed : null,
            ]}
        >
            <View style={styles.icon}>
                <StatusIcon status={run.status} />
            </View>

            <View style={styles.text}>
                <View style={styles.titleRow}>
                    <Text variant="subheading" numberOfLines={1} style={styles.flex}>
                        {heading}
                    </Text>
                    {when ? (
                        <Text variant="label" tone="tertiary">
                            {when}
                        </Text>
                    ) : null}
                </View>

                <Text variant="caption" tone="tertiary" numberOfLines={1}>
                    {metaLine(run, t, automationTitle)}
                </Text>

                <RunDetailLine run={run} failed={token.tone === 'error'} />
            </View>

            {onPress ? (
                <Icon name="ChevronRight" size={18} color={theme.colors.textMuted} style={styles.chevron} />
            ) : null}
        </Pressable>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: {
            minHeight: 64,
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            backgroundColor: 'transparent',
        },
        selected: { backgroundColor: theme.colors.itemActiveBg },
        pressed: { backgroundColor: theme.colors.itemHoverBg },
        icon: { paddingTop: 2 },
        text: { flex: 1, gap: 2 },
        titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
        flex: { flex: 1 },
        chevron: { marginTop: 4 },
        failure: {
            flexDirection: 'row',
            gap: theme.spacing.sm,
            marginTop: theme.spacing.xs,
            padding: theme.spacing.sm,
            borderRadius: theme.radii.sm,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.error,
            backgroundColor: theme.colors.itemHoverBg,
        },
    });
