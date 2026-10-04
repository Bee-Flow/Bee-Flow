// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    chipsOf, filterSolutions, healthOf, needsAttention, partitionSolutions, readSummary, runsOf, tabOf, updateOf,
} from './solutionOverviewModel';

/**
 * The overview's decisions, tested where they are made.
 *
 * Almost every case below is the same case: a tally the server could not read
 * arrives as `null`, and the screen must not turn that into a zero, a green
 * tick, or an absent chip. The card renders these states and adds nothing, so
 * proving the states are right here proves it for the card too — and does it
 * without a browser.
 */

/** A row as GET /api/projects/summary sends it, with everything readable. */
function row(over = {}) {
    return {
        id: 'p1',
        name: 'Quotes',
        permission: 'owner',
        installedFromBlueprintId: null,
        counts: {
            automations: 3, apps: 1, webpages: 1, datatables: 2, agents: 0,
            knowledgeBases: 1, notebooks: 0, skills: 0, documentTemplates: 0,
        },
        runs: { today: 12, failed: 0 },
        completeness: { blocked: false, complete: true, findings: 0, errors: 0, warnings: 0, unavailable: [] },
        update: null,
        unavailable: [],
        complete: true,
        ...over,
    };
}

describe('which tab a Solution belongs to', () => {
    it('splits on where it came from, not on who owns it', () => {
        expect(tabOf(row({ permission: 'viewer' }))).toBe('ours');
        expect(tabOf(row({ installedFromBlueprintId: 'b1', permission: 'owner' }))).toBe('installed');
    });

    it('EVERY row the server returned lands in exactly one tab', () => {
        // The reason the split is not "do I own it": a Solution shared with you
        // is neither yours nor installed, so under that rule it appeared on no
        // tab and simply vanished from the screen — a row the server sent and
        // the overview silently dropped.
        const rows = [
            row({ id: 'mine', permission: 'owner' }),
            row({ id: 'shared', permission: 'editor' }),
            row({ id: 'readonly', permission: 'viewer' }),
            row({ id: 'installed', permission: 'viewer', installedFromBlueprintId: 'b1' }),
        ];
        const { ours, installed } = partitionSolutions(rows);
        expect([...ours, ...installed].map(r => r.id).sort())
            .toEqual(['installed', 'mine', 'readonly', 'shared']);
        expect(ours.map(r => r.id)).toEqual(['mine', 'shared', 'readonly']);
        expect(installed.map(r => r.id)).toEqual(['installed']);
    });

    it('drops junk rather than crashing on it, and drops nothing else', () => {
        const { ours, installed } = partitionSolutions([null, { name: 'no id' }, row()]);
        expect(ours).toHaveLength(1);
        expect(installed).toHaveLength(0);
        expect(partitionSolutions(undefined)).toEqual({ ours: [], installed: [] });
    });
});

describe('the health chip', () => {
    it('is clear only when the server said the picture was whole and held nothing', () => {
        expect(healthOf(row())).toEqual({ state: 'clear', count: 0 });
    });

    it('a completeness that never arrived is UNKNOWN, never clear', () => {
        // The whole reason summary.js reports `completeness: null` separately
        // from an empty findings list.
        expect(healthOf(row({ completeness: null })).state).toBe('unknown');
        expect(healthOf({}).state).toBe('unknown');
    });

    it('counts what has to be fixed, and what is only worth a look', () => {
        expect(healthOf(row({
            completeness: { complete: true, findings: 3, errors: 2, warnings: 1, unavailable: [] },
        }))).toEqual({ state: 'blocking', count: 2 });
        expect(healthOf(row({
            completeness: { complete: true, findings: 2, errors: 0, warnings: 2, unavailable: [] },
        }))).toEqual({ state: 'advice', count: 2 });
    });

    it('findings with no severity still count as advice — never as clear', () => {
        expect(healthOf(row({
            completeness: { complete: true, findings: 2, errors: 0, warnings: 0, unavailable: [] },
        }))).toEqual({ state: 'advice', count: 2 });
    });

    it('A PARTIAL READ OUTRANKS THE COUNT, and withholds the number', () => {
        // "2 things to fix" over a Solution whose apps could not be listed is
        // misleading precision: the reader has no way to know there might be
        // five. The card says the picture is incomplete instead, and the Check
        // tab — which can show what was and was not read — carries the detail.
        const health = healthOf(row({
            completeness: { complete: false, findings: 2, errors: 2, warnings: 0, unavailable: ['apps'] },
        }));
        expect(health).toEqual({ state: 'unread', count: 0 });
    });

    it('a partial read with nothing found is still not clear', () => {
        expect(healthOf(row({
            completeness: { complete: false, findings: 0, errors: 0, warnings: 0, unavailable: ['agents'] },
        })).state).toBe('unread');
    });
});

