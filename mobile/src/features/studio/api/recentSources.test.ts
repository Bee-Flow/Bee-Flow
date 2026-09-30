/** The per-section list readers keep the web's status rules (studioRecentSources.js). */

import { readRecentRows, RECENT_SOURCES } from './recentSources';

describe('readRecentRows', () => {
    it('reads an agent as live by published_version, not by the sharing flag', () => {
        const { items } = readRecentRows('agents', [
            { id: 'a1', name: 'Live', updated_at: '2026-09-01T00:00:00Z', published_version: 2, is_published: false },
            { id: 'a2', name: 'Draft', updated_at: '2026-09-02T00:00:00Z', published_version: 0, is_published: true },
            { id: 'a3', name: 'Unknown' },
        ]);
        expect(items.map((i) => i.status)).toEqual(['published', 'draft', 'unknown']);
        expect(items[0]?.updatedAt).toBe('2026-09-01T00:00:00Z');
    });

    it('reads an automation draft before its failure, and a missing flag as unknown', () => {
        const { items } = readRecentRows('aiTasks', [
            { id: 1, title: 'A', isDraft: true, lastStatus: 'error' },
            { id: 2, title: 'B', isActive: true, lastStatus: 'error' },
            { id: 3, title: 'C', isActive: false },
            { id: 4, title: 'D' },
        ]);
        expect(items.map((i) => [i.id, i.name, i.status])).toEqual([
            ['1', 'A', 'draft'],
            ['2', 'B', 'failed'],
            ['3', 'C', 'paused'],
            ['4', 'D', 'unknown'],
        ]);
    });

    it('never accuses a legacy app of unpublished changes', () => {
        const { items } = readRecentRows('apps', [
            { id: 'a', name: 'Legacy', isPublished: true, publishedVersion: null, definitionVersion: 7 },
            { id: 'b', name: 'Moved on', isPublished: true, publishedVersion: 2, definitionVersion: 3 },
        ]);
        expect(items.map((i) => i.status)).toEqual(['published', 'unpublished_changes']);
    });

    it('gives the statusless kinds no status, and a meeting its processing state', () => {
        expect(readRecentRows('datatables', [{ id: 't', name: 'T', isPublished: true }]).items[0]?.status).toBe('unsupported');
        expect(readRecentRows('meetingNotes', [{ id: 'm', fileName: 'call.m4a', status: 'queued' }]).items[0]).toMatchObject({
            name: 'call.m4a',
            status: 'processing',
        });
    });

    it('drops rows without an id and calls a body without an array unreadable', () => {
        expect(readRecentRows('skills', [{ name: 'no id' }, null, 'x']).items).toEqual([]);
        expect(readRecentRows('skills', { error: 'nope' })).toEqual({ refused: false, items: [], whole: false });
    });

    it('takes each list out of its own envelope', () => {
        expect(RECENT_SOURCES.webpages.pick({ webpages: [1] })).toEqual([1]);
        expect(RECENT_SOURCES.solutions.pick([2])).toEqual([2]);
        expect(RECENT_SOURCES.solutions.pick({ projects: [3] })).toEqual([3]);
    });
});
