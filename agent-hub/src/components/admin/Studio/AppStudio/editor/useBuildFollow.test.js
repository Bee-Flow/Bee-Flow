import { describe, expect, it } from 'vitest';
import { scheduleFollowMoves } from './useBuildFollow';

describe('scheduleFollowMoves', () => {
    it('one move per card shortly after it lands, never two closer than the minimum gap', () => {
        const plan = { ids: ['a', 'b', 'c', 'd'], delays: new Map([['a', 0], ['b', 500], ['c', 1000], ['d', 2400]]) };
        // a@200, b@700 and c@1200 all sit inside the 1.2 s gap after a — one move; d@2600 clears it.
        expect(scheduleFollowMoves(plan)).toEqual([{ id: 'a', at: 200 }, { id: 'd', at: 2600 }]);
        // With the 1.2 s cadence every card gets its own move.
        const cadence = { ids: ['a', 'b', 'c'], delays: new Map([['a', 0], ['b', 1200], ['c', 2400]]) };
        expect(scheduleFollowMoves(cadence)).toEqual([{ id: 'a', at: 200 }, { id: 'b', at: 1400 }, { id: 'c', at: 2600 }]);
    });
    it('the first card always moves; an empty plan moves nothing', () => {
        expect(scheduleFollowMoves({ ids: ['a'], delays: new Map() })).toEqual([{ id: 'a', at: 200 }]);
        expect(scheduleFollowMoves(null)).toEqual([]);
    });
});