describe('the run line', () => {
    it('tells a quiet day from a tally nobody could read', () => {
        expect(runsOf(row({ runs: { today: 0, failed: 0 } }))).toEqual({ state: 'idle', today: 0, failed: 0 });
        expect(runsOf(row({ runs: null }))).toEqual({ state: 'unknown', today: null, failed: null });
    });

    it('a failure outranks the count of runs, and keeps both numbers', () => {
        expect(runsOf(row({ runs: { today: 12, failed: 3 } })))
            .toEqual({ state: 'failed', today: 12, failed: 3 });
        expect(runsOf(row({ runs: { today: 12, failed: 0 } })))
            .toEqual({ state: 'ran', today: 12, failed: 0 });
    });

    it('a tally that is not a pair of numbers is unknown, not zero', () => {
        expect(runsOf(row({ runs: { today: null, failed: null } })).state).toBe('unknown');
        expect(runsOf(row({ runs: 'lots' })).state).toBe('unknown');
    });
});

describe('the count chips', () => {
    it('one chip per kind that has any, and none for a kind that has none', () => {
        const { chips, unreadable } = chipsOf(row());
        expect(chips.map(c => c.section)).toEqual(['automations', 'apps', 'webpages', 'datatables', 'knowledgeBases']);
        expect(chips.find(c => c.section === 'automations')).toEqual({ section: 'automations', kind: 'automation', count: 3 });
        expect(unreadable).toEqual([]);
    });

    it('A COUNT THAT COULD NOT BE READ IS NOT A MISSING CHIP', () => {
        // null and 0 both render no chip; only one of them is allowed to be
        // silent about it. Without this list a store outage looks exactly like
        // a Solution that holds nothing.
        const { chips, unreadable } = chipsOf(row({
            counts: { automations: null, apps: 1, webpages: 0, datatables: null, agents: 0, knowledgeBases: 0, notebooks: 0, skills: 0, documentTemplates: 0 },
        }));
        expect(chips.map(c => c.section)).toEqual(['apps']);
        expect(unreadable).toEqual(['automations', 'datatables']);
    });

    it('skills and document templates are counted like the rest', () => {
        const { chips } = chipsOf(row({ counts: { ...row().counts, skills: 2, documentTemplates: 1 } }));
        expect(chips.filter(c => ['skills', 'documentTemplates'].includes(c.section)))
            .toEqual([{ section: 'skills', kind: 'skill', count: 2 }, { section: 'documentTemplates', kind: 'document', count: 1 }]);
    });

    it('a section the server did not mention at all counts as unreadable', () => {
        const { unreadable } = chipsOf({ counts: { apps: 2 } });
        expect(unreadable).toContain('automations');
        expect(unreadable).not.toContain('apps');
    });

    it('a count that is not a number is unreadable, never rendered', () => {
        const { chips, unreadable } = chipsOf(row({ counts: { ...row().counts, apps: 'many' } }));
        expect(chips.map(c => c.section)).not.toContain('apps');
        expect(unreadable).toEqual(['apps']);
    });
});

