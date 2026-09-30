/**
 * Calling a reusable group of steps — the web's CallLayerFields and
 * CallStepFields (actionEditors/flowletCallFields.jsx over
 * CallContractFields.jsx). The contract is not the step's: a flowlet's comes
 * live from `definition.layers[layerKey]` (its layer_input params and its
 * layer_output fields), a published Step's from the catalog. The step only
 * holds the mapping — one binding per declared input.
 */

import { getLayerContract, type FlowNode } from '@/features/flow-editor/bindings';

import { msg, type ContractParam, type EditorSpec, type SpecContext } from '../spec';
import { TITLES } from './common';

export function layerContract(ctx: SpecContext): { title: string | null; params: ContractParam[]; outputFields: string[] } {
    const key = ctx.step.layerKey as string | undefined;
    const { params, outputFields } = getLayerContract(ctx.definition, key);
    const layer = key ? ctx.definition.layers?.[key] : undefined;
    const title = (layer as { title?: string } | undefined)?.title ?? null;
    return { title, params: params as ContractParam[], outputFields };
}

export function blockContract(ctx: SpecContext): { title: string | null; params: ContractParam[]; outputFields: string[] } {
    const block = (ctx.catalog?.steps ?? []).find((b) => b.id === ctx.step.blockId) ?? null;
    return {
        title: block?.title ?? null,
        params: (block?.params ?? []) as ContractParam[],
        outputFields: ((block?.outputFields ?? []) as unknown[]).map((f) => (typeof f === 'string' ? f : String((f as { name?: string })?.name ?? ''))).filter(Boolean),
    };
}

type Contract = typeof layerContract;

function callSpec(type: string, headerKey: string, contract: Contract, words: { header: string; missing: string; inputs: string; none: string }): EditorSpec {
    const target = (step: FlowNode, ctx: SpecContext) => contract(ctx).title || String(step.layerKey || step.label || step.blockId || '—');
    return {
        type,
        sections: [
            {
                key: headerKey,
                title: msg(`mobile.flow.call.${headerKey}`, words.header),
                defaultOpen: true,
                fields: [
                    { kind: 'display', id: 'target', label: msg(`mobile.flow.call.${headerKey}`, words.header), show: (_draft, ctx) => target(ctx.step, ctx) },
                    {
                        kind: 'note',
                        id: 'missing',
                        tone: 'warning',
                        visibleWhen: (_draft, ctx) => !contract(ctx).title && !!(ctx.step.layerKey || ctx.step.blockId),
                        hint: msg(`mobile.flow.call.missing_${headerKey}`, words.missing),
                    },
                ],
            },
            {
                key: 'inputs',
                title: TITLES.inputs,
                defaultOpen: true,
                fields: [
                    { kind: 'contract', key: 'inputs', contract: (ctx) => contract(ctx).params, hint: msg(`mobile.flow.call.inputs_${headerKey}`, words.inputs) },
                    {
                        kind: 'note',
                        id: 'noInputs',
                        visibleWhen: (_draft, ctx) => contract(ctx).params.length === 0,
                        hint: msg(`mobile.flow.call.no_inputs_${headerKey}`, words.none),
                    },
                ],
            },
            {
                key: 'returns',
                title: TITLES.returns,
                fields: [
                    {
                        kind: 'display',
                        id: 'returns',
                        hint: msg('mobile.flow.call.returns_hint', 'These fields are available to downstream steps by name.'),
                        show: (_draft, ctx) => contract(ctx).outputFields.join(', ') || '—',
                    },
                ],
            },
        ],
    };
}

export const CALL_LAYER = callSpec('call_layer', 'flowlet', layerContract, {
    header: 'Flowlet',
    missing: 'This flowlet was not found in this automation.',
    inputs: 'Map each flowlet parameter to an upstream value.',
    none: 'This flowlet has no declared inputs.',
});

export const CALL_BLOCK = callSpec('call_block', 'step', blockContract, {
    header: 'Step',
    missing: 'This Step is unpublished, deleted, or not shared with you.',
    inputs: 'Map each Step input to an upstream value.',
    none: 'This Step has no declared inputs.',
});
