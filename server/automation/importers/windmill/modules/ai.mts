/**
 * Windmill AI modules (PLAN B3, research 06 §C.1):
 *
 *   aiagent     -> ai_step (systemPrompt, prompt from user_message, outputSchema, temperature,
 *                  modelTier "auto"); the provider and model are the organisation's in Bee Flow,
 *                  and agent tools go to the AI checklist
 *   aidecision  -> AI checklist: the shape of its questions and answers is not mapped in v1
 */

import type { WmNode } from '../ir.mts';
import type { MapCtx, Port, Step } from '../context.mts';
import type { Binding } from '../mapExpr.mts';
import { addStep, newId, register } from '../context.mts';
import { bindInputs, flagUntranslated, labelOf, placeholder, reportModule } from '../emit.mts';
import { isObject } from '../util.mts';

const IGNORED = new Set(['provider', 'model', 'memory', 'max_iterations', 'streaming', 'reasoning_effort', 'output_type', 'user_attachments', 'enabled_tools', 'messages_context_length']);

function textOf(b: Binding | undefined): string | null {
    if (!b) return null;
    if (b.kind === 'literal' && typeof b.value === 'string') return b.value;
    if (b.kind === 'ref') return `{{${b.path}}}`;
    if (b.kind === 'template') return b.value;
    return null;
}

export function mapAiAgent(ctx: MapCtx, node: WmNode, ports: Port[]): Port[] {
    const wanted = Object.fromEntries(Object.entries(node.inputs).filter(([k]) => !IGNORED.has(k)));
    const bound = bindInputs(ctx, node, wanted);
    const id = newId(ctx, node.wmId);
    const out = addStep(ctx, agentStep(id, node, bound.bindings), ports);
    register(ctx, node.wmId, `steps.${id}.output`, null);
    flagUntranslated(ctx, node, id, bound);
    if (node.inputs.provider || node.inputs.model) ctx.report.warn('ai_destination', `"${labelOf(node, 'AI agent')}" chose its own AI provider and model in Windmill; it now runs on the model this organisation set up.`, node.wmId);
    const tools = node.agentTools ?? [];
    if (tools.length) {
        ctx.report.ai({ wmId: node.wmId, stepId: id, title: `Give "${labelOf(node, 'AI agent')}" its tools`, why: `The Windmill agent used tools (${tools.map((t) => t.name ?? t.type).join(', ')}); pick the matching Bee Flow tools for the step.` });
    }
    const status = tools.length || bound.untranslated.length ? 'ai' : 'mapped';
    reportModule(ctx, node, [status, status === 'mapped' ? 'medium' : 'low', 'The AI agent becomes an AI step.', [id]]);
    return out;
}

function agentStep(id: string, node: WmNode, b: Record<string, Binding>): Step {
    const step: Step = { id, type: 'ai_step', label: labelOf(node, 'AI agent'), modelTier: 'auto', prompt: 'Do the task described in the step label.', inputs: {} };
    const system = textOf(b.system_prompt);
    if (system) step.systemPrompt = system;
    const prompt = textOf(b.user_message);
    if (prompt) step.prompt = prompt;
    else if (b.user_message) {
        step.prompt = 'Answer the message in the input "message".';
        step.inputs = { message: b.user_message };
    }
    if (b.output_schema?.kind === 'literal' && isObject(b.output_schema.value)) step.outputSchema = b.output_schema.value;
    if (b.temperature?.kind === 'literal' && typeof b.temperature.value === 'number') step.temperature = Math.max(0, Math.min(2, b.temperature.value));
    return step;
}

export function mapAiDecision(ctx: MapCtx, node: WmNode, ports: Port[]): Port[] {
    return placeholder(ctx, node, 'An AI decision step: the builder makes an AI step with a fixed set of answers and a switch on them.', ports);
}
