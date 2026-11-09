import { describe, expect, it } from 'vitest';

import { groupConversationsByDate } from './sidebarConversations';

const t = (key: string) => key;
const labelsOf = (groups: ReturnType<typeof groupConversationsByDate>) =>
    Object.fromEntries(groups.map(g => [g.label, g.items.map(c => c.id)]));

describe('groupConversationsByDate', () => {
    it('sorts conversations into today, yesterday, the last 30 days and older', () => {
        const now = new Date(2026, 5, 15, 10, 0, 0);
        const at = (daysAgo: number) => new Date(2026, 5, 15 - daysAgo, 23, 30, 0).toISOString();
        const groups = groupConversationsByDate([
            { id: 'pin', pinned: true, updated_at: at(40) },
            { id: 'today', updated_at: new Date(2026, 5, 15, 0, 5, 0).toISOString() },
            { id: 'yesterday', updated_at: at(1) },
            { id: 'week', updated_at: at(6) },
            { id: 'old', updated_at: at(31) },
        ], t, now);
        expect(labelsOf(groups)).toEqual({
            'sidebar.pinned': ['pin'],
            'sidebar.today': ['today'],
            'sidebar.yesterday': ['yesterday'],
            'sidebar.last_30_days': ['week'],
            'sidebar.older': ['old'],
        });
    });

    // The worker's time zone cannot be switched from inside a test (the pool
    // runs threads, which do not see a changed TZ), so this one only runs
    // where the machine's own zone moved its clocks forward on 29 March 2026
    // (most of Europe). Under UTC it is skipped.
    const springForward = new Date(2026, 2, 30).getTime() - new Date(2026, 2, 29).getTime() < 24 * 3_600_000;
    it.runIf(springForward)('keeps yesterday under "yesterday" on the day after the clocks went forward', () => {
        const monday = new Date(2026, 2, 30, 9, 0, 0);
        const groups = groupConversationsByDate([
            { id: 'sun', updated_at: new Date(2026, 2, 29, 15, 0, 0).toISOString() },
            { id: 'sat', updated_at: new Date(2026, 2, 28, 15, 0, 0).toISOString() },
        ], t, monday);
        expect(labelsOf(groups)).toEqual({
            'sidebar.yesterday': ['sun'],
            'sidebar.last_30_days': ['sat'],
        });
    });
});
