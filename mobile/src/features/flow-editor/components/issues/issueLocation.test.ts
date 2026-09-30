import type { FlowDefinition } from '@/features/flow-editor/model';

import { locateIssue } from './issueLocation';
import { issueRows } from './issuesModel';

const def = {
    trigger: { id: 'trigger', type: 'manual', label: 'Start' },
    triggers: [{ id: 'sched_2', type: 'schedule', label: 'Every morning' }],
    steps: [
        { id: 'act_a', type: 'action', label: 'Send' },
        { id: 'lp', type: 'loop', label: 'Each order', body: [{ id: 'b_ai', type: 'ai_step', label: 'Summarise' }] },
        { id: 'par', type: 'parallel', label: 'Both', branches: [[{ id: 'x1', type: 'action', label: 'Left' }], [{ id: 'y1', type: 'action' }]] },
    ],
    edges: [],
    layers: { lookup: { trigger: { id: 'lt', type: 'layer_input' }, steps: [{ id: 'tidy', type: 'action', label: 'Tidy up' }], edges: [] } },
} as unknown as FlowDefinition;

describe('locateIssue', () => {
    it('reads a top-level step by index or id', () => {
        expect(locateIssue({ path: 'steps[0].inputs.to' }, def)).toEqual({ address: 'act_a', flowlet: null });
        expect(locateIssue({ path: 'steps[act_a].inputs.to' }, def)).toEqual({ address: 'act_a', flowlet: null });
    });

    it('reads a step held in a loop body or a parallel branch as its address', () => {
        expect(locateIssue({ path: 'steps[1].body.steps[b_ai].prompt' }, def)).toEqual({ address: 'lp/b_ai', flowlet: null });
        expect(locateIssue({ path: 'steps[2].branches[1].steps[y1].tool' }, def)).toEqual({ address: 'par/y1', flowlet: null });
    });

    it('reads a second trigger and a flowlet step', () => {
        expect(locateIssue({ path: 'triggers[sched_2].schedule.cron' }, def)).toEqual({ address: 'sched_2', flowlet: null });
        expect(locateIssue({ path: 'layers.lookup.steps[0].tool' }, def)).toEqual({ address: 'tidy', flowlet: 'lookup' });
    });

    it('names nothing for a path about no step', () => {
        expect(locateIssue({ path: 'edges[2]' }, def)).toBeNull();
        expect(locateIssue({ path: 'layers.gone.steps[0]' }, def)).toBeNull();
        expect(locateIssue({ path: 'steps[9]' }, def)).toBeNull();
    });
});

describe('issueRows: findings below the top level can be opened', () => {
    it('gives a loop-body, trigger and flowlet finding its step, flowlet and name', () => {
        const rows = issueRows(
            {
                errors: [
                    { code: 'binding.missing', severity: 'error', path: 'steps[1].body.steps[b_ai].prompt', message: 'b_ai has no prompt' },
                    { code: 'trigger.schedule_cron_invalid', severity: 'error', path: 'triggers[sched_2].schedule.cron', message: 'Schedule trigger has an unusable pattern' },
                    { code: 'tool.missing', severity: 'error', path: 'layers.lookup.steps[0].tool', message: 'tidy has no tool' },
                ],
                warnings: [],
            },
            def,
        );
        expect(rows.map((r) => [r.stepId, r.flowlet, r.stepLabel])).toEqual([
            ['lp/b_ai', null, 'Summarise'],
            ['sched_2', null, 'Every morning'],
            ['tidy', 'lookup', 'Tidy up'],
        ]);
        expect(rows[0]?.message).toBe('"Summarise" has no prompt');
        expect(rows[2]?.message).toBe('"Tidy up" has no tool');
    });
});
