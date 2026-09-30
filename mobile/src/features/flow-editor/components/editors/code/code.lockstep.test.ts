/**
 * The code editor held to the web's (actionEditors/codeFields.tsx):
 * `readCodeContract` — the reader behind "What this step may reach", now its
 * own module (codeStep/readCodeContract.ts) — is required from the web and
 * run beside the port; the inputs round trip is asked of this app's formState
 * exactly as the web asks its own; and a refusal is the palette's own sentence.
 */

import path from 'node:path';

import type { FlowNode } from '@/features/flow-editor/bindings';
import { buildPatch, extractFormState } from '@/features/flow-editor/formState';
import { CODE_OFF_REASONS } from '@/features/flow-editor/model';

import { codeInputsRoundTrip, codeRefusal, readCodeContract } from './codeModel';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const { readCodeContract: web } = require(path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder/flow/settings/codeStep/readCodeContract.ts')) as {
    readCodeContract: (code: unknown) => unknown;
};

describe('the code editor against codeFields.tsx', () => {
    it.each([
        '',
        'async function main(inputs, ctx) { return inputs.a + inputs["b c"]; }',
        'const { x, y: z, ...rest } = inputs; ctx.log(x);',
        'let k = "a"; return inputs[k];',
        'await ctx.http("https://x"); await ctx.integrations.gmail_send({}); ctx.integrations["slack post"]();',
        'ctx.secrets("k"); // inputs.fromComment',
        42,
    ])('reads the contract of %j as the web does', (code) => {
        expect(readCodeContract(code)).toEqual(web(code));
    });

    it('carries the step’s inputs through a save, so the inputs table is offered', () => {
        expect(codeInputsRoundTrip()).toBe(true);
        const step = { id: 'c1', type: 'code', label: 'Sum', icon: 'Code', code: 'return 1', inputs: { a: { kind: 'literal', value: 'x' } } } as unknown as FlowNode;
        expect(buildPatch(step, { ...extractFormState(step), code: 'return 2' })).toEqual({ code: 'return 2' });
    });

    it('says why a code step would be refused, and claims nothing it was not told', () => {
        expect(codeRefusal({ code: true, codeReason: 'org' })).toBeNull();
        expect(codeRefusal({ code: false, codeReason: null })).toBeNull();
        expect(codeRefusal(null)).toBeNull();
        expect(codeRefusal({ code: false, codeReason: 'runtime' })).toEqual(['mobile.flow.palette.code_off_runtime', CODE_OFF_REASONS.runtime]);
        expect(codeRefusal({ code: false, codeReason: 'org' })).toEqual(['mobile.flow.palette.code_off_unknown', CODE_OFF_REASONS.unknown]);
        expect(codeRefusal({ code: 'yes', codeReason: 'weird' })).toEqual(['mobile.flow.palette.code_off_unknown', CODE_OFF_REASONS.unknown]);
    });
});
