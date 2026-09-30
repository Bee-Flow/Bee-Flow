/**
 * The run in progress. Present only while something is actually going, so
 * the screen is quiet when there is nothing to watch.
 *
 * The step it is at is named from the routine's definition ("Send the
 * invoice"), never by the id the live feed carries (`act_4d4307a`).
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Card, Spinner, Text } from '@/shared/ui';

import type { RunStreamState } from '../hooks/useRunStream';
import { statusLabel, statusToken } from '../model/status';
import { runStepNames, runStepTitle, type NamedDefinitionInput, type NameTranslate } from '../model/stepLabels';
import type { ActiveRun } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
        text: { flex: 1, gap: 2 },
    });

/** The step the feed last reported for THIS run, by name; null when it has not reported one. */
export function liveStepName(run: ActiveRun, stream: RunStreamState, definition: NamedDefinitionInput, t: NameTranslate): string | null {
    const last = stream.last;
    if (!last?.stepId || (last.runId && last.runId !== run.runId)) return null;
    return runStepTitle(last, runStepNames(definition, t), t);
}

export function LiveRunCard({
    run,
    stream,
    definition,
    onStop,
}: {
    run: ActiveRun;
    stream: RunStreamState;
    /** The routine's definition, which names the step the run is at. */
    definition: NamedDefinitionInput;
    onStop: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const started = timeAgo(run.startedAt, { suffix: true });
    const step = liveStepName(run, stream, definition, t);
    return (
        <Card>
            <View style={styles.row} accessibilityLiveRegion="polite">
                <Spinner />
                <View style={styles.text}>
                    <Text variant="subheading">
                        {statusLabel(t, statusToken(stream.statuses[run.runId] ?? run.status))}
                    </Text>
                    <Text variant="caption" tone="tertiary">
                        {step
                            ? t('mobile.automations.live.at_step', 'Now: {step} · started {time}', { step, time: started })
                            : t('mobile.automations.live.started', 'Started {time}', { time: started })}
                    </Text>
                </View>
                <Button label={t('mobile.automations.live.stop', 'Stop')} variant="danger" onPress={onStop} />
            </View>
        </Card>
    );
}
