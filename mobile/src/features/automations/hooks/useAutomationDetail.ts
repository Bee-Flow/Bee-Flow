/**
 * Everything an automation's detail screen watches: the routine, its latest
 * runs, whether one is running now, and the three things you can do from
 * here — run it, stop it, switch it on or off.
 *
 * The live feed is scoped to this automation, so a colleague's busy account
 * does not wake this screen up thirty times a minute.
 */

import { useCallback, useMemo, useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useToast } from '@/shared/ui';

import {
    useAutomationRefresh,
    useCancelRun,
    useRunAutomation,
    useSetAutomationActive,
    useSettledRunRefresh,
} from './mutations';
import { useActiveRuns, useAutomation, useLatestRuns } from './queries';
import { useRunStream } from './useRunStream';
import { statusLabel, statusToken } from '../model/status';
import type { RunEvent, RunTriggerResult } from '../model/types';

export function useAutomationDetail(id: string) {
    const t = useTranslation();
    const { toast } = useToast();
    /** The "nothing to test against" answer, which is information, not an error. */
    const [runNote, setRunNote] = useState<string | null>(null);

    const detail = useAutomation(id);
    const runs = useLatestRuns(id);
    const active = useActiveRuns({ busyMs: 5_000, idleMs: 30_000 });
    const liveRun = useMemo(
        () => (active.data ?? []).find((run) => run.automationId === id) ?? null,
        [active.data, id],
    );

    const refresh = useAutomationRefresh(id);
    // A run that ends also changes this routine's row in the list behind.
    const refreshList = useSettledRunRefresh();
    const stream = useRunStream({
        automationId: id,
        enabled: Boolean(id),
        onEvent: useCallback(
            (event: RunEvent) => {
                if (event.type.startsWith('run.')) refresh();
                refreshList(event);
            },
            [refresh, refreshList],
        ),
    });

    const onRunResult = (result: RunTriggerResult | null) => {
        setRunNote(null);
        if (!result) return;
        if (result.skipped) {
            setRunNote(result.message ?? 'There was nothing to test this trigger against.');
            return;
        }
        if (result.pending) {
            toast('Still running — follow it below');
            return;
        }
        const token = statusToken(result.run?.status);
        toast(statusLabel(t, token), token.tone === 'error' ? 'error' : 'success');
    };
    const run = useRunAutomation(id, { onSuccess: onRunResult });

    const setActive = useSetAutomationActive(id, {
        onSuccess: (updated) => toast(updated?.isActive ? 'Automation is on' : 'Automation paused', 'success'),
    });

    const stop = useCancelRun(refresh, {
        onSuccess: () => toast('Stop requested — it ends after the current step'),
        onError: (err) => toast(describeError(err).message, 'error'),
    });

    return { detail, runs, liveRun, stream, refresh, run, runNote, setActive, stop };
}
