// @typecheck strict
'use strict';
/**
 * The trigger lines of the agent-facing draft state (summarise.js
 * renderAgentDraftState): which trigger starts the graph and what it hands the
 * steps as trigger.output.<name>.
 *
 * A form start also says what each field asks for (its form field type: email,
 * select, file, ...) and how many pages the visitor sees (the form itself plus
 * every form_page step), so the model can talk about the form the user built
 * instead of a bare list of names.
 */

const { declaredTriggerFields } = require('./builderTools/triggerCatalog');

/**
 * @typedef {{ name?: unknown, type?: unknown }} FormFieldLike
 * @typedef {{ id?: string, kind?: string, toolName?: string, params?: Array<string | { name?: string }>,
 *   form?: { fields?: FormFieldLike[] } }} TriggerLike
 * @typedef {{ steps?: Array<{ type?: string } | null> }} GraphLike
 */

/**
 * "2 pages": the trigger's own form plus each form_page step of the graph.
 * @param {GraphLike | null | undefined} graph
 */
function formPageCount(graph) {
    const steps = Array.isArray(graph?.steps) ? graph.steps : [];
    const pages = 1 + steps.filter((s) => s && s.type === 'form_page').length;
    return `${pages} page${pages === 1 ? '' : 's'}`;
}

/**
 * "name (text), cv (file)": the answers a form trigger hands on, with their form field type.
 * @param {TriggerLike} trigger
 * @returns {string[]}
 */
function formInputs(trigger) {
    const fields = Array.isArray(trigger.form?.fields) ? trigger.form.fields : [];
    /** @type {Map<string, string>} */
    const typeOf = new Map();
    for (const f of fields) {
        if (f && typeof f.name === 'string') typeOf.set(f.name, typeof f.type === 'string' && f.type ? f.type : 'text');
    }
    /** @type {Array<{ name: string }>} */
    const declared = declaredTriggerFields(trigger);
    return declared.map((f) => `${f.name} (${typeOf.get(f.name) || 'text'})`);
}

/**
 * The line of a graph's primary trigger.
 * @param {TriggerLike} t        the trigger
 * @param {GraphLike} graph      the main flow or the flowlet it starts
 * @returns {string}
 */
function triggerStateLine(t, graph) {
    const id = t.id || 'trg';
    if (t.kind === 'layer_input') {
        const params = (t.params || []).map((p) => (typeof p === 'string' ? p : p.name)).filter(Boolean);
        return `  - \`${id}\` trigger:layer_input  inputs: ${params.join(', ') || '(none)'}  (bind inside as trigger.output.<name>)`;
    }
    if (t.kind === 'form') {
        const inputs = formInputs(t);
        const listed = inputs.length ? `  inputs: ${inputs.join(', ')}` : '';
        return `  - \`${id}\` trigger:form${listed}  · ${formPageCount(graph)}${inputs.length ? '  (bind as trigger.output.<name>)' : ''}`;
    }
    // The inputs an author declared are the only place their names are
    // written down: list them with the path the steps bind, or the model has
    // to guess (and invent) what trigger.output holds.
    /** @type {Array<{ name: string }>} */
    const fields = declaredTriggerFields(t);
    const declared = fields.map((f) => f.name);
    const tool = t.kind === 'agent_call' && t.toolName ? `  tool: ${t.toolName}` : '';
    const inputs = declared.length ? `  inputs: ${declared.join(', ')}  (bind as trigger.output.<name>)` : '';
    return `  - \`${id}\` trigger:${t.kind || 'manual'}${tool}${inputs}`;
}

module.exports = { triggerStateLine };
