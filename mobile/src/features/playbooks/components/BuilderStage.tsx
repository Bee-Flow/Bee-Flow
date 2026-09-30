/**
 * A builder phase (the automation, the app, a further app turn). On the web
 * the builder itself is the stage: its chat streams a model turn in the
 * browser tab while the person watches, and hears the end of every turn to
 * land the phase. The phone has no such stage — its routine builder takes no
 * brief and reports nothing back to a playbook — so it does not start one (a
 * phase nobody drives would sit `running` for ever) and says plainly that this
 * phase is built on a computer. It does not offer the web page: on a phone the
 * web sends Studio back to the chat, after a sign-in the in-app browser does
 * not share with this app.
 *
 * What already exists opens here, a ready phase can be skipped here, and every
 * decision around a running one (skip, mark as done, stop) stays on the
 * handoff card below.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { Button, Text } from '@/shared/ui';

import { StageCard } from './StageCard';
import { artStr } from '../model/artifacts';
import { canSkip, kindOf, type PlaybookEvent } from '../model/phaseMachine';
import { phaseFact, phaseKind, phaseLabel } from '../model/playbookView';
import type { Phase, Playbook } from '../model/types';

function statusFor(phase: Phase, t: ReturnType<typeof useTranslation>): string {
    if (phase.status === 'failed') return t('mobile.playbooks.builder.failed', 'This build did not land.');
    if (phase.status === 'running') return t('mobile.playbooks.builder.running_computer', 'The AI builder is working on this phase on a computer. When what it made is enough, mark the phase done below.');
    if (phase.status === 'awaiting' || phase.status === 'done') return phase.summary ?? t('playbooks.state.done', 'Done');
    return t('mobile.playbooks.builder.ready_computer', 'The AI builder builds this phase on a computer, where you watch it work: open this playbook in Studio there to start it. You can also skip it and go on without it.');
}

interface Props {
    phase: Phase;
    dispatch: (event: PlaybookEvent) => Promise<Playbook | null>;
}

export function BuilderStage({ phase, dispatch }: Props) {
    const t = useTranslation();
    const router = useRouter();
    const [skipping, setSkipping] = useState(false);
    const automationId = artStr(phase.artifacts, 'automationId');
    const appId = artStr(phase.artifacts, 'appId');
    const fact = phaseFact(phase, t);
    const isApp = kindOf(phase) !== 'routine';
    const skip = () => {
        setSkipping(true);
        void dispatch({ type: 'skip', key: phase.key }).finally(() => setSkipping(false));
    };
    return (
        <StageCard
            kind={phaseKind(phase)}
            title={phaseLabel(phase, t)}
            status={statusFor(phase, t)}
            tone={phase.status === 'failed' ? 'error' : 'quiet'}
            testID="playbook-stage-builder"
        >
            {fact ? (
                <Text variant="caption" tone="secondary">
                    {fact}
                </Text>
            ) : null}
            {!isApp && automationId ? (
                <Button variant="secondary" size="sm" label={t('playbooks.done.open', 'Open')} iconName="Workflow" onPress={() => router.push(`/automations/${encodeURIComponent(automationId)}`)} />
            ) : null}
            {isApp && appId ? (
                <Button variant="secondary" size="sm" label={t('playbooks.done.open', 'Open')} iconName="AppWindow" onPress={() => router.push(`/apps/${encodeURIComponent(appId)}`)} />
            ) : null}
            {phase.status === 'ready' && canSkip(phase) ? (
                <Button variant="secondary" label={t('playbooks.handoff.skip', 'Skip this phase')} loading={skipping} disabled={skipping} onPress={skip} testID="playbook-builder-skip" />
            ) : null}
        </StageCard>
    );
}
