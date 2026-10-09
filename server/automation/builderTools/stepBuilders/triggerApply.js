/**
 * Builder tools — applying a trigger call to the draft: builder_set_trigger's
 * per-kind shaping (schedule, webhook, app_event, form, app_trigger,
 * agent_call) into `draft.trigger`. Sanitizes loosely; save-time validate.js is
 * authoritative.
 */

const { agentCallFieldsFrom, validateAgentCallTrigger, agentCallParams } = require('../../agentCallContract');

/**
 * What a re-proposal of the SAME kind keeps from the trigger it replaces: the
 * label and canvas position the person set, a pinned sample and an app
 * trigger's appRef. A model that re-calls builder_propose_trigger to tweak the
 * trigger must not undo what the person did on the canvas. A different kind starts
 * clean, and so does an app_event that now names another event: a sample of the
 * old payload would be wrong data for the new one.
 */
function carriedOver(prev, args) {
    if (!prev || typeof prev !== 'object' || prev.kind !== args.kind) return {};
    const sameEvent = args.kind !== 'app_event'
        || (prev.appEvent?.provider === args.appProvider && prev.appEvent?.event === args.appEvent);
    return {
        ...(typeof prev.label === 'string' && prev.label ? { label: prev.label } : {}),
        ...(prev.position && typeof prev.position === 'object' ? { position: prev.position } : {}),
        // The back-pointer to the App Studio button this automation was made
        // from: not something the builder can re-derive, so it must survive.
        ...(args.kind === 'app_trigger' && prev.appRef ? { appRef: prev.appRef } : {}),
        ...(sameEvent && prev.pinnedOutput !== undefined && prev.pinnedOutput !== null ? { pinnedOutput: prev.pinnedOutput } : {}),
    };
}

/**
 * The declared form (contract: automation/formTriggerContract.js). The URL token
 * is NOT part of the definition — it is a row in automation_form_pages, minted
 * when the author opens the trigger. Sanitize loosely; save-time validate.js is
 * authoritative.
 */
function buildForm(raw) {
    const f = raw && typeof raw === 'object' ? raw : {};
    return {
        title: typeof f.title === 'string' && f.title.trim() ? f.title : 'Form',
        ...(typeof f.description === 'string' ? { description: f.description } : {}),
        ...(typeof f.submitLabel === 'string' ? { submitLabel: f.submitLabel } : {}),
        ...(typeof f.successMessage === 'string' ? { successMessage: f.successMessage } : {}),
        fields: buildFormFields(f.fields),
        ...(typeof f.collect === 'boolean' ? { collect: f.collect } : {}),
        ...(f.theme && typeof f.theme === 'object' ? { theme: f.theme } : {}),
    };
}

function buildFormFields(fields) {
    const { FIELD_TYPES } = require('../../formTriggerContract');
    if (!Array.isArray(fields)) return [];
    return fields
        .filter((p) => p && typeof p === 'object' && p.name)
        .map((p) => ({
            name: String(p.name),
            type: FIELD_TYPES.includes(p.type) ? p.type : 'text',
            label: typeof p.label === 'string' && p.label.trim() ? p.label : String(p.name),
            required: !!p.required,
            ...(p.placeholder ? { placeholder: String(p.placeholder).slice(0, 120) } : {}),
            ...(Array.isArray(p.options) ? { options: p.options.filter(o => typeof o === 'string' && o.trim()).slice(0, 50) } : {}),
            ...(p.accept ? { accept: String(p.accept).slice(0, 300) } : {}),
            ...(p.maxSizeMb != null && Number.isFinite(Number(p.maxSizeMb)) ? { maxSizeMb: Number(p.maxSizeMb) } : {}),
            ...(typeof p.help === 'string' && p.help.trim() ? { help: p.help.slice(0, 120) } : {}),
            // An app_pick question is unbuildable without these: `source` says
            // which app the person searches (field_pick_no_source otherwise),
            // the rest shape the answer (one descriptor or a list, with or
            // without the record's text). Only kept for that type, so a stray
            // `source` on a text field cannot reach the stored form.
            ...(p.type === 'app_pick' ? {
                ...(typeof p.source === 'string' && p.source.trim() ? { source: p.source.trim().slice(0, 60) } : {}),
                ...(typeof p.multiple === 'boolean' ? { multiple: p.multiple } : {}),
                ...(p.maxItems != null && Number.isFinite(Number(p.maxItems)) ? { maxItems: Number(p.maxItems) } : {}),
                ...(typeof p.withText === 'boolean' ? { withText: p.withText } : {}),
            } : {}),
        }));
}

