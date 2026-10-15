// Mapping-state handlers for the "call" step editors (call_layer / call_block).
// Both CallLayerFields and CallStepFields open-coded an identical pair of
// handlers over `draft.inputs`:
//
//   const setInput = (name, binding) => { …delete-on-empty… set('inputs', next) };
//   const onAutoMap = () => { …autoMapInputs over the param contract… };
//
// This hook centralises that logic. Give it the current `inputs` map, the
// param `contract` ([{ name, type, required, description }]), the upstream
// `groups`, and an `onChange(nextInputs)` writer; it returns
// `{ setInput, onAutoMap }`. The shared renderer lives in CallContractFields.

import { paramsFromContract } from '../mapping/aiAutoMap';
import { autoMapInputs } from '../mapping/autoMapInputs';
import useAiAutoMap from '../mapping/useAiAutoMap';
import type { Binding, GroupLike, Inputs, SuggestMappingsApi } from '../mapping/aiAutoMap';

/** One declared parameter of the called flowlet / step. */
export interface ContractParam {
    name: string;
    type?: string;
    required?: boolean;
    description?: string;
}

interface UseInputMappingArgs {
    inputs: Inputs;
    contract: ContractParam[];
    groups?: GroupLike[] | null;
    onChange: (next: Inputs) => void;
    api?: SuggestMappingsApi | null;
}

export default function useInputMapping({ inputs, contract, groups, onChange, api = null }: UseInputMappingArgs) {
    // Auto-map's AI fallback (mapping/useAiAutoMap.ts); `api` is for tests.
    const askAi = useAiAutoMap({ inputs, api });
    // Set or clear the binding for a single param. A missing binding or a
    // blank literal counts as "unset" so the key doesn't linger in the map.
    const setInput = (name: string, binding?: Binding | null) => {
        const next = { ...inputs };
        if (!binding || (binding.kind === 'literal' && (binding.value === '' || binding.value == null))) delete next[name];
        else next[name] = binding;
        onChange(next);
    };

    // Auto-map every declared param from the upstream groups, merging the
    // result over the current bindings (existing bindings win).
    const onAutoMap = () => {
        const schema = {
            properties: Object.fromEntries(contract.map((p: ContractParam) => [p.name, { type: p.type }])),
            required: contract.filter((p: ContractParam) => p.required).map((p: ContractParam) => p.name),
        };
        const patch = autoMapInputs(schema, inputs, groups || []);
        const next = { ...inputs, ...patch };
        if (Object.keys(patch).length) onChange(next);
        // Required params still empty: ask the AI for those, on this click
        // only. Silent when it is not available; the result above stands.
        askAi({
            params: paramsFromContract(contract), inputs: next, groups: groups || [],
            deterministicCount: Object.keys(patch).length,
            write: (fill, latest) => onChange(fill(latest)),
        });
    };

    return { setInput, onAutoMap };
}
