/**
 * describeSourceList, the "Working through" line: a Condition output picked
 * as the source list reads as the output's name ("pdf", "Otherwise"), never
 * as its internal key ("Matches by case pdf"), as on the web.
 */
import type { VariableGroup } from '@/features/flow-editor/bindings';

import { describeSourceList } from './SourceSummary';

const ROWS = [{ name: 'a.pdf' }, { name: 'b.pdf' }];
const BY_CASE = { pdf: ROWS, default: ROWS.slice(0, 1) };
const COND = {
    id: 'cond', label: 'Condition', kind: 'switch', basePath: 'steps.cond.output',
    sample: { matchesByCase: BY_CASE },
    fields: [{
        key: 'matchesByCase', path: 'steps.cond.output.matchesByCase', sample: BY_CASE,
        children: [
            { key: 'pdf', path: 'steps.cond.output.matchesByCase.pdf', sample: ROWS },
            { key: 'default', path: 'steps.cond.output.matchesByCase.default', sample: BY_CASE.default },
        ],
    }],
} as unknown as VariableGroup;
const SAMPLE = { steps: { cond: { output: { matchesByCase: BY_CASE } } } };
const t = (key: string, fallback: string) => (key === 'condition_node.otherwise.label' ? 'Anders' : fallback);

describe('describeSourceList', () => {
    it('names a Condition output by its own name, in the reader’s language', () => {
        expect(describeSourceList('steps.cond.output.matchesByCase.default', [COND], SAMPLE, t))
            .toEqual({ stepLabel: 'Condition', fieldLabel: 'Anders', count: 1 });
        expect(describeSourceList('steps.cond.output.matchesByCase.pdf', [COND], SAMPLE, t)?.fieldLabel).toBe('pdf');
    });

    it('is null for a path that holds no list, or no path', () => {
        expect(describeSourceList('steps.cond.output.matchesByCase', [COND], SAMPLE, t)).toBeNull();
        expect(describeSourceList('', [COND], SAMPLE, t)).toBeNull();
    });
});
