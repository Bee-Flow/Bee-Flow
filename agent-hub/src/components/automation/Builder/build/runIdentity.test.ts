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
});
