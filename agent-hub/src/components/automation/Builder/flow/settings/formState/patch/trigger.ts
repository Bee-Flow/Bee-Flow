/** buildPatch for the trigger: the kind, and the sibling objects each kind owns or clears. */
import { paramsToSchema } from '../../../triggerSchemaUtils';
import { stripUndefined } from '../primitives';
import type { TypePatcher } from '../types';

export const triggerPatchers: Record<string, TypePatcher> = {
    trigger: (patch, step, draft) => {
        patch.kind = draft.kind || 'manual';
        // Sibling nulling for the form declaration is unconditional: switching
        // a trigger away from `form` must not leave a stale form behind that a
        // later switch back would silently resurrect with old fields.
        patch.form = draft.kind === 'form' ? (draft.form || null) : null;
        // Preserve any existing schedule/appEvent objects so we don't
        // wipe sibling fields the form doesn't know about.
        if (draft.kind === 'schedule') {
            patch.schedule = { ...(step.schedule || {}), cron: draft.scheduleCron || '', tz: draft.scheduleTz || 'Europe/Amsterdam' };
            patch.appEvent = null;
        } else if (draft.kind === 'app_event') {
            const cleanedFilter = stripUndefined(draft.filter || {});
            patch.appEvent = {
                ...(step.appEvent || {}),
                provider: draft.appProvider || '',
                event: draft.appEventName || '',
                filter: Object.keys(cleanedFilter).length ? cleanedFilter : null,
            };
            patch.schedule = null;
        } else if (draft.kind === 'agent_call') {
            // Exposed as a function tool; the params-list becomes a JSON Schema.
            patch.toolName = (draft.toolName || '').trim() || null;
            patch.description = (draft.description || '').trim() || null;
            patch.parametersSchema = paramsToSchema(draft.params);
            patch.schedule = null;
            patch.appEvent = null;
        } else if (draft.kind === 'form') {
            // patch.form is already set above; the URL token deliberately lives
            // in automation_form_pages, NOT here, so an export/import/duplicate
            // can never clone a live public URL.
            patch.schedule = null;
            patch.appEvent = null;
        } else if (draft.kind === 'layer_input' || draft.kind === 'app_trigger') {
            // Declared typed params become trigger.output.<name> — the flowlet
            // input contract, and the app trigger's Studio-App input contract
            // (server contract: automation/appTriggerContract.js).
            patch.params = Array.isArray(draft.params)
                ? draft.params.filter(p => p && p.name).map(p => ({
                    name: p.name, type: p.type || 'string', required: !!p.required,
                    ...(p.description ? { description: p.description } : {}),
                }))
                : [];
            patch.schedule = null;
            patch.appEvent = null;
        } else {
            patch.schedule = null;
            patch.appEvent = null;
        }
    },
};
