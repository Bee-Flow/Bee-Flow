/**
 * A step over a list inside a list keeps its outer lists (`forEach.parents`)
 * through a save, on the phone exactly as on the web
 * (agent-hub `flow/settings/formState.js` applyForEachPatch).
 */

import { buildPatch, extractFormState } from './index';
import { BUILDER, requireWeb } from '../bindings/testing/web';
import type { FlowNode } from '../bindings/types';

const web = requireWeb(`${BUILDER}/flow/settings/formState.js`);

const PLAIN = { overRef: 'steps.s1.output.results', itemVar: 'result', maxIterations: 100 };
const DEEP = {
    overRef: 'steps.read.output.results[*].output.attachments', itemVar: 'attachment', maxIterations: 100,
    parents: [{ itemVar: 'result', overRef: 'steps.read.output.results[*].output' }],
};
const step = (forEach: object): FlowNode => ({ id: 'att', type: 'integration_action', tool: 'gmail_read_attachment', forEach, inputs: {} }) as FlowNode;

describe('applyForEachPatch keeps parents', () => {
    it.each([
        ['moved down', PLAIN, DEEP],
        ['malformed entries dropped', PLAIN, { ...DEEP, parents: [null, { itemVar: 'x' }, { ...DEEP.parents[0], extra: 1 }] }],
        ['back to a plain list', DEEP, { ...PLAIN, parents: [] }],
    ])('%s', (_name, before, after) => {
        const s = step(before);
        const draft = { ...extractFormState(s), forEach: after };
        expect(buildPatch(s, draft)).toStrictEqual(web.buildPatch?.(s, draft));
    });

    it('writes the parents back', () => {
        const s = step(PLAIN);
        expect(buildPatch(s, { ...extractFormState(s), forEach: DEEP }).forEach).toEqual(DEEP);
    });
});
