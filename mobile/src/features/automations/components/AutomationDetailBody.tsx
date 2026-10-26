/**
 * The body of an automation's screen, in the order a person needs it: what
 * went wrong, what is waiting on them, what is running, then the controls.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Markdown } from '@/shared/markdown';
import { Banner, Button, Card, Icon, Section, Text } from '@/shared/ui';

import { AwaitingApprovalCard } from './AwaitingApprovalCard';
import { LastFailureCard } from './LastFailureCard';
import { LiveRunCard } from './LiveRunCard';
import { RecentRunsSection } from './RecentRunsSection';
import { SetupSection } from './SetupSection';
import type { useAutomationDetail } from '../hooks/useAutomationDetail';
import { mayStartRun, VIEW_ONLY_RUN_HINT } from '../model/runAccess';
import { statusToken } from '../model/status';
import { formatDuration, runElapsedMs } from '../model/time';
import type { Automation, AutomationRun } from '../model/types';

/** "Run now", or the reason a viewer cannot: the server decides who may start (canStart). */
function RunNowButton({ automation, liveRun, pending, onRun }: { automation: Automation; liveRun: boolean; pending: boolean; onRun: () => void }) {
    const theme = useTheme();
    const t = useTranslation();
    const canStart = mayStartRun(automation);
    const hint = t('automations.run.viewOnlyHint', VIEW_ONLY_RUN_HINT);
    return (
        <>
            <Button
                label={liveRun ? 'Already running' : 'Run now'}
                size="lg"
                fullWidth
                icon={<Icon name="Play" size={18} color={theme.colors.accentPrimaryFg} />}
                loading={pending}
                disabled={liveRun || !canStart}
                onPress={onRun}
                accessibilityHint={canStart ? 'Starts this automation immediately, outside its schedule' : hint}
            />
            {canStart ? null : (
                <Text variant="label" tone="tertiary">
                    {hint}
                </Text>
            )}
        </>
    );
}

/** The last run, when it failed with an error worth putting first. */
function failedRun(run: AutomationRun | null): AutomationRun | null {
    return run && statusToken(run.status).tone === 'error' && run.error ? run : null;
}

export function AutomationDetailBody({
    id,
    automation,
    state,
    onDecided,
    onEditSchedule,
}: {
    /** The route's id, which every link on this screen is built from. */
    id: string;
    automation: Automation;
    state: ReturnType<typeof useAutomationDetail>;
    onDecided: () => void;
    onEditSchedule: () => void;
}) {
    const { runs, liveRun, stream, run, runNote, setActive, stop } = state;
    const lastRun = runs.data?.[0] ?? null;
    const awaiting = lastRun?.status === 'awaiting_approval' ? lastRun : null;
    const failed = failedRun(lastRun);

    return (
        <>
            {failed ? <LastFailureCard run={failed} automationId={id} /> : null}

            {awaiting ? <AwaitingApprovalCard run={awaiting} onDecided={onDecided} /> : null}

            {liveRun ? (
                <LiveRunCard
                    run={liveRun}
                    stream={stream}
                    definition={automation.definition}
                    onStop={() => stop.mutate(liveRun.runId)}
                />
            ) : null}

            {runNote ? <Banner tone="info">{runNote}</Banner> : null}

            {run.isError ? <Banner tone="error">{describeError(run.error).message}</Banner> : null}

            <RunNowButton automation={automation} liveRun={Boolean(liveRun)} pending={run.isPending} onRun={() => run.mutate()} />

            <SetupSection
                automation={automation}
                activation={{
                    pending: setActive.isPending,
                    error: setActive.error,
                    onChange: (next) => setActive.mutate(next),
                }}
                onEditSchedule={onEditSchedule}
            />

            {automation.description ? (
                <Section title="About">
                    <Card>
                        <Markdown value={automation.description} streaming={false} />
                    </Card>
                </Section>
            ) : null}

            <RecentRunsSection automationId={id} runs={runs} />

            <Text variant="label" tone="tertiary">
                {lastRun
                    ? `Last run took ${formatDuration(runElapsedMs(lastRun))}.`
                    : 'No runs recorded yet.'}
            </Text>
        </>
    );
}
