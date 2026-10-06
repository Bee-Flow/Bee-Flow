// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { routeFollowOf, staleSuccessorsOf, wholeRunNoticeOf } from './routeFollowNotes';

/**
 * The facts the Condition editor's notices are built from (RouteFields'
 * `routeFollow`, W7, and `wholeRun`, BFSF-485 F3/F4). Labels are plain words:
 * a list name, a step name, never a path.
 */
type Obj = Record<string, any>;

const t = (_key: string, fallback: string) => fallback;

/** Google Sheets: list → Condition → a per-item step over the list. */
function sheetsDefinition(cond: Obj, perItemOverRef = 'steps.sheets.output.results'): Obj {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual', label: 'Manual trigger' },
        steps: [
            { id: 'sheets', type: 'integration_action', tool: 'gsheets_list', label: 'List sheets' },
            cond,
            {
                id: 'process', type: 'integration_action', tool: 'gsheets_read', label: 'Read sheet',
                forEach: { overRef: perItemOverRef, itemVar: 'sheet' },
            },
        ],
        edges: [
            { from: 'trg', to: 'sheets' },
            { from: 'sheets', to: 'cond' },
            { from: 'cond', to: 'process', label: 'then' },
        ],
    };
}
const wholeRunCond = { id: 'cond', type: 'condition', label: 'Condition', expr: 'contains(steps.sheets.output.results[*].name, "Reiskosten")' };
const listCond = { id: 'cond', type: 'filter', label: 'Condition', arrayRef: 'steps.sheets.output.results', expr: 'contains(item.name, "Reiskosten")' };

describe('wholeRunNoticeOf — a whole-run Condition that reads a list as a whole', () => {
    it('names the list in plain words and the per-item step after it', () => {
        const def = sheetsDefinition(wholeRunCond);
        const notice = wholeRunNoticeOf(wholeRunCond, def, null, t);
        expect(notice?.lists).toHaveLength(1);
        expect(notice?.lists[0].path).toBe('steps.sheets.output.results');
        expect(notice?.lists[0].label).toContain('List sheets');
        expect(notice?.lists[0].label).not.toContain('steps.');
        expect(notice?.loops).toEqual([{ stepId: 'process', stepLabel: 'Read sheet' }]);
    });

    it('lists no loop when the step after it reads something else', () => {
        const def = sheetsDefinition(wholeRunCond, 'steps.other.output.rows');
        expect(wholeRunNoticeOf(wholeRunCond, def, null, t)?.loops).toEqual([]);
    });

    it('recognises a list without [*] from the sample, read like the run (JSON text too)', () => {
        const cond = { ...wholeRunCond, expr: 'contains(steps.sheets.output.names, "Reiskosten")' };
        const def = sheetsDefinition(cond);
        expect(wholeRunNoticeOf(cond, def, null, t)).toBeNull();
        const sampleRoot = { steps: { sheets: { output: { names: '[{"name":"Reiskosten Q3"},{"name":"Lunch"}]' } } } };
        expect(wholeRunNoticeOf(cond, def, sampleRoot, t)?.lists.map(l => l.path)).toEqual(['steps.sheets.output.names']);
        // Read whole, no rule reads an item of it: nothing to work through.
        expect(wholeRunNoticeOf(cond, def, sampleRoot, t)?.lists[0].convertible).toBe(false);
    });

    it('marks a list whose items a rule reads ([*]) as convertible', () => {
        expect(wholeRunNoticeOf(wholeRunCond, sheetsDefinition(wholeRunCond), null, t)?.lists[0].convertible).toBe(true);
    });

    it('leaves a membership test on a list of plain values alone (contains(labels, "urgent"))', () => {
        const cond = { ...wholeRunCond, expr: 'contains(steps.sheets.output.labels, "urgent")' };
        const sampleRoot = { steps: { sheets: { output: { labels: ['urgent', 'x'] } } } };
        expect(wholeRunNoticeOf(cond, sheetsDefinition(cond), sampleRoot, t)).toBeNull();
    });

    it('is null for an emptiness check, for a list Condition and without a step', () => {
        const empty = { ...wholeRunCond, expr: '!isEmpty(steps.sheets.output.results)' };
        expect(wholeRunNoticeOf(empty, sheetsDefinition(empty), null, t)).toBeNull();
        expect(wholeRunNoticeOf(listCond, sheetsDefinition(listCond), null, t)).toBeNull();
        expect(wholeRunNoticeOf(null, sheetsDefinition(wholeRunCond), null, t)).toBeNull();
    });
});

describe('routeFollowOf — the next steps of a list Condition that still read its list', () => {
    it('names them and re-points them through the shell', () => {
        const def = sheetsDefinition(listCond);
        def.edges[2] = { from: 'cond', to: 'process' };
        const onFollowRoute = vi.fn();
        const rf = routeFollowOf(listCond, def, onFollowRoute, t);
        expect(rf?.stale).toEqual([{ stepId: 'process', stepLabel: 'Read sheet', readsLabel: expect.stringContaining('List sheets') }]);
        rf?.follow(['process']);
        expect(onFollowRoute).toHaveBeenCalledWith('cond', ['process']);
    });

    it('is null for a whole-run Condition, and when the shell cannot edit', () => {
        expect(routeFollowOf(wholeRunCond, sheetsDefinition(wholeRunCond), vi.fn(), t)).toBeNull();
        expect(routeFollowOf(listCond, sheetsDefinition(listCond), null, t)).toBeNull();
    });

    it('names a list inside each row by its plain label, no bracketed note inside the sentence', () => {
        const cond = { ...listCond, arrayRef: 'steps.sheets.output.results[*].tabs' };
        const def = sheetsDefinition(cond, 'steps.sheets.output.results[*].tabs');
        def.edges[2] = { from: 'cond', to: 'process' };
        const [stale] = staleSuccessorsOf(def, 'cond', null, t);
        expect(stale.readsLabel).toContain('Tabs');
        expect(stale.readsLabel).not.toContain('inside each row');
    });

    it('lists nothing once the step reads what the Condition keeps', () => {
        const def = sheetsDefinition(listCond, 'steps.cond.output.items');
        expect(staleSuccessorsOf(def, 'cond', null, t)).toEqual([]);
    });
});
