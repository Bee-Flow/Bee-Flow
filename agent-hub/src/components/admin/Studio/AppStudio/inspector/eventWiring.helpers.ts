import { describeAction } from './actionLabels';
import { effectSteps, otherComponentsRunning, screenIdOfNode, stepCount, stepFromAction } from './actionRefs';
import { API_BASE, authFetch } from '@/utils/helpers';
import { logger } from '@/utils/logger';
import { runStartRefusal } from '@/api/queries/automation/runAccess';
import type { TranslateFn } from '@/hooks/useTranslation';
import type {
    ActionEffect, AppAction, AppDefinition, AppRef, FormFieldRef, InputMapping, ParamMetaByName,
} from './appDefinition';

/**
 * The pure decisions behind one event slot's wiring (useEventWiring): the
 * declared input contract of the target automation, the action choices, a
 * kind switch, the mapping a picked automation starts with, the mapping
 * edits, and the test run's request. Moved out of useEventWiring.ts
 * verbatim.
 */

/** The target automation's trigger — where its declared input contract lives. */
export interface AutomationTrigger {
    kind?: string;
    /** app_trigger's typed params. */
    params?: Array<{ name?: string; type?: string; required?: boolean; description?: string } | null>;
    /** agent_call's JSON-schema half. */
    parametersSchema?: {
        properties?: Record<string, { type?: unknown; description?: string } | null>;
        required?: unknown;
    };
    [key: string]: unknown;
}

/** One automation the picker has resolved, as far as this hook reads it. */
export interface WiredAutomation {
    id: string;
    title?: string;
    definition?: { trigger?: AutomationTrigger | null;[key: string]: unknown } | null;
    [key: string]: unknown;
}

type TriggerParam = NonNullable<NonNullable<AutomationTrigger['params']>[number]>;
const namedParam = (p: TriggerParam | null): p is TriggerParam & { name: string } => !!p?.name;

// "Which button, in which screen, of which app" — the back-pointer a
// automation made from here carries, and the trail a link into the builder
// draws. Only ever a WHOLE reference: without the app's own id (the
// editor is mounted without one in a few tests and in the headless
// runtime) there is nothing to point at, and two thirds of a pointer is
// worse than none.
export function appRefOf(appId: string | null, definition: AppDefinition, nodeId: string | undefined): AppRef | null {
    const screenId = screenIdOfNode(definition, nodeId);
    if (!appId || !screenId || !nodeId) return null;
    return { appId, screenId, nodeId };
}

export function targetTriggerOf(action: AppAction | null, automations: WiredAutomation[] | null): AutomationTrigger | null {
    if (action?.kind !== 'run_automation' || !action.automationId) return null;
    return (automations || []).find((a) => a.id === action.automationId)?.definition?.trigger || null;
}

// The target automation's DECLARED input contract, when it has one:
// app_trigger → typed trigger.params; agent_call → schema properties.
export function paramMetaOf(targetTrigger: AutomationTrigger | null): ParamMetaByName | null {
    if (targetTrigger?.kind === 'app_trigger' && Array.isArray(targetTrigger.params)) {
        return Object.fromEntries(targetTrigger.params.filter(namedParam).map((p) => [
            p.name, { type: p.type || 'string', required: !!p.required, description: p.description || '' },
        ]));
    }
    if (targetTrigger?.kind === 'agent_call' && targetTrigger.parametersSchema?.properties) {
        const required = new Set<unknown>(Array.isArray(targetTrigger.parametersSchema.required) ? targetTrigger.parametersSchema.required : []);
        return Object.fromEntries(Object.entries(targetTrigger.parametersSchema.properties).map(([n, s]) => [
            n, { type: typeof s?.type === 'string' ? s.type : 'string', required: required.has(n), description: s?.description || '' },
        ]));
    }
    return null;
}

// Every action in the app, each labelled with how many OTHER components
// already run it — picking one here adopts that same object.
export function actionChoices(
    actions: Record<string, AppAction>,
    definition: AppDefinition,
    nodeId: string | undefined,
    titleFor: ((automationId?: string | null) => string | null) | null | undefined,
    t: TranslateFn,
) {
    return Object.entries(actions).map(([id, a]) => {
        const others = otherComponentsRunning(definition, id, nodeId).length;
        let suffix = '';
        if (others === 1) suffix = ` ${t('studio_apps_insp.wiring.also_used_one', '(also used by {count} other component)', { count: others })}`;
        else if (others) suffix = ` ${t('studio_apps_insp.wiring.also_used_many', '(also used by {count} other components)', { count: others })}`;
        return { id, label: `${describeAction(id, a, definition, titleFor, t)}${suffix}` };
    });
}

/** What switching an action to `kind` does; see onPickKind. */
export type KindSwitch =
    | { type: 'none' }
    | { type: 'sequence'; steps: unknown[]; dropsOnError: boolean }
    | { type: 'confirm' }
    | { type: 'replace' };

/**
 * Turning something into a flow KEEPS it as the first step rather than
 * replacing it — the old behaviour built a fresh default and the author's
 * work vanished. Turning a real flow back into one thing does destroy the
 * rest, so that direction asks first.
 */
export function kindSwitchOf(action: AppAction | null, kind: string): KindSwitch {
    if (!action || kind === action.kind) return { type: 'none' };
    if (kind === 'sequence') {
        const first = stepFromAction(action);
        // onSuccess becomes the steps that follow. onError has no equivalent
        // — a sequence ABORTS on a failed step — so it cannot come across,
        // and saying so beats dropping it in silence.
        const steps = [first, ...effectSteps(action?.onSuccess)].filter(Boolean);
        return { type: 'sequence', steps, dropsOnError: !!(action?.onError && Object.keys(action.onError).length) };
    }
    if (action.kind === 'sequence' && stepCount(action) > 1) return { type: 'confirm' };
    return { type: 'replace' };
}

