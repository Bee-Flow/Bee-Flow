import { describe, expect, it } from 'vitest';
import { resolveLoopContext } from './useNodeDetailData';

// A step that runs once per attachment; its run row is the forEach envelope.
const STEP = { id: 'dl', type: 'integration_action', label: 'Download each attachment', forEach: { overRef: 'steps.r.output.value[*].attachments', itemVar: 'attachment' } };
const RUN = [{ stepId: 'dl', output: { iterations: 3, succeeded: 3, failed: 0, results: [{}, {}, {}] } }];
const OWN = { id: 'dl__foreach', label: 'Current item (attachment)', kind: 'loop', basePath: 'loop.attachment', sample: {}, fields: [] };

describe('the runs pill of a per-item step', () => {
    it('names the ITEM, not the step: "once per attachment"', () => {
        const ctx = resolveLoopContext({ groups: [OWN], definition: { steps: [STEP] } as never, runSteps: RUN as never })!;
        expect(ctx.runs).toBe(3);
        expect(ctx.itemNoun).toBe('attachment');
    });

    it('an item name in snake case reads as words', () => {
        const step = { ...STEP, forEach: { ...STEP.forEach, itemVar: 'line_item' } };
        expect(resolveLoopContext({ groups: [OWN], definition: { steps: [step] } as never, runSteps: RUN as never })?.itemNoun).toBe('line item');
    });

    it('finds the step\'s own item even when its outer items are listed first', () => {
        const parent = { ...OWN, id: 'dl__parent_mail', label: 'Outer item (mail)', basePath: 'loop.mail' };
        const ctx = resolveLoopContext({ groups: [parent, OWN], definition: { steps: [STEP] } as never, runSteps: RUN as never });
        expect(ctx?.itemNoun).toBe('attachment');
    });

    it('a Loop keeps its own name', () => {
        const loop = { id: 'lp', type: 'loop', label: 'Per bank', itemVar: 'bank', overRef: 'x' };
        const ctx = resolveLoopContext({ groups: [{ ...OWN, id: 'lp__foreach', basePath: 'loop.bank' }], definition: { steps: [loop] } as never, runSteps: [{ stepId: 'lp', output: { iterations: 2 } }] as never });
        expect(ctx?.itemNoun).toBeNull();
        expect(ctx?.listLabel).toBe('Per bank');
    });
});
