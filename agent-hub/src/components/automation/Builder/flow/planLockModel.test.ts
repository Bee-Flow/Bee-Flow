import { describe, it, expect } from 'vitest';
import {
    APPROVALS, NO_LOCKS, PRIVACY_STEPS,
    capabilityForKind, planLockReason, planLocksFrom, withPlanLocks,
} from './planLockModel';

/**
 * The plan's step locks, as the builder reads them (server/automation/
 * licensedSteps.js is the real gate; this only says it first).
 */

// The dictionary fallback, returned as is, so the tests read the English.
const t = (_key: string, fallback?: unknown) => String(fallback ?? '');

describe('which steps a plan can lock', () => {
    it('guard and tokenize need the privacy steps, approval needs approvals', () => {
        expect(capabilityForKind('guard')).toBe(PRIVACY_STEPS);
        expect(capabilityForKind('tokenize')).toBe(PRIVACY_STEPS);
        expect(capabilityForKind('approval')).toBe(APPROVALS);
    });

    it('"Show real values again" is never locked, nor is anything else', () => {
        for (const kind of ['untokenize', 'ai_step', 'condition', 'constructor', 'toString', null, 42]) {
            expect(capabilityForKind(kind)).toBeNull();
        }
    });
});

describe('planLocksFrom: only a real answer locks', () => {
    const answer = (map: Record<string, string | null>) => ({
        loading: false, error: null, lockReason: (id: string) => (id in map ? map[id] : null),
    });

    it('nothing is locked while the entitlements load, failed, or said nothing', () => {
        expect(planLocksFrom(null, t)).toBe(NO_LOCKS);
        expect(planLocksFrom({ ...answer({ [PRIVACY_STEPS]: 'ceiling' }), loading: true }, t)).toBe(NO_LOCKS);
        expect(planLocksFrom({ ...answer({ [PRIVACY_STEPS]: 'ceiling' }), error: 'HTTP 500' }, t)).toBe(NO_LOCKS);
        expect(planLocksFrom({ loading: false }, t)).toBe(NO_LOCKS);
    });

    it('a capability outside the plan reads as an upgrade, one not granted as an admin\'s switch', () => {
        const locks = planLocksFrom(answer({ [PRIVACY_STEPS]: 'ceiling', [APPROVALS]: 'not_granted' }), t);
        expect(locks[PRIVACY_STEPS]).toMatch(/part of the Enterprise plan/);
        expect(locks[PRIVACY_STEPS]).toMatch(/already live keep running/);
        expect(locks[APPROVALS]).toMatch(/Ask an administrator/);
    });

    it('a granted capability is not in the list', () => {
        const locks = planLocksFrom(answer({ [APPROVALS]: 'ceiling' }), t);
        expect(Object.keys(locks)).toEqual([APPROVALS]);
    });
});

describe('the locks ride on the catalog', () => {
    it('a catalog that has not loaded stays null', () => {
        expect(withPlanLocks(null, { [PRIVACY_STEPS]: 'x' })).toBeNull();
    });

    it('nothing to add answers the very same catalog', () => {
        const catalog = { apps: [] };
        expect(withPlanLocks(catalog, NO_LOCKS)).toBe(catalog);
    });

    it('locks are laid on a copy, and a lifted lock is taken off again', () => {
        const catalog = { apps: [] };
        const locked = withPlanLocks(catalog, { [PRIVACY_STEPS]: 'Enterprise only' });
        expect(locked).not.toBe(catalog);
        expect(planLockReason('guard', locked)).toBe('Enterprise only');
        expect(planLockReason('untokenize', locked)).toBeNull();
        expect(planLockReason('approval', locked)).toBeNull();
        expect(withPlanLocks(locked, NO_LOCKS)?.planLocks).toEqual({});
    });
});
