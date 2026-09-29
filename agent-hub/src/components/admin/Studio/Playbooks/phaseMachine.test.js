// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyPhaseResult, canContinue, canRetry, canSkip, isComplete, nextActionable, nextPending, patchFor, progress } from './phaseMachine';

const mk = (statuses) => ['table', 'routine', 'fill', 'app', 'approvals'].map((key, i) => ({ key, status: statuses[i], artifacts: {} }));

describe('phaseMachine', () => {
    it('nextActionable is the first phase that is not done/skipped/locked; pending never counts', () => {
        expect(nextActionable(mk(['done', 'done', 'ready', 'pending', 'locked'])).key).toBe('fill');
        expect(nextActionable(mk(['done', 'awaiting', 'pending', 'pending', 'pending'])).key).toBe('routine');
        expect(nextActionable(mk(['done', 'skipped', 'done', 'done', 'locked']))).toBeNull();
        expect(nextActionable(null)).toBeNull();
    });

    it('nextPending skips terminal phases; canContinue needs an awaiting phase with a next that is ready/pending or nothing left', () => {
        const p = mk(['awaiting', 'pending', 'pending', 'pending', 'locked']);
        expect(nextPending(p, 'table').key).toBe('routine');
        expect(nextPending(mk(['done', 'done', 'done', 'awaiting', 'locked']), 'app')).toBeNull();
        expect(canContinue(p)).toBe(true);
        expect(canContinue(mk(['done', 'done', 'done', 'awaiting', 'locked']))).toBe(true);
        expect(canContinue(mk(['done', 'running', 'pending', 'pending', 'pending']))).toBe(false);
    });

    it('isComplete and progress count skipped as done and report locked separately', () => {
        expect(isComplete(mk(['done', 'skipped', 'done', 'done', 'locked']))).toBe(true);
        expect(isComplete(mk(['done', 'done', 'done', 'awaiting', 'locked']))).toBe(false);
        expect(progress(mk(['done', 'skipped', 'ready', 'pending', 'locked']))).toEqual({ done: 2, total: 5, locked: 1 });
    });

    it('canSkip never for the table; a RUNNING phase is skippable whatever runs it; canRetry only when failed', () => {
        expect(canSkip({ key: 'table', status: 'ready' })).toBe(false);
        expect(canSkip({ key: 'table', status: 'running' })).toBe(false);
        expect(canSkip({ key: 'routine', status: 'ready' })).toBe(true);
        expect(canSkip({ key: 'routine', status: 'running' })).toBe(true);
        // A server-run phase wedged on a model that never answered is the case
        // this exists for: Retry needs `failed` and `running → ready` is not a
        // transition, so Skip was the only way out — and it was not offered.
        // The server has always accepted `running → skipped`.
        expect(canSkip({ key: 'fill', status: 'running' })).toBe(true);
        expect(canSkip({ key: 'design', status: 'running' })).toBe(true);
        expect(canSkip({ key: 'compliance', status: 'running' })).toBe(true);
        expect(canSkip({ key: 'approvals', status: 'locked' })).toBe(true);
        expect(canSkip({ key: 'routine', status: 'done' })).toBe(false);
        expect(canRetry({ status: 'failed' })).toBe(true);
        expect(canRetry({ status: 'awaiting' })).toBe(false);
    });

    it('applyPhaseResult moves one phase optimistically and merges artifacts', () => {
        let p = mk(['done', 'ready', 'pending', 'pending', 'pending']);
        p = applyPhaseResult(p, 'routine', { kind: 'started' });
        expect(p[1].status).toBe('running');
        p = applyPhaseResult(p, 'routine', { kind: 'artifacts', artifacts: { automationId: 'a1' } });
        p = applyPhaseResult(p, 'routine', { kind: 'needs_input' });
        expect(p[1].needsInput).toBe(true);
        p = applyPhaseResult(p, 'routine', { kind: 'finished', summary: 'built', artifacts: { automationTitle: 'X' } });
        expect(p[1]).toMatchObject({ status: 'awaiting', summary: 'built', needsInput: false, artifacts: { automationId: 'a1', automationTitle: 'X' } });
        expect(applyPhaseResult(p, 'routine', { kind: 'failed', error: 'boom' })[1]).toMatchObject({ status: 'failed', error: 'boom' });
        expect(applyPhaseResult(p, 'routine', { kind: 'done' })[1].status).toBe('done');
        expect(applyPhaseResult(p, 'nope', { kind: 'done' })).toEqual(p);
    });

    it('patchFor: the exact wire body per event, including the two-entry Continue', () => {
        const pb = { id: 'pb1', version: 7 };
        expect(patchFor({ type: 'start', key: 'table' }, pb)).toEqual({ method: 'POST', route: 'phases/table/run' });
        expect(patchFor({ type: 'start', key: 'routine', artifacts: { builderSessionId: 'bs' } }, pb)).toEqual({ method: 'PATCH', body: { expectedVersion: 7, phases: [{ key: 'routine', status: 'running', artifacts: { builderSessionId: 'bs' } }] } });
        expect(patchFor({ type: 'artifact', key: 'routine', artifacts: { automationId: 'a1' } }, pb).body).toEqual({ expectedVersion: 7, phases: [{ key: 'routine', artifacts: { automationId: 'a1' } }] });
        expect(patchFor({ type: 'finished', key: 'routine', summary: 'ok', artifacts: { automationId: 'a1' } }, pb).body).toEqual({ expectedVersion: 7, phases: [{ key: 'routine', status: 'awaiting', summary: 'ok', artifacts: { automationId: 'a1' } }] });
        expect(patchFor({ type: 'failed', key: 'app', error: 'x' }, pb).body).toEqual({ expectedVersion: 7, phases: [{ key: 'app', status: 'failed', error: 'x' }] });
        expect(patchFor({ type: 'continue', key: 'table', nextKey: 'routine', brief: 'EDITED' }, pb).body).toEqual({ expectedVersion: 7, phases: [{ key: 'table', status: 'done' }, { key: 'routine', brief: 'EDITED' }] });
        expect(patchFor({ type: 'continue', key: 'approvals' }, pb).body).toEqual({ expectedVersion: 7, phases: [{ key: 'approvals', status: 'done' }] });
        expect(patchFor({ type: 'skip', key: 'routine' }, pb)).toEqual({ method: 'POST', route: 'phases/routine/skip', body: { expectedVersion: 7 } });
        expect(patchFor({ type: 'retry', key: 'fill' }, pb)).toEqual({ method: 'POST', route: 'phases/fill/retry', body: { expectedVersion: 7 } });
        expect(patchFor({ type: 'stop' }, pb).body).toEqual({ expectedVersion: 7, status: 'stopped' });
        expect(patchFor({ type: 'resume' }, pb).body).toEqual({ expectedVersion: 7, status: 'active' });
        // The design phase is server-run (one designer call): POST run, like table and fill.
        expect(patchFor({ type: 'start', key: 'ontwerp' }, { ...pb, phases: [{ key: 'ontwerp', kind: 'design', status: 'ready' }] })).toEqual({ method: 'POST', route: 'phases/ontwerp/run' });
        expect(patchFor({ type: 'needs_input', key: 'routine' }, pb)).toBeNull();
        expect(patchFor({ type: 'dismiss_input', key: 'routine' }, pb)).toBeNull();
        expect(patchFor(null, pb)).toBeNull();
    });
});
