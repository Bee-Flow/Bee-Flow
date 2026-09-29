import { describe, it, expect } from 'vitest';
import { isLinkTool, linksAddedIn, stepSummary } from './webpageTurnFacts';

/**
 * What a turn is allowed to claim it did.
 *
 * Every assertion below is the same rule from a different side: a card may
 * only report an action the tool stream says COMPLETED. A grant that failed,
 * a grant still running, and a read that connected nothing must all produce
 * silence — an author who is told a table is connected stops looking for the
 * reason their page has no data.
 */

const done = (name, ms = 1000, extra = {}) =>
    ({ name, status: 'done', startTime: 1000, endTime: 1000 + ms, ...extra });

describe('isLinkTool', () => {
    it('recognises the three grant tools', () => {
        expect(isLinkTool('webpage_grant_ai')).toBe(true);
        expect(isLinkTool('webpage_grant_automation')).toBe(true);
        expect(isLinkTool('webpage_grant_integration')).toBe(true);
    });

    it('counts the table tool that WRITES, and neither that reads', () => {
        expect(isLinkTool('webpage_db_exec')).toBe(true);
        expect(isLinkTool('webpage_db_query')).toBe(false);
        expect(isLinkTool('webpage_db_schema')).toBe(false);
    });

    it('is not fooled by a lookalike name or a non-string', () => {
        expect(isLinkTool('webpage_grant')).toBe(false);
        expect(isLinkTool('not_webpage_grant_ai')).toBe(false);
        expect(isLinkTool(undefined)).toBe(false);
        expect(isLinkTool(42)).toBe(false);
    });
});

describe('linksAddedIn', () => {
    it('reports nothing for a turn that edited files only', () => {
        expect(linksAddedIn({ toolHistory: [done('webpage_write_doc')] })).toEqual([]);
    });

    it('reports nothing when there is no tool history at all', () => {
        expect(linksAddedIn({})).toEqual([]);
        expect(linksAddedIn(null)).toEqual([]);
        expect(linksAddedIn({ toolHistory: 'nonsense' })).toEqual([]);
    });

    it('reports a completed grant', () => {
        const links = linksAddedIn({ toolHistory: [done('webpage_grant_automation', 500, { args: { automationId: 'a1' } })] });
        expect(links).toHaveLength(1);
        expect(links[0].name).toBe('webpage_grant_automation');
        expect(links[0].args).toEqual({ automationId: 'a1' });
    });

    it('does NOT report a grant that is still running', () => {
        expect(linksAddedIn({ toolHistory: [{ name: 'webpage_grant_ai', status: 'running', startTime: 1 }] })).toEqual([]);
    });

    it('does NOT report a grant that failed', () => {
        expect(linksAddedIn({ toolHistory: [{ name: 'webpage_grant_ai', status: 'error', startTime: 1, endTime: 2 }] })).toEqual([]);
    });

    it('lists each tool once, in the order it ran', () => {
        const links = linksAddedIn({
            toolHistory: [
                done('webpage_db_exec'), done('webpage_grant_ai'), done('webpage_db_exec'),
            ],
        });
        expect(links.map(l => l.name)).toEqual(['webpage_db_exec', 'webpage_grant_ai']);
    });
});

describe('stepSummary', () => {
    it('is null for a turn with no visible tool', () => {
        expect(stepSummary({ toolHistory: [] })).toBeNull();
        expect(stepSummary({})).toBeNull();
    });

    it('does not count the model thinking aloud as a step', () => {
        expect(stepSummary({ toolHistory: [done('sequentialthinking')] })).toBeNull();
        expect(stepSummary({ toolHistory: [done('sequentialthinking'), done('webpage_write_doc')] }))
            .toEqual({ steps: 1, seconds: 1 });
    });

    it('sums the completed steps', () => {
        expect(stepSummary({ toolHistory: [done('a', 400), done('b', 1100)] }))
            .toEqual({ steps: 2, seconds: 1.5 });
    });

    it('keeps the count but drops the duration when a step is untimed', () => {
        // A partial sum shown as a total understates the work by an unknown
        // amount — so the count stands and the time says nothing.
        const s = stepSummary({ toolHistory: [done('a', 400), { name: 'b', status: 'done', startTime: 5 }] });
        expect(s.steps).toBe(2);
        expect(s.seconds).toBeNull();
    });

    it('drops the duration rather than reporting negative time', () => {
        const s = stepSummary({ toolHistory: [{ name: 'a', status: 'done', startTime: 900, endTime: 100 }] });
        expect(s).toEqual({ steps: 1, seconds: null });
    });

    it('ignores steps that never finished', () => {
        const s = stepSummary({ toolHistory: [done('a', 200), { name: 'b', status: 'running', startTime: 1 }] });
        expect(s).toEqual({ steps: 1, seconds: 0.2 });
    });
});
