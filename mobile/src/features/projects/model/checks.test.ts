/**
 * The checks and the publish gate. The gate opens only on an answer that
 * SAID `blocked: false`; findings are split where their meaning changes; the
 * worst finding per entity is an error over a warning; and the version chip
 * appears only for one publisher's series.
 */

import { blueprintVersionFor, controlBadge, isBlocking, publishAllowed, splitFindings, worstByEntity } from './checks';
import type { BlueprintMeta } from './package';
import type { Completeness, Finding } from './solution';

function finding(over: Partial<Finding>): Finding {
    return {
        code: 'x',
        severity: 'warning',
        message: 'Something',
        remediation: null,
        blockedAt: null,
        deepLink: null,
        targetRef: null,
        from: null,
        targetId: null,
        ...over,
    };
}

const checks = (over: Partial<Completeness>): Completeness => ({ blocked: false, complete: true, findings: [], unavailable: [], ...over });

describe('the publish gate', () => {
    it('opens only on an answer that said it was not blocked', () => {
        expect(publishAllowed(checks({}))).toBe(true);
        expect(publishAllowed(checks({ blocked: true }))).toBe(false);
        expect(publishAllowed(null)).toBe(false);
        expect(publishAllowed(undefined)).toBe(false);
    });

    it('blocks on an error, or on a warning tagged as blocking publishing', () => {
        expect(isBlocking(finding({ severity: 'error' }))).toBe(true);
        expect(isBlocking(finding({ blockedAt: 'publish' }))).toBe(true);
        expect(isBlocking(finding({ blockedAt: 'activate' }))).toBe(false);
        const { blocking, advice } = splitFindings([finding({ severity: 'error' }), finding({}), finding({ blockedAt: 'publish' })]);
        expect([blocking.length, advice.length]).toEqual([2, 1]);
    });
});

describe('worstByEntity', () => {
    it('keeps the worst finding per entity, under the palette spelling of a knowledge base', () => {
        const map = worstByEntity([
            finding({ targetRef: { kind: 'app', id: 'a1' } }),
            finding({ severity: 'error', message: 'broken', targetRef: { kind: 'app', id: 'a1' } }),
            finding({ targetRef: { kind: 'app', id: 'a1' }, message: 'later warning' }),
            finding({ targetRef: { kind: 'knowledge_base', id: 'k1' } }),
            finding({ targetRef: { kind: 'app', id: null } }),
            finding({}),
        ]);
        expect(map.get('app:a1')?.message).toBe('broken');
        expect(map.has('kb:k1')).toBe(true);
        expect(map.size).toBe(2);
        expect(worstByEntity(undefined).size).toBe(0);
    });
});

describe('controlBadge', () => {
    it('counts findings, errors first, and shows nothing for none or for no answer', () => {
        expect(controlBadge(checks({ findings: [finding({}), finding({ severity: 'error' })] }))).toEqual({ count: 2, tone: 'error' });
        expect(controlBadge(checks({ findings: [finding({})] }))).toEqual({ count: 1, tone: 'warning' });
        expect(controlBadge(checks({}))).toEqual({ count: null, tone: null });
        expect(controlBadge(null)).toEqual({ count: null, tone: null });
    });
});

describe('blueprintVersionFor', () => {
    const bp = (over: Partial<BlueprintMeta>): BlueprintMeta => ({
        id: 'b',
        name: 'n',
        description: '',
        icon: null,
        version: 1,
        solutionKey: 'sol_p1',
        createdBy: 'u1',
        sourceProjectId: 'p1',
        updatedAt: null,
        ...over,
    });

    it('is the highest version of one publisher’s series, else nothing', () => {
        expect(blueprintVersionFor([bp({ version: 2 }), bp({ id: 'c', version: 4 })], 'p1')).toBe(4);
        expect(blueprintVersionFor([bp({}), bp({ createdBy: 'u2' })], 'p1')).toBeNull();
        expect(blueprintVersionFor([bp({ solutionKey: 'sol_other' })], 'p1')).toBeNull();
        expect(blueprintVersionFor(null, 'p1')).toBeNull();
    });
});
