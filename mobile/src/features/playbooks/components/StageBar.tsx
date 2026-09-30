/**
 * Where the film is — the web's run bar line: "Phase 2 of 6: Automation ·
 * 1m 12s · Pauses after this phase", or Done / Stopped once it is over. The
 * clock ticks once a second while a phase runs, and only this line re-renders
 * for it.
 */

import React, { useEffect, useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { formatElapsed } from '@/shared/lib/elapsed';
import { Text } from '@/shared/ui';

import { phaseLabel } from '../model/playbookView';
import type { Phase, PlaybookStatus } from '../model/types';

function useNow(ticking: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!ticking) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, [ticking]);
    return now;
}

export function StageBar({
    status,
    complete,
    onStage,
    index,
    total,
}: {
    status: PlaybookStatus;
    complete: boolean;
    onStage: Phase | null;
    index: number;
    total: number;
}) {
    const t = useTranslation();
    const running = !complete && onStage?.status === 'running';
    const now = useNow(running);
    if (complete) {
        return (
            <Text variant="caption" tone="secondary">
                {status === 'stopped' ? t('playbooks.status.stopped', 'Stopped') : t('playbooks.state.done', 'Done')}
            </Text>
        );
    }
    const parts = [t('playbooks.bar.phase', 'Phase {n} of {total}: {phase}', { n: index + 1, total, phase: onStage ? phaseLabel(onStage, t) : '' })];
    const elapsed = running ? formatElapsed(onStage?.startedAt, now) : null;
    if (elapsed) parts.push(elapsed);
    if (running) parts.push(t('playbooks.bar.pauses', 'Pauses after this phase'));
    return (
        <Text variant="caption" tone="secondary" testID="playbook-bar-phase">
            {parts.join(' · ')}
        </Text>
    );
}
