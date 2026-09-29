/**
 * One run in a list.
 *
 * Not `ListRow`, and this is the one place on the tab that departs from it.
 * ListRow renders its subtitle in the muted tone, which is correct for a
 * timestamp and wrong for the sentence that explains why last night's invoice
 * routine did nothing. A failed run has to say what failed on the row itself —
 * the whole reason someone opens this screen on a phone is to find out, and
 * making them tap through to learn it is the failure mode this screen exists
 * to fix. So the row is built here, to ListRow's own metrics (64dp minimum,
 * the same gutters, the same pressed fill).
 */

import { Feather } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTranslation } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeProvider';
import { Text } from '../../../ui/Text';
import { absoluteTime, formatDuration, runElapsedMs, statusLabel, statusToken } from '../format';
import type { AutomationRun } from '../types';
import { StatusIcon } from './StatusPill';
import { relativeTime } from '../../../lib/time';

export function RunRow({
    run,
    /** Shown instead of the trigger when a list spans several routines. */
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
    const token = statusToken(run.status);
    const word = statusLabel(t, token);
    const elapsed = runElapsedMs(run);
    const failed = token.tone === 'error';

    const heading = automationTitle ?? word;
    const when = run.startedAt ? relativeTime(run.startedAt) : '';

    // What the row says out loud, in one sentence, in the order a person would
    // ask it: which routine, how it ended, when, and why if it went wrong.
    const spoken = [
        heading,
        automationTitle ? word : null,
        run.startedAt ? absoluteTime(run.startedAt) : null,
        failed && run.error ? `Error: ${run.error}` : null,
    ]
        .filter(Boolean)
        .join('. ');

    return (
        <Pressable
            onPress={onPress}
            disabled={!onPress}
            accessibilityRole={onPress ? 'button' : undefined}
            accessibilityLabel={spoken}
            accessibilityState={{ selected }}
            style={({ pressed }) => [
                {
                    minHeight: 64,
                    flexDirection: 'row',
                    alignItems: 'flex-start',
                    gap: theme.spacing.md,
                    paddingHorizontal: theme.spacing.lg,
                    paddingVertical: theme.spacing.md,
                    backgroundColor: selected
                        ? theme.colors.itemActiveBg
                        : pressed
                          ? theme.colors.itemHoverBg
                          : 'transparent',
                },
            ]}
        >
            <View style={{ paddingTop: 2 }}>
                <StatusIcon status={run.status} />
            </View>

            <View style={{ flex: 1, gap: 2 }}>
                <View style={styles.titleRow}>
                    <Text variant="subheading" numberOfLines={1} style={{ flex: 1 }}>
                        {heading}
                    </Text>
                    {when ? (
                        <Text variant="label" tone="tertiary">
                            {when}
                        </Text>
                    ) : null}
                </View>

                <Text variant="caption" tone="tertiary" numberOfLines={1}>
                    {[
                        automationTitle ? word : describeTriggerKind(run.triggerKind),
                        elapsed !== null ? formatDuration(elapsed) : null,
                        // A dry run keeps its status word and says so separately,
                        // rather than "dry-run" masking whether it worked.
                        run.mode === 'dry_run' ? 'Test run' : null,
                        run.handledErrorCount > 0 ? `${run.handledErrorCount} recovered` : null,
                    ]
                        .filter(Boolean)
                        .join(' · ')}
                </Text>

                {failed && (run.summary || run.error) ? (
                    <View
                        style={{
                            flexDirection: 'row',
                            gap: theme.spacing.sm,
                            marginTop: theme.spacing.xs,
                            padding: theme.spacing.sm,
                            borderRadius: theme.radii.sm,
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: theme.colors.error,
                            backgroundColor: theme.colors.itemHoverBg,
                        }}
                    >
                        <Feather name="alert-circle" size={14} color={theme.colors.error} />
                        {/*
                          * `summary`, not `error` — and the difference is the
                          * whole point. The server composes
                          * `Failed: <cause>. <remediation>` into summary
                          * (core/automationRunner/execution.js), while `error`
                          * is the raw cause alone. This rendered `error` and
                          * suppressed `summary` on exactly the runs where the
                          * remediation existed, so the half that says what to
                          * do about it was written by the server and thrown
                          * away here.
                          *
                          * And no line clamp. It was three, which severed
                          * "The target file, board, or room was not found. —
                          * Check…" at the word that introduced the fix. A
                          * failure message that stops before the remedy is
                          * worse than no message: it looks like the whole
                          * answer.
                          */}
                        <Text variant="caption" tone="error" style={{ flex: 1 }}>
                            {run.summary || run.error}
                        </Text>
                    </View>
                ) : run.summary ? (
                    <Text variant="caption" tone="secondary" numberOfLines={2}>
                        {run.summary}
                    </Text>
                ) : null}
            </View>

            {onPress ? (
                <Feather
                    name="chevron-right"
                    size={18}
                    color={theme.colors.textMuted}
                    style={{ marginTop: 4 }}
                />
            ) : null}
        </Pressable>
    );
}

/** The trigger that started this run, in the words a person would use. */
function describeTriggerKind(kind: string | null): string {
    switch (kind) {
        case 'manual':
            return 'Started by you';
        case 'schedule':
            return 'On schedule';
        case 'webhook':
            return 'From a webhook';
        case 'form':
            return 'From a form';
        case 'app_event':
            return 'From an app event';
        case 'agent_call':
            return 'Called by an agent';
        case 'studio_app':
            return 'From an app';
        case 'dry_run':
            return 'Test run';
        case 'manual_step':
            return 'Single step';
        default:
            return kind ?? 'Run';
    }
}

const styles = StyleSheet.create({
    titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
});
