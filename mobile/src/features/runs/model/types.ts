/**
 * The run log's shapes, taken from the server's own serialisers:
 *   LogRun     stores/automationStore/runs.js rowToRunWithAutomation (my runs,
 *              GET /api/automation/_runs/recent) and rowToOrgRunRow (the
 *              organisation, GET /api/automation/_runs/org) — the org row is an
 *              allow-list of the same fields plus `mine`;
 *   RunFacets  getRunFacetsScoped, the chips' counts and the per-routine rollup.
 */

/** Whose runs: always opens on 'mine' (see model/filters.ts). */
export type RunScope = 'mine' | 'org';

export interface LogRun {
    id: string;
    /** The leg a journey (a run continued after a form or an approval) is on now. */
    journeyRunId: string | null;
    automationId: string;
    automationTitle: string | null;
    automationKind: string;
    triggerKind: string | null;
    rootStepId: string | null;
    rootTriggerLabel: string | null;
    mode: string | null;
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
    summary: string | null;
    error: string | null;
    errorClass: string | null;
    handledErrorCount: number;
    /**
     * The org scope's ownership stamp. Absent (undefined) on "my runs", where
     * every row is the viewer's; in the org scope only `true` opens a run.
     */
    mine?: boolean;
}

export interface RunPage {
    runs: LogRun[];
    nextCursor: string | null;
}

/** One routine's activity in the facets window. */
export interface RunRollup {
    automationId: string;
    title: string | null;
    kind: string;
    total: number;
    status: Record<string, number>;
    lastRunAt: string | null;
    lastErrorAt: string | null;
    lastErrorClass: string | null;
}

export interface RunFacets {
    status: Record<string, number>;
    triggerKind: Record<string, number>;
    automationId: Record<string, number>;
    errorClass: Record<string, number>;
    /** Null when this server sends no rollup — which is not "nothing ran". */
    automations: RunRollup[] | null;
    automationsTotal: number | null;
}
