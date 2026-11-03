import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { awaitingFormStepId, recordDismissal, shouldAutoOpenFormOverlay } from './formOverlayAutoOpen';
import type { FormRunCloseInfo, FormTestSession } from '../formRunContract';

/**
 * The form overlay's opening and closing in the builder shell (useBuilderRuns).
 *
 * A run started here that parks on a `form_page` opens the overlay attached to
 * it. Closing remembers `${runId}:${stepId}` so the same page does not pop up
 * again straight away, and `${runId}:*` for every run the overlay closed on
 * while it still went (RUN-11). The decision itself is formOverlayAutoOpen.ts.
 */
interface AutoOpenOptions {
    /** The rows of the run on the canvas. */
    steps: ReadonlyArray<{ stepId?: string; status?: string } | null | undefined> | null | undefined;
    /** The run on the canvas. */
    runId: string | null | undefined;
    /** A run was started from this builder session. */
    startedHereRef: RefObject<boolean>;
    formTest: FormTestSession | null;
    setFormTest: Dispatch<SetStateAction<FormTestSession | null>>;
}

export default function useFormOverlayAutoOpen({ steps, runId, startedHereRef, formTest, setFormTest }: AutoOpenOptions) {
    const dismissedRef = useRef(new Set<string>());
    const awaitingStepNow = awaitingFormStepId(steps);
    const currentRunId = runId || null;
    useEffect(() => {
        if (shouldAutoOpenFormOverlay({
            liveFromBuilder: !!startedHereRef.current,
            runId: currentRunId,
            awaitingStepId: awaitingStepNow,
            overlayOpen: !!formTest,
            dismissed: dismissedRef.current,
        })) setFormTest({ runId: currentRunId });
    }, [currentRunId, awaitingStepNow, formTest, startedHereRef, setFormTest]);
    return {
        closeFormTest: (info?: FormRunCloseInfo) => {
            recordDismissal(dismissedRef.current, { runId: currentRunId, stepId: awaitingStepNow, runIds: info?.dismissRunIds });
            setFormTest(null);
        },
        openFormOverlay: (id: string | null | undefined) => { if (id) setFormTest({ runId: id }); },
    };
}
