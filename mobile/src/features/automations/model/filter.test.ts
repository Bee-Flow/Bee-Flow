/** The automation list's search and status chips, as the list applies them. */

import { filterAutomations } from './filter';
import type { Automation } from './types';

function automation(id: string, over: Partial<Automation> = {}): Automation {
    return {
        id,
        userId: 'u1',
        projectId: null,
        folderId: null,
        kind: 'automation',
        title: `Automation ${id}`,
        description: null,
        definition: {},
        version: 1,
        isActive: true,
        isDraft: false,
        needsFirstRunConfirm: false,
        triggerType: 'manual',
        scheduleCron: null,
        scheduleTz: null,
        nextRunAt: null,
        lastRunAt: null,
        lastStatus: null,
        runningInstanceId: null,
        runningStartedAt: null,
        createdAt: null,
        updatedAt: null,
        ...over,
    };
}

const ALL = [
    automation('a', { title: 'Invoice digest', description: 'Every Monday' }),
    automation('b', { isActive: false }),
    automation('c', { lastStatus: 'failed' }),
    automation('d', { lastStatus: 'error', isActive: false }),
];

const ids = (rows: Automation[]) => rows.map((r) => r.id);

describe('filterAutomations', () => {
    it('matches the search in the title or the description, ignoring case and edges', () => {
        expect(ids(filterAutomations(ALL, '  INVOICE ', 'all'))).toEqual(['a']);
        expect(ids(filterAutomations(ALL, 'monday', 'all'))).toEqual(['a']);
    });

    it('filters by on and paused', () => {
        expect(ids(filterAutomations(ALL, '', 'active'))).toEqual(['a', 'c']);
        expect(ids(filterAutomations(ALL, '', 'paused'))).toEqual(['b', 'd']);
    });

    it('reads both the runner word and the run-table word as a failure', () => {
        expect(ids(filterAutomations(ALL, '', 'failing'))).toEqual(['c', 'd']);
    });

    it('applies the search and the chip together', () => {
        expect(ids(filterAutomations(ALL, 'automation', 'paused'))).toEqual(['b', 'd']);
    });
});
