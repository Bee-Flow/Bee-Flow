/**
 * The line over the outline and the canvas about the last test run (the
 * words: runBanner.ts). While it goes, its clock ticks and — once the run
 * feed has named the run — Stop cancels it; afterwards, Show opens the step
 * it names and Details opens the result sheet. Dismissing hides the line;
 * the cards keep their colours until the next run, or Clear.
 */

import React, { useEffect, useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Icon, IconButton, Text } from '@/shared/ui';

import { runBannerModel } from './runBanner';
import type { TestRuns } from './useTestRuns';

const makeStyles = (theme: Theme) => ({
    wrap: { paddingHorizontal: theme.spacing[4], paddingTop: theme.spacing[2] } satisfies ViewStyle,
    actions: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1] } satisfies ViewStyle,
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

export function RunBanner({ runs, onOpenStep, onDetails }: RunBannerProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const now = useTicking(runs.running);
    const [dismissed, setDismissed] = useState<string | null>(null);
    const model = runBannerModel(runs.state, runs.focus, { running: runs.running, t, now });
    if (!model || (!model.live && dismissed === runs.state.startedAt)) return null;
    const stop = runs.stop;
    const action = model.live ? (
        stop ? <Button size="sm" variant="ghost" label={t('mobile.flow.run.stop', 'Stop')} onPress={stop} testID="run-stop" /> : null
    ) : (
        <View style={styles.actions}>
            {model.stepId ? <Button size="sm" variant="ghost" label={t('mobile.flow.run.show', 'Show')} onPress={() => onOpenStep(model.stepId as string)} /> : null}
            <Button size="sm" variant="ghost" label={t('mobile.flow.run.details', 'Details')} onPress={onDetails} testID="run-details" />
            <IconButton
                icon={<Icon name="X" size={16} color={styles.glyph.color} />}
                accessibilityLabel={t('common.close', 'Close')}
                onPress={() => setDismissed(runs.state.startedAt)}
            />
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
