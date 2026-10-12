/**
 * The button, its run, and its result. Kept as one component because they are
 * one thing to the person pressing it: the result has to appear where the
 * button was, not in a separate panel they have to go and find.
 *
 * The run follows the bridge's contract (server/routes/studioAppsRun.js):
 *   200 { runId, status, output }        — finished inside the 60s wait
 *   202 { runId, status: 'pending' }     — still going; poll GET .../runs/:runId
 *   200 { status: 'skipped', message }   — the automation was already running
 *
 * After a 202 the poll's answer is what shows (model/actionRun.ts): the button
 * spins until the poll says the run stopped, and a poll that fails says so.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, Text } from '@/shared/ui';

import { ActionResult } from './ActionResult';
import { useRunAppAction } from '../hooks/mutations';
import { useAppActionRun } from '../hooks/queries';
import { pollRunId, runView } from '../model/actionRun';
import type { RunnableAction } from '../model/appDefinition';
import type { AppActionResult, AppFormValues } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        disabled: { gap: theme.spacing.sm },
        root: { gap: theme.spacing.md },
    });

function NotRunnable({ action, label }: { action: RunnableAction; label: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.disabled}>
            <Button label={label} onPress={() => {}} disabled variant="secondary" fullWidth />
            <Text variant="caption" tone="tertiary">
                {action.action.kind === 'sequence'
                    ? t('mobile.apps.sequence_desktop_only', 'This button runs a multi-step sequence, which only the desktop app can drive.')
                    : t('mobile.apps.kind_not_runnable', 'This button does “{kind}”, which the phone cannot run yet.', { kind: action.action.kind })}
            </Text>
        </View>
    );
}

/** The poll failed: why, and a way to ask again. */
function PollFailed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
    const t = useTranslation();
    return (
        <Banner
            tone="error"
            action={<Button label={t('forms.public_check_again', 'Check again')} variant="ghost" size="sm" onPress={onRetry} testID="app-action-poll-retry" />}
        >
            {t('mobile.apps.poll_failed', 'Could not check on the run: {reason}', { reason: describeError(error).message })}
        </Banner>
    );
}

export function ActionRunner({
    appId,
    draft = false,
    action,
    label,
    blockedReason,
    onBlocked,
    collect,
}: {
    appId: string;
    /** The app on screen is the owner's draft: its runs go to the draft too. */
    draft?: boolean;
    action: RunnableAction;
    label: string;
    blockedReason?: string | null;
    onBlocked?: () => void;
    collect: () => AppFormValues;
}) {
    const styles = useThemedStyles(makeStyles);
    const [result, setResult] = useState<AppActionResult | null>(null);
    const mutation = useRunAppAction({ appId, actionId: action.actionId, draft }, collect, setResult);
    const poll = useAppActionRun(appId, pollRunId(result));
    const { shown, going } = runView(result, { data: poll.data, failed: poll.isError });
    const running = mutation.isPending || going;

    if (!action.runnable) return <NotRunnable action={action} label={label} />;

    return (
        <View style={styles.root}>
            <Button
                label={label}
                fullWidth
                size="lg"
                loading={running}
                onPress={() => {
                    if (blockedReason) {
                        onBlocked?.();
                        return;
                    }
                    setResult(null);
                    mutation.mutate();
                }}
                accessibilityHint={blockedReason ?? undefined}
            />

            {blockedReason ? (
                <Text variant="caption" tone="warning" accessibilityLiveRegion="polite">
                    {blockedReason}
                </Text>
            ) : null}

            {mutation.isError ? <Banner tone="error">{describeError(mutation.error).message}</Banner> : null}

            {poll.isError ? <PollFailed error={poll.error} onRetry={() => void poll.refetch()} /> : null}

            {shown ? <ActionResult result={shown} polling={going} /> : null}
        </View>
    );
}
