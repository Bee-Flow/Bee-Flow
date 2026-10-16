import type { RunIdentity } from '../flow/useFailedRunBanner';

/** The part of the builder's run row the banner reads (`state.dryRun`). */
export interface IdentifiableRun {
    id?: string;
    mode?: string;
    isTest?: boolean;
    startedAt?: string | number | null;
}

/**
 * Which run the canvas banner is about. `state.dryRun` holds the latest run of
 * ANY kind (hydrateLastRun loads whatever ran last, a scheduled run included),
 * so the kind comes from the row, the way ExecutionRow reads it: a dry run or
 * an `isTest` row is a test run. The stub written when a test starts carries
 * no mode yet and is, by construction, a test.
 */
export function runIdentityOf(run: IdentifiableRun | null | undefined, onOpen: ((runId: string) => void) | null): RunIdentity {
    const moded = run?.mode != null || run?.isTest != null;
    const isTest = !moded || run?.mode === 'dry_run' || !!run?.isTest;
    const startedAt = run?.startedAt == null ? null : new Date(run.startedAt).toISOString();
    return { kind: isTest ? 'test' : 'run', id: run?.id || null, startedAt, onOpen };
}
