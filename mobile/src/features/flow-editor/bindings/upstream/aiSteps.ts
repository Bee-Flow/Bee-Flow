/**
 * The two steps whose output shape the AUTHOR declares: an AI step with an
 * `outputSchema`, and an Extract-data step whose field names ARE its output.
 * Port of agent-hub `Builder/mapping/upstream/aiSteps.js`.
 */

import { translate as t } from '@/core/i18n';
import { nodeDefaultLabel } from '@/features/flow-editor/model/nodeDefs';

import { arr, isObj } from '../json';
import type { FlowNode, VariableGroup } from '../types';
import { samplePlaceholderFor, stepGroup } from './sampleFields';

/** Both schema shapes the runtime accepts: JSON Schema, or flat `{field: 'type'}`. */
function aiStepOutputProps(schema: unknown): Record<string, string> | null {
    if (!isObj(schema)) return null;
    const raw = isObj(schema.properties) ? schema.properties : schema;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
        if (!k) continue;
        if (typeof v === 'string') out[k] = v;
        else if (v && typeof v === 'object') out[k] = typeof (v as { type?: unknown }).type === 'string' ? ((v as { type: string }).type) : 'string';
    }
    return Object.keys(out).length ? out : null;
}

/**
 * WITHOUT a schema the runtime returns the RAW RESPONSE STRING as the whole
 * output — one honest leaf. With one, its declared fields.
 */
export function describeAiStep(node: FlowNode): VariableGroup {
    const label = node.label || nodeDefaultLabel('ai_step', t);
    const props = aiStepOutputProps(node.outputSchema);
    const base = `steps.${node.id}.output`;
    if (!props) {
        return stepGroup(node, { label, kind: 'ai_step' }, '<AI response>', [{ key: 'response', path: base, sample: '<AI response>' }]);
    }
    const sample = Object.fromEntries(Object.entries(props).map(([k, type]) => [k, samplePlaceholderFor(type)]));
    return stepGroup(node, { label, kind: 'ai_step' }, sample);
}

// `date` is an ISO YYYY-MM-DD string on the wire; a real-looking one reads as a date.
function extractionPlaceholderFor(type: unknown): unknown {
    if (type === 'date') return '2026-01-15';
    return samplePlaceholderFor(type);
}

/**
 * data_extraction output = ONE flat object with exactly the declared names (a
 * field the model could not find is null, never missing) — bindable the moment
 * the author has typed a name.
 */
export function describeDataExtraction(node: FlowNode): VariableGroup {
    const declared = arr<{ name?: unknown; type?: unknown }>(node.fields)
        .filter((f) => f && typeof f.name === 'string' && f.name.trim());
    const sample: Record<string, unknown> = {};
    for (const f of declared) {
        const name = f.name as string;
        if (name in sample) continue;
        sample[name] = extractionPlaceholderFor(f.type);
    }
    return stepGroup(node, { label: node.label || nodeDefaultLabel('data_extraction', t), kind: 'data_extraction' }, sample);
}
