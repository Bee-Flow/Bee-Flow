/**
 * The two steps whose output shape the AUTHOR declares rather than the
 * catalog: an AI step with an `outputSchema` (or a leading skill that has
 * one), and an Extract-data step whose declared field names ARE its output.
 * Both are bindable the moment the declaration exists: no run, no schema
 * round-trip.
 */
import { sampleFromSchema, samplePlaceholderFor } from '../fields.mjs';
import { groupLabel } from './env.mjs';
import { fieldAt, stepBase, stepGroup } from './sampleFields.mjs';

/**
 * The leading skill of an AI step, as far as the step itself says: its first
 * own skill. (A skill the step only inherits from its agent is known to the
 * agent preview, not to the definition, so it is not seen here.)
 */
export function leadSkillId(node) {
    const ids = Array.isArray(node?.skillIds) ? node.skillIds : [];
    const first = ids.find(id => typeof id === 'string' && id);
    return first || null;
}

/**
 * The schema the step answers in, by the runtime's rule
 * (automationRunner/aiStepSkills.js effectiveOutputSchema): the step's own
 * schema wins, otherwise the leading skill's. `catalog.skillOutputs` maps a
 * skill id to its declared output (a JSON schema or `outputFields` rows),
 * filled by the client from the skills it has loaded.
 */
function effectiveSchema(node, catalog) {
    if (sampleFromSchema(node.outputSchema)) return node.outputSchema;
    const lead = leadSkillId(node);
    const skill = lead ? catalog?.skillOutputs?.[lead] : null;
    if (!skill) return null;
    return skill.outputSchema || skill.output_schema || skill.outputFields || skill;
}

export function describeAiStep(node, catalog, env) {
    const label = node.label || groupLabel(env, 'node.ai_step', 'AI step');
    // A declared schema (JSON schema or the flat `{field: 'type'}` form, the
    // runtime's tolerance) becomes a sample in its full shape: a list of
    // invoices keeps one invoice with its amount and vendor, so their columns
    // are pickable before the first run.
    const sample = sampleFromSchema(effectiveSchema(node, catalog));
    if (sample) return stepGroup(node, label, 'ai_step', sample);
    // WITHOUT a schema the runtime returns the RAW RESPONSE STRING as the
    // whole output. One honest leaf: bind the whole output.
    const whole = fieldAt(stepBase(node.id), [], '<AI response>');
    return stepGroup(node, label, 'ai_step', '<AI response>', [{ ...whole, key: 'response' }]);
}

/**
 * data_extraction output = ONE flat object with exactly the declared field
 * names (the runtime contract, see server execDataExtraction: a field the
 * model could not find is null, never a missing key). Typed placeholders so
 * the kind badges know a date from an amount.
 */
export function describeDataExtraction(node, env) {
    const declared = (Array.isArray(node.fields) ? node.fields : [])
        .filter(f => f && typeof f.name === 'string' && f.name.trim());
    const sample = {};
    for (const f of declared) {
        if (f.name in sample) continue;
        // `date` is an ISO YYYY-MM-DD string on the wire; a real-looking one
        // reads as a date rather than as free text.
        sample[f.name] = f.type === 'date' ? '2026-01-15' : samplePlaceholderFor(f.type);
    }
    return stepGroup(node, node.label || groupLabel(env, 'node.data_extraction', 'Extract data'), 'data_extraction', sample);
}
