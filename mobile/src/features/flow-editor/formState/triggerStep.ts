/**
 * The trigger's draft and patch: one form over every kind (manual, schedule,
 * app event, form, agent call, flowlet input, Studio App). Switching kind nulls
 * the siblings the new kind doesn't use, so a later switch back never
 * resurrects stale config. From agent-hub `Builder/flow/settings/formState.js`;
 * pinned by formState.lockstep.test.ts.
 */

import { stripUndefined } from './common';
import { get, objOr, or } from './read';
import type { Extractor, FormDraft, Patcher, Step, StepPatch } from './types';
import { paramsToSchema, schemaToParams } from '../bindings/flowDeps/triggerSchemaUtils';

function paramsDraft(step: Step, kind: unknown): unknown {
    if (kind === 'agent_call') return schemaToParams(step.parametersSchema);
    return Array.isArray(step.params) ? step.params : [];
}

export const extractTrigger: Extractor = (step, base) => {
    const kind = step.kind || 'manual';
    return {
        ...base,
        kind,
        scheduleCron: or(get(step.schedule, 'cron'), ''),
        scheduleTz: or(get(step.schedule, 'tz'), 'Europe/Amsterdam'),
        // Empty: a fresh app_event trigger snaps to the first AVAILABLE provider.
        appProvider: or(get(step.appEvent, 'provider'), ''),
        appEventName: or(get(step.appEvent, 'event'), ''),
        filter: or(get(step.appEvent, 'filter'), {}),
        form: objOr(step.form, null),
        toolName: or(step.toolName, ''),
        description: or(step.description, ''),
        params: paramsDraft(step, kind),
    };
};

function declaredParams(params: unknown): unknown[] {
    if (!Array.isArray(params)) return [];
    return params
        .filter((p) => p && p.name)
        .map((p) => ({
            name: p.name,
            type: p.type || 'string',
            required: !!p.required,
            ...(p.description ? { description: p.description } : {}),
        }));
}

function clearSchedules(patch: StepPatch): void {
    patch.schedule = null;
    patch.appEvent = null;
}

function patchScheduleKind(patch: StepPatch, step: Step, draft: FormDraft): void {
    patch.schedule = { ...((step.schedule as object) || {}), cron: or(draft.scheduleCron, ''), tz: or(draft.scheduleTz, 'Europe/Amsterdam') };
    patch.appEvent = null;
}

function patchAppEventKind(patch: StepPatch, step: Step, draft: FormDraft): void {
    const cleaned = stripUndefined(or(draft.filter, {}));
    patch.appEvent = {
        ...((step.appEvent as object) || {}),
        provider: or(draft.appProvider, ''),
        event: or(draft.appEventName, ''),
        filter: Object.keys(cleaned).length ? cleaned : null,
    };
    patch.schedule = null;
}

function patchAgentCallKind(patch: StepPatch, _step: Step, draft: FormDraft): void {
    // Exposed as a function tool; the params list becomes a JSON Schema.
    patch.toolName = String(draft.toolName || '').trim() || null;
    patch.description = String(draft.description || '').trim() || null;
    patch.parametersSchema = paramsToSchema(draft.params);
    clearSchedules(patch);
}

function patchParamsKind(patch: StepPatch, _step: Step, draft: FormDraft): void {
    patch.params = declaredParams(draft.params);
    clearSchedules(patch);
}

const KIND_PATCHERS: Record<string, Patcher> = {
    schedule: patchScheduleKind,
    app_event: patchAppEventKind,
    agent_call: patchAgentCallKind,
    layer_input: patchParamsKind,
    app_trigger: patchParamsKind,
};

export const patchTrigger: Patcher = (patch, step, draft) => {
    patch.kind = draft.kind || 'manual';
    // Unconditional: a switch away from `form` must not leave a stale form behind.
    patch.form = draft.kind === 'form' ? draft.form || null : null;
    const kind = String(draft.kind);
    const kindPatch = Object.hasOwn(KIND_PATCHERS, kind) ? KIND_PATCHERS[kind] : undefined;
    if (kindPatch) kindPatch(patch, step, draft);
    else clearSchedules(patch);
};
