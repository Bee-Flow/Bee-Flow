/**
 * Builder tools — applying a trigger call to the draft: builder_set_trigger's
 * per-kind shaping (schedule, webhook, app_event, form, app_trigger) into
 * `draft.trigger`. Sanitizes loosely; save-time validate.js is authoritative.
 */

function applyTrigger(draft, args) {
    draft.trigger = { id: 'trg', type: 'trigger', kind: args.kind, output: {} };
    if (args.kind === 'schedule') draft.trigger.schedule = { cron: args.cron, tz: args.tz || 'Europe/Amsterdam' };
    if (args.kind === 'webhook') draft.trigger.webhook = {};
    if (args.kind === 'app_event') draft.trigger.appEvent = { provider: args.appProvider, event: args.appEvent, filter: args.filter || null };
    if (args.kind === 'form') {
        // The declared form (contract: automation/formTriggerContract.js). The
        // URL token is NOT part of the definition — it is a row in
        // automation_form_pages, minted when the author opens the trigger.
        // Sanitize loosely; save-time validate.js is authoritative.
        const f = args.form && typeof args.form === 'object' ? args.form : {};
        const { FIELD_TYPES } = require('../../formTriggerContract');
        draft.trigger.form = {
            title: typeof f.title === 'string' && f.title.trim() ? f.title : 'Form',
            ...(typeof f.description === 'string' ? { description: f.description } : {}),
            ...(typeof f.submitLabel === 'string' ? { submitLabel: f.submitLabel } : {}),
            ...(typeof f.successMessage === 'string' ? { successMessage: f.successMessage } : {}),
            fields: Array.isArray(f.fields)
                ? f.fields
                    .filter((p) => p && typeof p === 'object' && p.name)
                    .map((p) => ({
                        name: String(p.name),
                        type: FIELD_TYPES.includes(p.type) ? p.type : 'text',
                        label: typeof p.label === 'string' && p.label.trim() ? p.label : String(p.name),
                        required: !!p.required,
                        ...(p.placeholder ? { placeholder: String(p.placeholder).slice(0, 120) } : {}),
                        ...(Array.isArray(p.options) ? { options: p.options.filter(o => typeof o === 'string' && o.trim()).slice(0, 50) } : {}),
                        ...(p.accept ? { accept: String(p.accept).slice(0, 300) } : {}),
                        ...(Number.isFinite(Number(p.maxSizeMb)) ? { maxSizeMb: Number(p.maxSizeMb) } : {}),
                    }))
                : [],
            ...(f.theme && typeof f.theme === 'object' ? { theme: f.theme } : {}),
        };
    }
    if (args.kind === 'app_trigger') {
        // Typed inputs a Studio App action provides (contract:
        // automation/appTriggerContract.js). Sanitize loosely here — save-time
        // validate.js re-checks names/dups/types authoritatively.
        const { PARAM_TYPES } = require('../../appTriggerContract');
        draft.trigger.params = Array.isArray(args.params)
            ? args.params
                .filter((p) => p && typeof p === 'object' && p.name)
                .map((p) => ({
                    name: String(p.name),
                    type: PARAM_TYPES.includes(p.type) ? p.type : 'string',
                    required: !!p.required,
                    ...(p.description ? { description: String(p.description).slice(0, 500) } : {}),
                }))
            : [];
    }
    return { trigger: draft.trigger };
}

module.exports = { applyTrigger };
