/** The drawer's chat groups: calendar days, pinned first, empty groups dropped. */

import { groupChats } from './chatGroups';

const NOON = new Date(2026, 8, 24, 12, 0, 0).getTime();
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

describe('groupChats', () => {
    it('files by calendar day, the web sidebar’s way', () => {
        const groups = groupChats(
            [
                { id: 'today', updated_at: at(2026, 8, 24, 0) },
                { id: 'late-last-night', updated_at: at(2026, 8, 23, 23) },
                { id: 'last-week', updated_at: at(2026, 8, 17) },
                { id: 'day-30', updated_at: at(2026, 7, 25) },
                { id: 'day-31', updated_at: at(2026, 7, 24) },
            ],
            NOON,
        );
        expect(groups.map((g) => [g.id, g.data.map((c) => c.id)])).toEqual([
            ['today', ['today']],
            ['yesterday', ['late-last-night']],
            ['month', ['last-week', 'day-30']],
            ['older', ['day-31']],
        ]);
    });

    it('puts a pinned chat under Pinned whatever its age, first', () => {
        const groups = groupChats([{ id: 'a', updated_at: at(2026, 8, 24) }, { id: 'p', pinned: true, updated_at: at(2020, 0, 1) }], NOON);
        expect(groups[0]).toEqual({ id: 'pinned', data: [expect.objectContaining({ id: 'p' })] });
    });

    it('falls back to created_at, and files an undated chat as older', () => {
        const groups = groupChats([{ id: 'c', created_at: at(2026, 8, 24) }, { id: 'x' }], NOON);
        expect(groups.map((g) => g.id)).toEqual(['today', 'older']);
    });

    it('draws nothing for no chats', () => {
        expect(groupChats([], NOON)).toEqual([]);
    });
});
