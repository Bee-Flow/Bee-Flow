/** The inbox's sections: in age order, only the non-empty ones, rows in server order. */

import { sectionsByAge } from './sections';
import type { AppNotification } from './types';

function note(id: string, daysAgo: number | null): AppNotification {
    const at = daysAgo === null ? null : new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    return { id, task_id: null, category: 'info', title: id, message: '', link: null, read: false, created_at: at };
}

describe('sectionsByAge', () => {
    it('groups into today, this week and older, in that order', () => {
        const sections = sectionsByAge([note('old', 30), note('now', 0), note('mid', 3), note('now2', 0)]);
        expect(sections.map((s) => [s.key, s.title, s.data.map((n) => n.id)])).toEqual([
            ['today', 'Today', ['now', 'now2']],
            ['this_week', 'Earlier this week', ['mid']],
            ['older', 'Older', ['old']],
        ]);
    });

    it('leaves out empty sections, and files an undated row as older', () => {
        expect(sectionsByAge([note('undated', null)]).map((s) => s.key)).toEqual(['older']);
        expect(sectionsByAge([])).toEqual([]);
    });
});
