/** buildPatch for the trigger: the kind, and the sibling objects each kind owns or clears. */
import { paramsToSchema } from '../../../triggerSchemaUtils';
import { stripUndefined } from '../primitives';
import type { TypePatcher } from '../types';

const clearSiblings: TypePatcher = (patch) => {
    patch.schedule = null;
    patch.appEvent = null;
};

// Preserve any existing schedule/appEvent objects so we don't
// wipe sibling fields the form doesn't know about.
const KIND_PATCHERS = new Map<string, TypePatcher>([
    ['schedule', (patch, step, draft) => {
        patch.schedule = { ...(step.schedule || {}), cron: draft.scheduleCron || '', tz: draft.scheduleTz || 'Europe/Amsterdam' };
        patch.appEvent = null;
    }],
    ['app_event', (patch, step, draft) => {
        const cleanedFilter = stripUndefined(draft.filter || {});
        patch.appEvent = {
            ...(step.appEvent || {}),
            provider: draft.appProvider || '',
            event: draft.appEventName || '',
            filter: Object.keys(cleanedFilter).length ? cleanedFilter : null,
        };
        patch.schedule = null;
    }],
    ['agent_call', (patch, _step, draft) => {
        // Exposed as a function tool; the params-list becomes a JSON Schema.
        patch.toolName = (draft.toolName || '').trim() || null;
        patch.description = (draft.description || '').trim() || null;
        patch.parametersSchema = paramsToSchema(draft.params);
        clearSiblings(patch, _step, draft);
    }],
    // patch.form is already set by the trigger patcher; the URL token deliberately lives
    // in automation_form_pages, NOT here, so an export/import/duplicate
    // can never clone a live public URL.
    ['form', clearSiblings],
    ['layer_input', (patch, step, draft) => {
        patch.params = declaredParams(draft.params);
        clearSiblings(patch, step, draft);
    }],
    ['app_trigger', (patch, step, draft) => {
        patch.params = declaredParams(draft.params);
        clearSiblings(patch, step, draft);
    }],
]);

/**
 * Declared typed params become trigger.output.<name> — the flowlet input
 * contract, and the app trigger's Studio-App input contract (server contract:
 * automation/appTriggerContract.js).
 */
function declaredParams(params: unknown) {
    if (!Array.isArray(params)) return [];
    return params.filter(p => p && p.name).map(p => ({
        name: p.name, type: p.type || 'string', required: !!p.required,
        ...(p.description ? { description: p.description } : {}),
    }));
}

export const triggerPatchers: Record<string, TypePatcher> = {
    trigger: (patch, step, draft) => {
        patch.kind = draft.kind || 'manual';
        // Sibling nulling for the form declaration is unconditional: switching
        // a trigger away from `form` must not leave a stale form behind that a
        // later switch back would silently resurrect with old fields.
        patch.form = draft.kind === 'form' ? (draft.form || null) : null;
        (KIND_PATCHERS.get(draft.kind) || clearSiblings)(patch, step, draft);
    },
};