/** The params a trigger DECLARES, or null when it declares no contract. */
function declaredParamsOf(trigger: AutomationTrigger | null | undefined): Array<{ name: string; type: string }> | null {
    if (trigger?.kind === 'agent_call' && trigger.parametersSchema?.properties) {
        return Object.keys(trigger.parametersSchema.properties).map((name) => ({ name, type: 'string' }));
    }
    if (trigger?.kind === 'app_trigger' && Array.isArray(trigger.params)) {
        return trigger.params.filter(namedParam).map((p) => ({ name: p.name, type: p.type || 'string' }));
    }
    return null;
}

function prefilledMapping(
    declared: Array<{ name: string; type: string }>,
    previous: Record<string, InputMapping>,
    formFields: FormFieldRef[],
    fieldNames: string[],
) {
    const firstFileField = formFields.find((f) => f.type === 'input_file')?.name || '';
    const mapping: Record<string, InputMapping> = {};
    for (const { name, type } of declared) {
        if (previous[name]) { mapping[name] = previous[name]; continue; }
        // A file param with no file input to point at used to commit
        // {kind:'field', name:''} — a hard validation error, so picking
        // the automation broke every later save with a message about a
        // field nobody had named. An empty static is a shape the schema
        // accepts and the author can fill in.
        if (type === 'file') {
            mapping[name] = firstFileField
                ? { kind: 'field', name: firstFileField }
                : { kind: 'static', value: '' };
        }
        else if (fieldNames.includes(name)) mapping[name] = { kind: 'field', name };
        else mapping[name] = { kind: 'static', value: '' };
    }
    return mapping;
}

/**
 * Apply a picked automation: id + param prefill from its declared contract —
 * agent_call's schema properties, or app_trigger's typed trigger.params
 * (file params snap to the first file-upload input of the enclosing form).
 */
export function withPickedAutomation(
    action: AppAction,
    automation: WiredAutomation,
    formFields: FormFieldRef[],
    fieldNames: string[],
): AppAction {
    const next: AppAction = { ...action, automationId: automation.id };
    const declared = declaredParamsOf(automation?.definition?.trigger);
    if (declared) {
        // Only the params the NEW automation declares survive. This used to
        // carry the previous automation's mapping across untouched, so
        // switching from an automation taking invoiceFile + amount to one taking
        // ticketId left three rows: two of them belonged to nothing, were
        // POSTed on every run, and looked identical to the real one.
        const mapping = prefilledMapping(declared, action.inputMapping || {}, formFields, fieldNames);
        if (Object.keys(mapping).length) next.inputMapping = mapping;
        else delete next.inputMapping;
    }
    return next;
}

/** The mapping with one parameter renamed, or null when the rename is refused. */
export function renamedMapping(current: Record<string, InputMapping>, oldName: string, newName: string) {
    // Renaming onto an existing parameter would silently delete it.
    if (!newName.trim() || (newName !== oldName && newName in current)) return null;
    const mapping: Record<string, InputMapping> = {};
    for (const [k, v] of Object.entries(current)) {
        mapping[k === oldName ? newName : k] = v;
    }
    return mapping;
}

export function withoutMapping(action: AppAction, param: string): AppAction {
    const mapping = { ...(action.inputMapping || {}) };
    delete mapping[param];
    const next: AppAction = { ...action };
    if (Object.keys(mapping).length) next.inputMapping = mapping;
    else delete next.inputMapping;
    return next;
}

/** The first free `param`, `param2`, `param3`… name. */
export function nextParamName(inputMapping: Record<string, InputMapping> | undefined) {
    const taken = new Set(Object.keys(inputMapping || {}));
    let name = 'param';
    let n = 1;
    while (taken.has(name)) name = `param${++n}`;
    return name;
}

export function withEffect(action: AppAction, slot: 'onSuccess' | 'onError', effect: ActionEffect | null): AppAction {
    const next: AppAction = { ...action };
    if (effect) next[slot] = effect;
    else delete next[slot];
    return next;
}

/** What the run endpoint answers, as far as the test panel reads it. */
type TestRunBody = { error?: string; code?: string; run?: { id?: unknown } } | null;

/*
 * "Test" is not a rehearsal.
 *
 * It POSTs to the same production run endpoint the Automations page uses, with
 * no dry-run flag — so an automation that e-mails customers e-mails them, and
 * one that writes rows writes them. The button said none of that; the only
 * caveat on screen ("static values only") rendered for app_trigger automations
 * alone and is about the payload, not the consequences. There is no dry-run
 * mode in the runner to fall back on, so the honest fix is to ask first.
 */
export async function startTestRun(automationId: string, payload: Record<string, unknown>, t: TranslateFn) {
    const r = await authFetch(`${API_BASE}/api/automation/${encodeURIComponent(automationId)}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ triggerPayload: payload }),
    });
    let body: TestRunBody = null;
    try { body = await r.json(); } catch (err) { logger.debug('empty body', err); }
    if (!r.ok) throw new Error(runStartRefusal(t, body) || body?.error || t('studio_apps_insp.wiring.run_failed', 'Run failed ({status})', { status: r.status }));
    // A 200 carries the finished run; a 202 says "still going" and has
    // no id yet, so the link then opens the automation's Runs tab instead
    // of claiming a run that cannot be addressed.
    const runId = typeof body?.run?.id === 'string' ? body.run.id : null;
    return { body, runId };
}
