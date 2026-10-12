/**
 * One run in the log — the web's ExecutionsTable row folded into a phone row:
 * the outcome as its glyph, what ran, what happened in a sentence (the
 * failure's reason leads, in its tone), then who started it, how long it took
 * and when.
 *
 * A row opens its run only when the viewer may: in the organisation scope
 * every per-run route is the owner's alone, so a colleague's row says so
 * instead of offering a screen that would answer 403.
 */

import React from 'react';
import { Pressable, View } from 'react-native';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { StatusIcon } from '@/features/automations';
import { formatSeconds } from '@/shared/lib/elapsed';
import { InlineMarkdown } from '@/shared/markdown';
import { Icon, Text, type TextTone } from '@/shared/ui';

import { enteredTriggerLabel, triggerWords, whatHappened, type HappenedTone } from '../model/runLanguage';
import type { LogRun } from '../model/types';

const TONE: Record<HappenedTone, TextTone> = { neutral: 'secondary', warn: 'warning', error: 'error' };

/** "Started by hand · 3m 5s · Test run" — the facts under the sentence. */
function factsLine(run: LogRun, t: TranslateFn, openable: boolean): string {
    const trigger = triggerWords(run.triggerKind);
    const entered = enteredTriggerLabel(run);
    return [
        trigger ? t(trigger.key, trigger.en) : run.triggerKind?.replace(/_/g, ' '),
        entered,
        run.durationMs !== null ? formatSeconds(run.durationMs / 1000) : null,
        run.mode === 'dry_run' ? t('mobile.runs.test_run', 'Test run') : null,
        openable ? null : t('mobile.runs.not_yours', 'Started by someone else'),
    ]
        .filter(Boolean)
        .join(' · ');
}

export function RunLogRow({ run, openable, onOpen }: { run: LogRun; openable: boolean; onOpen: (run: LogRun) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const said = whatHappened(run);
    const title = run.automationTitle || t('runs.now.untitled', 'An automation without a name');
    const sentence = t(said.key, said.en, said.params);
    return (
        <Pressable
            onPress={openable ? () => onOpen(run) : undefined}
            disabled={!openable}
            accessibilityRole={openable ? 'button' : undefined}
            accessibilityLabel={`${title}. ${sentence}`}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            testID={`run-log-row-${run.id}`}
        >
            <View style={styles.glyph}>
                <StatusIcon status={run.status} />
            </View>
            <View style={styles.body}>
                <View style={styles.top}>
                    <Text variant="subheading" numberOfLines={1} style={styles.grow}>
                        {title}
                    </Text>
                    <Text variant="label" tone="tertiary">
                        {timeAgo(run.startedAt)}
                    </Text>
                </View>
                <InlineMarkdown value={sentence} variant="caption" tone={TONE[said.tone]} numberOfLines={2} />
                <Text variant="caption" tone="tertiary" numberOfLines={1}>
                    {factsLine(run, t, openable)}
                </Text>
            </View>
            {openable ? <Icon name="ChevronRight" size={18} color={styles.chevron.color} /> : null}
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row' as const,
        alignItems: 'flex-start' as const,
        gap: theme.spacing[3],
        minHeight: 64,
        paddingHorizontal: theme.spacing[4],
        paddingVertical: theme.spacing[3],
    },
    pressed: { backgroundColor: theme.colors.itemHoverBg },
    glyph: { paddingTop: theme.spacing[0.5] },
    body: { flex: 1, gap: theme.spacing[0.5] },
    top: { flexDirection: 'row' as const, alignItems: 'baseline' as const, gap: theme.spacing[2] },
    grow: { flex: 1 },
    chevron: { color: theme.colors.textMuted },
});