describe('whether a newer Blueprint exists', () => {
    it('says nothing at all about a Solution that came from no Blueprint', () => {
        expect(updateOf(row())).toBeNull();
    });

    it('names the version when there is one', () => {
        expect(updateOf(row({
            installedFromBlueprintId: 'b1',
            update: { blueprintId: 'b1', installedVersion: 4, latestVersion: 5, available: true },
        }))).toEqual({ state: 'available', installedVersion: 4, latestVersion: 5 });
    });

    it('AN UNANSWERABLE COMPARISON IS NOT "UP TO DATE"', () => {
        // A Blueprint that was deleted, or belongs to an organisation this
        // reader is not in, comes back with `available: null`. Rounding that to
        // "current" is how somebody keeps running v1.2 believing it is the
        // newest thing there is.
        const update = updateOf(row({
            installedFromBlueprintId: 'b1',
            update: { blueprintId: 'b1', installedVersion: 4, latestVersion: null, available: null },
        }));
        expect(update.state).toBe('unknown');
        expect(update.latestVersion).toBeNull();
    });

    it('an explicit no is its own answer', () => {
        expect(updateOf(row({
            installedFromBlueprintId: 'b1',
            update: { blueprintId: 'b1', installedVersion: 5, latestVersion: 5, available: false },
        })).state).toBe('current');
    });
});

describe('reading the summary payload', () => {
    it('keeps the rows, the named gaps and hasMore', () => {
        const read = readSummary({
            projects: [row()], unavailable: ['runs'], hasMore: true, checkedCount: 1,
        });
        expect(read.rows).toHaveLength(1);
        expect(read.unavailable).toEqual(['runs']);
        expect(read.hasMore).toBe(true);
        expect(read.checkedCount).toBe(1);
    });

    it('A BODY WITH NO PROJECT LIST IS NOT AN EMPTY WORKSPACE', () => {
        // The route's own 500 path sends `{ projects: [], unavailable: ['all'] }`
        // for this reason; anything else that arrives without a list gets the
        // same marker rather than passing for a clean, empty overview.
        expect(readSummary(null).unavailable).toEqual(['all']);
        expect(readSummary({}).unavailable).toEqual(['all']);
        expect(readSummary({ projects: 'nope' }).unavailable).toEqual(['all']);
        expect(readSummary({ projects: [], unavailable: ['all'] })).toEqual({
            rows: [], unavailable: ['all'], hasMore: false, checkedCount: null,
        });
    });

    it('an empty list that DID arrive says nothing is missing', () => {
        expect(readSummary({ projects: [], unavailable: [] }).unavailable).toEqual([]);
    });
});

describe('needsAttention and filterSolutions', () => {
    const calm = { id: 'a', name: 'Quotes', permission: 'owner', completeness: { blocked: false, complete: true, findings: 0, errors: 0, warnings: 0, unavailable: [] }, runs: { today: 1, failed: 0 } };
    const failing = { id: 'b', name: 'Invoices', permission: 'viewer', completeness: { blocked: false, complete: true, findings: 0, errors: 0, warnings: 0, unavailable: [] }, runs: { today: 2, failed: 1 } };
    const waiting = { ...calm, id: 'c', name: 'Onboarding', stages: [{ stage: 'uat', pending: { seq: 2 } }] };

    it('flags failed runs and a waiting stage, not a calm card', () => {
        expect(needsAttention(calm)).toBe(false);
        expect(needsAttention(failing)).toBe(true);
        expect(needsAttention(waiting)).toBe(true);
    });

    it('sorts the cards that need attention first and keeps the order otherwise', () => {
        expect(filterSolutions([calm, failing, waiting]).map(r => r.id)).toEqual(['b', 'c', 'a']);
    });

    it('filters by scope and by a case-insensitive search', () => {
        const rows = [calm, failing, waiting];
        expect(filterSolutions(rows, { scope: 'mine' }).map(r => r.id)).toEqual(['c', 'a']);
        expect(filterSolutions(rows, { scope: 'attention' }).map(r => r.id)).toEqual(['b', 'c']);
        expect(filterSolutions(rows, { query: 'INVO' }).map(r => r.id)).toEqual(['b']);
    });
});
