import { describe, expect, it } from 'vitest';
import { fromSeatEdit, seatFlavour, slotSeatFlavour, toSeatEdit } from './seatShapes';

describe('seat shapes', () => {
    it('recognises the flat app flavour and round-trips both', () => {
        const app = { assigneeUserId: 'u2', approverGroupIds: ['g1'], finalApproverUserId: 'u3' };
        expect(seatFlavour(app)).toBe('app');
        expect(seatFlavour({ assignee: { userId: 'u2' } })).toBe('automation');
        const edit = toSeatEdit(app);
        expect(edit.assignee).toEqual({ userId: 'u2' });
        expect(edit.approvers).toEqual([{ groupId: 'g1' }]);
        expect(fromSeatEdit(edit, 'app')).toEqual(app);
        const auto = { assignee: { userId: 'u2' }, approvers: [{ userId: 'u3' }, { groupId: 'g1' }], rule: 'quorum', quorumCount: 2 };
        expect(fromSeatEdit(toSeatEdit(auto), 'automation')).toEqual(auto);
    });
    it('drops seats nobody was picked for', () => {
        expect(fromSeatEdit({ assignee: null, approvers: [null, { userId: 'u3' }], escalateTo: {} }, 'automation')).toEqual({ approvers: [{ userId: 'u3' }] });
    });
});

describe('slotSeatFlavour', () => {
    const parts = [{ ref: 'app:1', kind: 'app' }, { ref: 'automation:1', kind: 'automation' }];
    it('follows the kind of the part that needs the slot, not the shape of the value', () => {
        expect(slotSeatFlavour(['app:1'], parts, { stages: [] })).toBe('app');
        expect(slotSeatFlavour(['automation:1'], parts, { assigneeUserId: 'u1' })).toBe('automation');
    });
    it('an app among the needing parts wins', () => {
        expect(slotSeatFlavour(['automation:1', 'app:1'], parts, null)).toBe('app');
    });
    it('falls back to the value when no needing part is known', () => {
        expect(slotSeatFlavour(['gone'], parts, { approverUserIds: ['u1'] })).toBe('app');
        expect(slotSeatFlavour([], parts, null)).toBe('automation');
    });
});
