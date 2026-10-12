/**
 * The Auto-map wand on a flowlet / Step call (useInputMapping): the same AI
 * fallback as on a tool step. The contract's required params that names do
 * not settle are asked about once, filled only while still empty, and the
 * toast counts both. The API is injected; nothing is module-mocked.
 *
 * Run: cd agent-hub && npx vitest run src/components/automation/Builder/flow/useInputMapping.aiAutoMap.test.ts
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import useInputMappingJs from './useInputMapping';
import { resetAiAutoMapAvailability } from '../mapping/aiAutoMap';
import type { SuggestMappingsRequest } from '../mapping/aiAutoMap';

type Inputs = Record<string, unknown>;
const useInputMapping = useInputMappingJs as unknown as (args: Record<string, unknown>) => { onAutoMap: () => void };

// `statementText` has no name a matcher could find: only composing two
// fields fills it, which is what the AI is for.
const CONTRACT = [
    { name: 'customer', type: 'string', required: true },
    { name: 'statementText', type: 'string', required: true, description: 'Shown on the bank statement' },
];
const SAMPLE = { customer: 'Contoso', invoiceNo: 'F-2026-031' };
const GROUPS = [{
    id: 'inv', kind: 'integration_action', label: 'Read invoice', basePath: 'steps.inv.output', sample: SAMPLE, hasRealData: true,
    fields: [
        { key: 'customer', path: 'steps.inv.output.customer', sample: 'Contoso' },
        { key: 'invoiceNo', path: 'steps.inv.output.invoiceNo', sample: 'F-2026-031' },
    ],
}];
const COMPOSED = { kind: 'template', value: '{{steps.inv.output.customer}} {{steps.inv.output.invoiceNo}}' };

function setup(api: { suggestMappings: (b: SuggestMappingsRequest) => Promise<unknown> }) {
    return renderHook(() => {
        const [inputs, setInputs] = useState<Inputs>({});
        const mapping = useInputMapping({ inputs, contract: CONTRACT, groups: GROUPS, onChange: setInputs, api });
        return { inputs, ...mapping };
    });
}

let toasts: string[] = [];
const onToast = (e: Event) => { toasts.push((e as CustomEvent).detail.item.message); };
beforeEach(() => { resetAiAutoMapAvailability(); toasts = []; window.addEventListener('beeflow:toast', onToast); });
afterEach(() => window.removeEventListener('beeflow:toast', onToast));

describe('useInputMapping — the wand asks the AI for what names leave empty', () => {
    it('fills the required param by name, the composed one with the AI, and counts both', async () => {
        const sent: SuggestMappingsRequest[] = [];
        const { result } = setup({
            suggestMappings: async (body) => {
                sent.push(body);
                return { suggestions: [{ key: 'statementText', binding: COMPOSED }] };
            },
        });
        act(() => result.current.onAutoMap());
        await waitFor(() => expect(result.current.inputs.statementText).toEqual(COMPOSED));
        expect(result.current.inputs.customer).toEqual({ kind: 'ref', path: 'steps.inv.output.customer' });
        expect(sent[0].params).toEqual([{ key: 'statementText', type: 'string', description: 'Shown on the bank statement', required: true }]);
        await waitFor(() => expect(toasts).toEqual(['Auto-mapped 2 inputs (1 with AI)']));
    });

    it('keeps the deterministic result when the AI does not answer', async () => {
        const { result } = setup({ suggestMappings: async () => { throw Object.assign(new Error('offline'), { status: 502 }); } });
        act(() => result.current.onAutoMap());
        await waitFor(() => expect(toasts).toEqual(['Auto-mapped 1 input']));
        expect(result.current.inputs).toEqual({ customer: { kind: 'ref', path: 'steps.inv.output.customer' } });
    });
});
