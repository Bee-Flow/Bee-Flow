/**
 * One vocabulary for where a run is: the builder's toasts, the canvas banner,
 * the form overlay and the phone's run actions all branch on runPhase() and
 * never on a raw status string.
 *
 * The server writes these run statuses (core/automationRunner, stores/
 * automationStore/runs.js): queued, running, success, error, cancelled,
 * awaiting_form, awaiting_approval, and the legacy awaiting_confirm (a first
 * run held for confirmation), which reads as one more decision a person makes.
 * 'handled_error' is a STEP status: the step failed, an error branch took
 * over, and the run went on, so it reads as done. 'failed' is accepted as a
 * spelling of error.
 *
 * Whether a run was a test comes from its run profile when the row has one
 * (profile.kind production | test | dry). Rows from before run profiles carry
 * mode and isTest instead: mode 'dry_run' is a dry run, and a dry run is
 * always a test.
 *
 * Pure, with no imports: mobile/src/features/runs/mirror/runPhase.ts is a
 * byte-for-byte copy (scripts/shared-mirror.manifest.json, npm run gen:shared).
 */

export type RunPhaseName = 'running' | 'paused_form' | 'paused_approval' | 'done' | 'failed' | 'cancelled';

type RunProfileKind = 'production' | 'test' | 'dry';

/** The fields of a run row (web or phone) that decide its phase. */
export interface RunPhaseInput {
    status?: string | null;
    profile?: { kind?: RunProfileKind | string | null } | null;
    mode?: string | null;
    isTest?: boolean | null;
}

export interface RunPhase {
    phase: RunPhaseName;
    /** Not a production run: a test run or a dry run. */
    isTest: boolean;
    /** Effects were simulated. */
    isDry: boolean;
    /** Over for good: done, failed or cancelled. A pause is not terminal. */
    terminal: boolean;
}

export const RUN_PHASES: readonly RunPhaseName[] = [
    'running', 'paused_form', 'paused_approval', 'done', 'failed', 'cancelled',
];

// A Map, not an object: a status such as 'constructor' must not find a prototype member.
const BY_STATUS: ReadonlyMap<string, RunPhaseName> = new Map<string, RunPhaseName>([
    ['queued', 'running'],
    ['running', 'running'],
    ['awaiting_form', 'paused_form'],
    ['awaiting_approval', 'paused_approval'],
    ['awaiting_confirm', 'paused_approval'],
    ['success', 'done'],
    ['handled_error', 'done'],
    ['error', 'failed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled'],
]);

const TERMINAL: ReadonlySet<RunPhaseName> = new Set<RunPhaseName>(['done', 'failed', 'cancelled']);

/** A short name for each phase, as a key and its English. */
export const RUN_PHASE_LABELS: Readonly<Record<RunPhaseName, { labelKey: string; label: string }>> = {
    running: { labelKey: 'automation_testing.run_phase.running', label: 'Running' },
    paused_form: { labelKey: 'automation_testing.run_phase.paused_form', label: 'Waiting for a form' },
    paused_approval: { labelKey: 'automation_testing.run_phase.paused_approval', label: 'Waiting for a decision' },
    done: { labelKey: 'automation_testing.run_phase.done', label: 'Finished' },
    failed: { labelKey: 'automation_testing.run_phase.failed', label: 'Failed' },
    cancelled: { labelKey: 'automation_testing.run_phase.cancelled', label: 'Stopped' },
};

function testness(run: RunPhaseInput): { isTest: boolean; isDry: boolean } {
    const kind = run.profile?.kind;
    if (kind === 'dry') return { isTest: true, isDry: true };
    if (kind === 'test') return { isTest: true, isDry: false };
    if (kind === 'production') return { isTest: false, isDry: false };
    const isDry = run.mode === 'dry_run';
    return { isTest: isDry || run.isTest === true, isDry };
}

/**
 * Where a run is. An unknown or missing status reads as running: the run has
 * not told us it stopped, so nothing may claim it is over.
 */
export function runPhase(run: RunPhaseInput | null | undefined): RunPhase {
    const r: RunPhaseInput = run || {};
    const status = String(r.status ?? '').trim().toLowerCase();
    const phase = BY_STATUS.get(status) ?? 'running';
    return { phase, ...testness(r), terminal: TERMINAL.has(phase) };
}
