import { describe, expect, it } from 'vitest';
import { newStageKey, sanitizeApprovalStages } from './approvalStages';

describe('approval stages — the persisted shape', () => {
    it('drops a stage nobody sits in rather than 400 the whole automation', () => {
        expect(sanitizeApprovalStages([
            { key: 's1', name: 'Team lead', approvers: [{ userId: 'u1' }], rule: 'all' },
            { key: 's2', name: 'Nobody', approvers: [null, {}], rule: 'all' },
        ]).map(s => s.key)).toEqual(['s1']);
    });

    it('honours an author key verbatim, and only replaces a collision', () => {
        const out = sanitizeApprovalStages([
            { key: 'panel', approvers: [{ userId: 'u1' }] },
            { key: 'panel', approvers: [{ userId: 'u2' }] },
        ]);
        expect(out[0].key).toBe('panel');
        expect(out[1].key).not.toBe('panel');
    });

    it('caps a stage at 10 seats and the chain at 30', () => {
        const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ userId: `${prefix}${i}` }));
        expect(sanitizeApprovalStages([{ approvers: many(14, 'a') }])[0].approvers).toHaveLength(10);
        const full = sanitizeApprovalStages([
            { approvers: many(10, 'a') }, { approvers: many(10, 'b') },
            { approvers: many(10, 'c') }, { approvers: many(10, 'd') },
        ]);
        expect(full).toHaveLength(3);
        expect(full.reduce((n, s) => n + s.approvers.length, 0)).toBe(30);
    });

    it('trims the name and description to the lengths the server stores', () => {
        const [stage] = sanitizeApprovalStages([{
            approvers: [{ userId: 'u1' }], name: 'x'.repeat(90), description: 'y'.repeat(300),
        }]);
        expect(stage.name).toHaveLength(60);
        expect(stage.description).toHaveLength(200);
    });

    it('keeps a quorum inside its own stage, never the chain', () => {
        const [stage] = sanitizeApprovalStages([{
            approvers: [{ userId: 'u1' }, { userId: 'u2' }], rule: 'quorum', quorum: 9,
        }]);
        expect(stage.quorum).toBe(2);
    });

    it('mints the lowest unused key so an insert never steals a running stage\'s', () => {
        expect(newStageKey([])).toBe('s1');
        expect(newStageKey([{ key: 's1' }, { key: 's3' }])).toBe('s2');
        expect(newStageKey([{ key: 'panel' }, { key: 'final' }])).toBe('s1');
    });
});
