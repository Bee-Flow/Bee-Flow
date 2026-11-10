import { useCallback, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { computeRunFocus } from './runFocus';
import type { FocusDefinition, RunFocus } from './runFocus';
import type { RunRow } from './diagramPaneTypes';
import type { RunPause } from './runPause';

/** Which run the banner talks about, as the host knows it (the run row, not the merged step rows). */
export interface RunIdentity {
    /** 'test' for a dry run; 'run' for any other run; null when the host does not know. */
    kind: 'test' | 'run' | null;
    id: string | null;
    startedAt: string | null;
    /** A dry run that has finished: the canvas says that nothing was sent or written. */
    dryFinished?: boolean;
    /** Open this run in Runs. Absent where the host has no Runs to open. */
    onOpen?: ((runId: string) => void) | null;
    /** Whose run it is and what may be done while it waits (flow/runPause.ts). Absent where the host does not know. */
    pause?: RunPause | null;
}

interface BannerMark {
    key: string | null;
    sig: string;
    dismissed: boolean;
}

// Keys that say where a step is drawn, not what it does: dragging a node must
// not read as "the failing step was edited".
const LAYOUT_KEYS = new Set(['position', 'width', 'height']);

function stepSignature(definition: FocusDefinition | undefined, stepId: string | null): string {
    if (!stepId) return '';
    const all = [definition?.trigger, ...(definition?.steps || [])];
    const step = all.find(s => s?.id === stepId);
    return step ? JSON.stringify(step, (k, v: unknown) => (LAYOUT_KEYS.has(k) ? undefined : v)) : '';
}

interface Params {
    runSteps?: RunRow[];
    runInFlight?: boolean;
    definition?: FocusDefinition;
    runIdentity?: RunIdentity | null;
    /** Where focus goes when the banner is dismissed (the canvas wrapper). */
    focusRef?: RefObject<HTMLElement | null> | null;
}

/**
 * A "step failed" banner describes ONE run, so it must not outlive it: it goes
 * when the author dismisses it, when the failing step is edited (the failure
 * no longer describes what is on the canvas), and, because a newer run
 * replaces the rows, when a newer run succeeds or fails somewhere else. A
 * live run is never touched. The mark is set while rendering when the failure
 * changes identity (step + run), like the other marks in the south bar.
 */
export function useFailedRunBanner({ runSteps, runInFlight, definition, runIdentity = null, focusRef = null }: Params) {
    const focus = useMemo(
        () => computeRunFocus({ runSteps, runInFlight, definition, dryFinished: runIdentity?.dryFinished === true }),
        [runSteps, runInFlight, definition, runIdentity?.dryFinished],
    );
    const runKey = runIdentity?.id ?? runIdentity?.startedAt ?? focus?.startedAt ?? null;
    const banner = useBannerMark(focus, definition, runKey);
    const { dismiss } = banner;
    const dismissAndRestoreFocus = useCallback(() => {
        dismiss();
        const el = focusRef?.current;
        if (!el) return;
        if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
        el.focus({ preventScroll: true });
    }, [dismiss, focusRef]);
    return { runFocus: banner.runFocus, dismiss: dismissAndRestoreFocus };
}

export function useBannerMark(runFocus: RunFocus | null, definition: FocusDefinition | undefined, runKey: string | null = null) {
    const failed = runFocus?.state === 'error';
    // The dry-run notice is about one run as well, and goes when it is dismissed.
    const dryDone = runFocus?.state === 'dry_done';
    const stepId = failed ? runFocus.stepId : null;
    const key = failed ? `${stepId}|${runKey ?? runFocus.startedAt}` : (dryDone ? `dry|${runKey}` : null);
    const sig = useMemo(() => (failed ? stepSignature(definition, stepId) : ''), [failed, definition, stepId]);
    const [mark, setMark] = useState<BannerMark>({ key, sig, dismissed: false });
    if (mark.key !== key) setMark({ key, sig, dismissed: false });
    const hidden = (failed || dryDone) && (mark.key !== key || mark.dismissed || mark.sig !== sig);
    const dismiss = useCallback(() => setMark(m => ({ ...m, dismissed: true })), []);
    return { runFocus: hidden ? null : runFocus, dismiss };
}
