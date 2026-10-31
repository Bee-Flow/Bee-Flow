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
});