/**
 * Typed inputs a Studio App action provides (contract:
 * automation/appTriggerContract.js). Sanitize loosely here — save-time
 * validate.js re-checks names/dups/types authoritatively.
 */
function buildAppParams(params) {
    const { PARAM_TYPES } = require('../../appTriggerContract');
    return Array.isArray(params)
        ? params
            .filter((p) => p && typeof p === 'object' && p.name)
            .map((p) => ({
                name: String(p.name),
                type: PARAM_TYPES.includes(p.type) ? p.type : 'string',
                required: !!p.required,
                ...(p.description ? { description: String(p.description).slice(0, 500) } : {}),
            }))
        : [];
}

const NO_ARGS_WARNING = 'no arguments are declared: the agent gets a tool that takes any object and the steps have nothing named to bind. Declare each input with params:[{name,type,required,description}] and bind it as trigger.output.<name>.';

/** Plain-text lines for the issues the save-time validator would raise on this agent_call trigger. */
function agentCallIssueLines(trigger) {
    return validateAgentCallTrigger(trigger).map(issue => `${issue.message} ${issue.hint}`);
}

function applyTrigger(draft, args) {
    const warnings = [];
    draft.trigger = { id: 'trg', type: 'trigger', kind: args.kind, output: {}, ...carriedOver(draft.trigger, args) };
    if (args.kind === 'schedule') draft.trigger.schedule = { cron: args.cron, tz: args.tz || 'Europe/Amsterdam' };
    if (args.kind === 'webhook') draft.trigger.webhook = {};
    if (args.kind === 'app_event') draft.trigger.appEvent = { provider: args.appProvider, event: args.appEvent, filter: args.filter || null };
    if (args.kind === 'form') draft.trigger.form = buildForm(args.form);
    if (args.kind === 'app_trigger') draft.trigger.params = buildAppParams(args.params);
    if (args.kind === 'agent_call') {
        // The tool an agent sees (contract: automation/agentCallContract.js). The
        // editor writes these three on the trigger and the runtime reads exactly
        // them (agentCallableTools.automationToTool); without them the agent got
        // a tool called automation_<uuid> that accepted anything.
        const { fields, notes } = agentCallFieldsFrom(args);
        for (const [k, v] of Object.entries(fields)) if (v !== null) draft.trigger[k] = v;
        warnings.push(...notes);
        if (!draft.trigger.parametersSchema) warnings.push(NO_ARGS_WARNING);
        warnings.push(...agentCallIssueLines(draft.trigger));
    }
    return {
        trigger: draft.trigger,
        ...(warnings.length ? { _warnings: warnings } : {}),
        ...triggerHints(draft.trigger),
    };
}

/**
 * Where the declared inputs of the trigger arrive in a run, and what is still
 * for the person to do. Both are things the result of the call can say and the
 * model should repeat to the user.
 */
function triggerHints(trigger) {
    if (trigger.kind !== 'agent_call') return {};
    const paths = agentCallParams(trigger).map(p => `trigger.output.${p.name}`);
    return {
        ...(paths.length ? { outputPaths: paths } : {}),
        next: 'Bind the arguments above in the steps. An agent can only call this automation once it is linked to that agent: the person does that under "Who can call this" in the trigger panel (the builder cannot), so tell them.',
    };
}

module.exports = { applyTrigger, triggerHints, buildForm, buildFormFields, buildAppParams, agentCallIssueLines, NO_ARGS_WARNING };
