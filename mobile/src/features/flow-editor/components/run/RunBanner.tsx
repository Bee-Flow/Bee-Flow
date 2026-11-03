/**
 * The line over the outline and the canvas about the last test run (the
 * words: runBanner.ts). While it goes, its clock ticks and — once the run
 * feed has named the run — Stop cancels it; afterwards, Show opens the step
 * it names and Details opens the result sheet. Dismissing hides the line;
 * the cards keep their colours until the next run, or Clear.
 *
 * A run that waits says on whom, with a "Test" marker on a test run, and
 * offers Stop ("Discard this test run" on a test) on every pause. A decision
 * this person may take opens the run's screen, whose Approve asks for answers
 * when the approval wants them; a form page is answered in the web builder.
 */

import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Banner, Button, Icon, IconButton, Text } from '@/shared/ui';

import { runBannerModel, type RunBannerModel } from './runBanner';
import type { TestRuns } from './useTestRuns';

const makeStyles = (theme: Theme) => ({
    wrap: { paddingHorizontal: theme.spacing[4], paddingTop: theme.spacing[2] } satisfies ViewStyle,
    actions: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1] } satisfies ViewStyle,
    paused: { gap: theme.spacing[1] } satisfies ViewStyle,
    line: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] } satisfies ViewStyle,
    text: { flexShrink: 1 } satisfies ViewStyle,
    buttons: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing[1] } satisfies ViewStyle,
    glyph: { color: theme.colors.textTertiary },
});

/** Now, every second while `live` (the elapsed clock only shows while it is). */
function useTicking(live: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!live) return undefined;
        const tick = () => setNow(Date.now());
        const first = setTimeout(tick, 0);
        const timer = setInterval(tick, 1000);
        return () => {
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [live]);
    return now;
}

export interface RunBannerProps {
    runs: TestRuns;
    onOpenStep: (stepId: string) => void;
    onDetails: () => void;
}

/** A paused run's line: what it waits on, its Test marker, and Decide / Stop / Show / Details under it. */
function PausedBody({ model, runs, onOpenStep, onDetails }: RunBannerProps & { model: RunBannerModel }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const pause = model.pause;
    const run = runs.pausedRun ?? runs.state.run;
    if (!pause) return null;
    const decide = pause.kind === 'approval' && pause.canDecide !== false && run?.id && run.automationId
        ? () => router.push(`/automations/${run.automationId}/runs?runId=${encodeURIComponent(run.id)}`)
        : null;
    return (
        <View style={styles.paused}>
            <View style={styles.line}>
                {pause.testLabel ? <Badge label={pause.testLabel} tone="ai" testID="run-test-marker" /> : null}
                <Text variant="caption" numberOfLines={2} style={styles.text}>
                    {model.text}
                </Text>
            </View>
            {pause.hint ? (
                <Text variant="caption" tone="tertiary">
                    {pause.hint}
                </Text>
            ) : null}
            <View style={styles.buttons}>
                {decide ? <Button size="sm" label={t('mobile.flow.run.decide', 'Decide')} onPress={decide} testID="run-decide" /> : null}
                {runs.stop ? <Button size="sm" variant="ghost" label={pause.stopLabel} onPress={runs.stop} testID="run-stop" /> : null}
                {model.stepId ? <Button size="sm" variant="ghost" label={t('mobile.flow.run.show', 'Show')} onPress={() => onOpenStep(model.stepId as string)} /> : null}
                <Button size="sm" variant="ghost" label={t('mobile.flow.run.details', 'Details')} onPress={onDetails} testID="run-details" />
            </View>
        </View>
    );
}

export function RunBanner({ runs, onOpenStep, onDetails }: RunBannerProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const now = useTicking(runs.running);
    const [dismissed, setDismissed] = useState<string | null>(null);
    const model = runBannerModel(runs.state, runs.focus, { running: runs.running, t, now, run: runs.pausedRun });
    if (!model || (!model.live && dismissed === runs.state.startedAt)) return null;
    const close = (
        <IconButton
            icon={<Icon name="X" size={16} color={styles.glyph.color} />}
            accessibilityLabel={t('common.close', 'Close')}
            onPress={() => setDismissed(runs.state.startedAt)}
        />
    );
    if (model.pause) {
        return (
            <View style={styles.wrap} testID="run-banner">
                <Banner tone={model.tone} action={close}>
                    <PausedBody model={model} runs={runs} onOpenStep={onOpenStep} onDetails={onDetails} />
                </Banner>
            </View>
        );
    }
    const stop = runs.stop;
    const action = model.live ? (
        stop ? <Button size="sm" variant="ghost" label={t('mobile.flow.run.stop', 'Stop')} onPress={stop} testID="run-stop" /> : null
    ) : (
        <View style={styles.actions}>
            {model.stepId ? <Button size="sm" variant="ghost" label={t('mobile.flow.run.show', 'Show')} onPress={() => onOpenStep(model.stepId as string)} /> : null}
            <Button size="sm" variant="ghost" label={t('mobile.flow.run.details', 'Details')} onPress={onDetails} testID="run-details" />
            {close}
        </View>
    );
    return (
        <View style={styles.wrap} testID="run-banner">
            <Banner tone={model.tone} icon={model.live ? 'FlaskConical' : undefined} action={action}>
                <Text variant="caption" numberOfLines={2}>
                    {model.text}
                </Text>
            </Banner>
        </View>
    );
}
