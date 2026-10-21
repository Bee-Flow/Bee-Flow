import { useCallback, useState } from 'react';
import type { GoldenItem } from '../../../../api/queries/automation/runChecks';
import type { RunsSection } from './RunsTesting';

/** Two runs shown side by side, and the fields the golden's verdict leaves out. */
export interface CompareView {
    a: string;
    b: string;
    ignored: string[];
}

/**
 * What the Runs tab shows besides the list: the canvas of a run, the Testing
 * section, a comparison. Opening a run from anywhere closes the first and the last.
 */
export function useRunsViews(openRun: (runId: string) => void) {
    const [canvasRunId, setCanvasRunId] = useState<string | null>(null);
    const [section, setSection] = useState<RunsSection>('runs');
    const [compare, setCompare] = useState<CompareView | null>(null);

    const openFromList = useCallback((runId: string) => {
        setCanvasRunId(null);
        setCompare(null);
        openRun(runId);
    }, [openRun]);
    const compareGolden = useCallback((g: GoldenItem) => {
        if (g.lastReplay?.replayRunId) setCompare({ a: g.runId, b: g.lastReplay.replayRunId, ignored: g.ignorePaths });
    }, []);
    const compareRuns = useCallback((a: string, b: string) => setCompare({ a, b, ignored: [] }), []);
    const closeCompare = useCallback(() => setCompare(null), []);

    return { canvasRunId, setCanvasRunId, section, setSection, compare, openFromList, compareGolden, compareRuns, closeCompare };
}
