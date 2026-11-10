// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { runIdentityOf } from './runIdentity';

describe('runIdentityOf', () => {
    it('reads the start stub of a test (no mode yet) as a test run', () => {
        expect(runIdentityOf({ id: 'r1', startedAt: 1760522580000 }, null).kind).toBe('test');
    });
    it('reads a dry_run or isTest row as a test run', () => {
        expect(runIdentityOf({ id: 'r1', mode: 'dry_run' }, null).kind).toBe('test');
        expect(runIdentityOf({ id: 'r1', mode: 'live', isTest: true }, null).kind).toBe('test');
    });
    it('does not call a hydrated live or scheduled run a test', () => {
        const identity = runIdentityOf({ id: 'r2', mode: 'live', startedAt: '2026-10-15T10:03:00.000Z' }, null);
        expect(identity.kind).toBe('run');
        expect(identity.startedAt).toBe('2026-10-15T10:03:00.000Z');
    });
    it('reads the run profile first: a production run is not a test, whatever its mode', () => {
        expect(runIdentityOf({ id: 'r3', profile: { kind: 'production' }, mode: 'live' }, null).kind).toBe('run');
        expect(runIdentityOf({ id: 'r4', profile: { kind: 'test' }, mode: 'live' }, null).kind).toBe('test');
    });
    it('carries what GET /runs/:id says about a wait, and the canvas actions', () => {
        const onStop = () => {};
        const identity = runIdentityOf({
            id: 'r5', mode: 'dry_run', status: 'awaiting_approval', versionBehind: true, canDecide: false,
            waitingOn: { stageName: 'Finance', seatCount: 2 },
        }, null, { onStop });
        expect(identity.pause).toMatchObject({
            isTest: true, isDry: true, versionBehind: true, canDecide: false,
            waitingOn: { stageName: 'Finance', seatCount: 2 }, onStop,
        });
    });
    it('knows nothing it was not told', () => {
        expect(runIdentityOf({ id: 'r6', mode: 'live' }, null).pause).toMatchObject({ canDecide: null, waitingOn: null, versionBehind: false });
    });
    it('says when the run is a dry run that has finished, and only then', () => {
        expect(runIdentityOf({ id: 'r7', mode: 'dry_run', status: 'success' }, null).dryFinished).toBe(true);
        expect(runIdentityOf({ id: 'r7', profile: { kind: 'dry' }, status: 'success' }, null).dryFinished).toBe(true);
        expect(runIdentityOf({ id: 'r7', mode: 'dry_run', status: 'running' }, null).dryFinished).toBe(false);
        expect(runIdentityOf({ id: 'r7', mode: 'dry_run', status: 'error' }, null).dryFinished).toBe(false);
        // A live test really sent what it sent.
        expect(runIdentityOf({ id: 'r8', mode: 'live', isTest: true, status: 'success' }, null).dryFinished).toBe(false);
        // The start stub has no status yet.
        expect(runIdentityOf({ id: 'r9' }, null).dryFinished).toBe(false);
    });
});
