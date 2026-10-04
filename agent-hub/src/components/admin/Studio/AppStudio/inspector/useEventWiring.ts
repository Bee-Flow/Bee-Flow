import { useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { defaultActionForKind } from './actionKindCatalog';
import { describeAction } from './actionLabels';
import {
    componentsShowingResult, effectSteps, eventRefsToAction, formNameOf, getFormFields,
    otherComponentsRunning, screenIdOfNode, stepCount, stepFromAction,
} from './actionRefs';
import type {
    ActionEffect, AppAction, AppDefinition, AppNode, AppRef, AppScreen, FormFieldRef, InputMapping,
    ParamMetaByName,
} from './appDefinition';
import { automationHref } from './AutomationTile';
import { alwaysSkipped, buildTestPayload } from './testPayload';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import toast from '../../../../shared/Toast';
import { useAutomationRows } from '../editor/automationTitles';
import { useScreenValues } from '../editor/ScreenValuesContext';
import { removeAction, setAction, setNodeEvent } from '../state/definitionOps';

/** One automation the picker has resolved, as far as this hook reads it. */
export interface WiredAutomation {
    id: string;
    title?: string;
    definition?: { trigger?: AutomationTrigger | null;[key: string]: unknown } | null;
    [key: string]: unknown;
}

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

/** One input the test run could NOT carry, and why (testPayload.js). */
export interface SkippedInput {
    param: string;
    field: string | null;
    reason: string;
}

/** The state of the test run: one shape, three moments. */
export interface EventWiringTest {
    status: 'running' | 'done' | 'error';
    body?: unknown;
    error?: string;
    skipped?: SkippedInput[];
    /** A 202 has no run to address yet, so the link opens the Runs tab instead. */
    runId?: string | null;
}

// The modules below are still JavaScript, and their `= null` / `= []` defaults
// are all TypeScript can see of those parameters. These state the contracts
// their own headers describe; they go away when they become TypeScript.
const defaultAction = defaultActionForKind as (
    kind: string,
    definition: AppDefinition | null | undefined,
    formFields?: FormFieldRef[],
) => AppAction;
const labelFor = describeAction as (
    id: string,
    action: AppAction,
    definition: AppDefinition | null | undefined,
    titleFor?: ((automationId?: string) => string | null) | null,
) => string;
const builderHref = automationHref as (
    automationId: string,
    appRef?: AppRef | null,
    query?: { view?: string | null; runId?: string | null },
) => string | null;
const structuralSkipsOf = alwaysSkipped as (args: {
    inputMapping?: Record<string, InputMapping> | null;
    formFields?: FormFieldRef[];
    paramMeta?: ParamMetaByName | null;
}) => SkippedInput[];
const testPayloadOf = buildTestPayload as (args: {
    inputMapping?: Record<string, InputMapping> | null;
    formFields?: FormFieldRef[];
    formValues?: Record<string, unknown> | null;
    paramMeta?: ParamMetaByName | null;
}) => { payload: Record<string, unknown>; skipped: SkippedInput[] };
const applyAction = setAction as (
    def: AppDefinition,
    actionIdOrNull: string | null,
    action: AppAction,
) => { def: AppDefinition; actionId: string | null };
const dropAction = removeAction as (def: AppDefinition, actionId: string | null) => AppDefinition;
const wireEvent = setNodeEvent as (
    def: AppDefinition,
    nodeId: string,
    event: string,
    actionIdOrNull: string | null,
) => AppDefinition;
// ScreenValuesContext.js seeds its context with null, which is all TypeScript
// reads of it. Null stays in the type — outside the editor there is no store.
const screenValuesStore = useScreenValues as () => {
    readForm: (formName: string | null) => Record<string, unknown> | null;
} | null;

export interface EventWiring {
    action: AppAction | null;
    actionId: string | null;
    /** The automation rows behind the tile; null until the shared cache answers. */
    automationRows: ReturnType<typeof useAutomationRows>;
    pickerOpen: boolean;
    setPickerOpen: Dispatch<SetStateAction<boolean>>;
    confirmDelete: boolean;
    setConfirmDelete: Dispatch<SetStateAction<boolean>>;
    test: EventWiringTest | null;
    setTest: Dispatch<SetStateAction<EventWiringTest | null>>;
    /** Id of the action being edited on the canvas as a flow; null when none is. */
    flowFor: string | null;
    setFlowFor: Dispatch<SetStateAction<string | null>>;
    /** The kind a flatten would switch TO, while the question is on screen. */
    confirmFlatten: string | null;
    setConfirmFlatten: Dispatch<SetStateAction<string | null>>;
    confirmTest: boolean;
    setConfirmTest: Dispatch<SetStateAction<boolean>>;
    screens: AppScreen[];
    appRef: AppRef | null;
    formFields: FormFieldRef[];
    formName: string | null;
    targetTrigger: AutomationTrigger | null;
    paramMetaByName: ParamMetaByName | null;
    /** Other components that run this action, by name. */
    sharedWith: string[];
    /** Components that SHOW this action's result. */
    resultShownBy: string[];
    choices: Array<{ id: string; label: string }>;
    /** What can never travel, known before anyone presses Test. */
    structuralSkips: SkippedInput[];
    mappingEntries: Array<[string, InputMapping]>;
    commitAction: (nextAction: AppAction) => void;
    onPickKind: (kind: string) => void;
    onSelectAction: (value: string | null) => void;
    onForkAction: () => void;
    onDeleteAction: () => void;
    requestDelete: () => void;
    onPickAutomation: (automation: WiredAutomation) => void;
    setMapping: (param: string, value: InputMapping) => void;
    renameMapping: (oldName: string, newName: string) => void;
    removeMapping: (param: string) => void;
    addMapping: () => void;
    setEffect: (slot: 'onSuccess' | 'onError', effect: ActionEffect | null) => void;
    runTest: () => Promise<void>;
}

export interface UseEventWiringOptions {
    /** Which event slot of `node` this is — one of NODE_EVENTS. */
    event: string;
    node: AppNode | null | undefined;
    definition: AppDefinition;
    onCommit: (definition: AppDefinition) => void;
    onTestActionResult?: ((actionId: string | null, body: unknown) => void) | null;
    automations: WiredAutomation[] | null;
    setAutomations: (automations: WiredAutomation[]) => void;
    /** Automation id → its title, for the action labels. */
    titleFor?: ((automationId?: string) => string | null) | null;
    /** Without it there is no whole appRef to point at — see below. */
    appId?: string | null;
}

/**
 * Open a builder deep link in a new tab.
 *
 * A new tab, not a navigation: the editor holds unsaved canvas state and a
 * half-typed inspector, and a test run is not worth losing them. Returns
 * whether the browser actually opened one — a blocked pop-up is a normal
 * outcome, and the result panel keeps the same link as an ordinary anchor so
 * the way to the run never depends on this succeeding.
 */
function openRunInBuilder(href: string | null) {
    if (!href) return false;
    try {
        return !!window.open(href, '_blank', 'noopener,noreferrer');
    } catch {
        return false;
    }
}

export const NEW_ACTION = '__new';

/**
 * One event slot's wiring, as a state machine: which action is on it, what
 * else in the app shares it, the edits that commit straight back into the
 * definition, and the test run. The markup that drives it is EventWiring in
 * ActionsSection.
 *
 * Every edit here commits immediately through onCommit — there is no draft to
 * lose, and no second copy of the action to keep in step.
 */
export default function useEventWiring({
    event, node, definition, onCommit, onTestActionResult, automations, setAutomations, titleFor, appId = null,
}: UseEventWiringOptions): EventWiring {
    const actions = definition?.actions || {};
    const actionId = typeof node?.[event] === 'string' ? node[event] as string : null;
    const action = actionId ? actions[actionId] : null;

    // The automation tile needs the step count and the solution, which live on the
    // SAME rows the canvas pill already fetched for its one word. Shared 60s
    // cache, one request — see editor/automationTitles.js.
    const automationRows = useAutomationRows(action?.kind === 'run_automation');

    const [pickerOpen, setPickerOpen] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [test, setTest] = useState<EventWiringTest | null>(null);
    const [flowFor, setFlowFor] = useState<string | null>(null);      // action id being edited on the canvas
    const [confirmFlatten, setConfirmFlatten] = useState<string | null>(null);  // the kind being switched TO

    const screens = definition?.screens || [];
    // "Which button, in which screen, of which app" — the back-pointer a
    // automation made from here carries, and the trail a link into the builder
    // draws. Only ever a WHOLE reference: without the app's own id (the
    // editor is mounted without one in a few tests and in the headless
    // runtime) there is nothing to point at, and two thirds of a pointer is
    // worse than none.
    const appRef = useMemo<AppRef | null>(() => {
        const screenId = screenIdOfNode(definition, node?.id);
        if (!appId || !screenId || !node?.id) return null;
        return { appId, screenId, nodeId: node.id };
    }, [appId, definition, node?.id]);
    const formFields = useMemo(() => getFormFields(definition, node), [definition, node]);
    const fieldNames = useMemo(() => formFields.map((f) => f.name), [formFields]);

    // The target automation's DECLARED input contract, when it has one:
    // app_trigger → typed trigger.params; agent_call → schema properties.
    const targetTrigger = useMemo<AutomationTrigger | null>(() => {
        if (action?.kind !== 'run_automation' || !action.automationId) return null;
        return (automations || []).find((a) => a.id === action.automationId)?.definition?.trigger || null;
    }, [action, automations]);
    const paramMetaByName = useMemo<ParamMetaByName | null>(() => {
        if (targetTrigger?.kind === 'app_trigger' && Array.isArray(targetTrigger.params)) {
            return Object.fromEntries(targetTrigger.params.filter((p) => p?.name).map((p) => [
                p!.name, { type: p!.type || 'string', required: !!p!.required, description: p!.description || '' },
            ]));
        }
        if (targetTrigger?.kind === 'agent_call' && targetTrigger.parametersSchema?.properties) {
            const required = new Set<unknown>(Array.isArray(targetTrigger.parametersSchema.required) ? targetTrigger.parametersSchema.required : []);
            return Object.fromEntries(Object.entries(targetTrigger.parametersSchema.properties).map(([n, s]) => [
                n, { type: typeof s?.type === 'string' ? s.type : 'string', required: required.has(n), description: s?.description || '' },
            ]));
        }
        return null;
    }, [targetTrigger]);

    // Everything else that runs this action, or shows what it produced.
    const sharedWith = useMemo(
        () => (actionId ? otherComponentsRunning(definition, actionId, node?.id) : []),
        [definition, actionId, node?.id],
    );
    const resultShownBy = useMemo(
        () => (actionId ? componentsShowingResult(definition, actionId) : []),
        [definition, actionId],
    );

    // Every action in the app, each labelled with how many OTHER components
    // already run it — picking one here adopts that same object.
    const choices = useMemo(() => Object.entries(actions).map(([id, a]) => {
        const others = otherComponentsRunning(definition, id, node?.id).length;
        const suffix = others ? ` (also used by ${others} other component${others === 1 ? '' : 's'})` : '';
        return { id, label: `${labelFor(id, a, definition, titleFor)}${suffix}` };
    }), [actions, definition, node?.id, titleFor]);

    const commitAction = (nextAction: AppAction) => {
        const { def } = applyAction(definition, actionId, nextAction);
        if (def !== definition) onCommit(def);
    };

    /**
     * Change what this action IS.
     *
     * Turning something into a flow KEEPS it as the first step rather than
     * replacing it — the old behaviour built a fresh default and the author's
     * work vanished. Turning a real flow back into one thing does destroy the
     * rest, so that direction asks first.
     */
    const onPickKind = (kind: string) => {
        if (!action || kind === action.kind) return;
        if (kind === 'sequence') {
            const first = stepFromAction(action);
            // onSuccess becomes the steps that follow. onError has no equivalent
            // — a sequence ABORTS on a failed step — so it cannot come across,
            // and saying so beats dropping it in silence.
            const steps = [first, ...effectSteps(action?.onSuccess)].filter(Boolean);
            commitAction({ kind: 'sequence', steps });
            if (action?.onError && Object.keys(action.onError).length) {
                toast.info('The "on error" part could not come across — a flow stops at the step that fails.');
            }
            setFlowFor(actionId);
            return;
        }
        if (action.kind === 'sequence' && stepCount(action) > 1) {
            setConfirmFlatten(kind);
            return;
        }
        commitAction(defaultAction(kind, definition, formFields));
    };

    const onSelectAction = (value: string | null) => {
        if (!node) return;
        if (value === NEW_ACTION) {
            const { def: withAction, actionId: newId } = applyAction(definition, null, defaultAction('run_automation', definition));
            onCommit(wireEvent(withAction, node.id, event, newId));
            return;
        }
        const next = wireEvent(definition, node.id, event, value || null);
        if (next !== definition) onCommit(next);
    };

    // Give THIS component its own copy, so the edits that follow stop reaching
    // the components that shared the original.
    const onForkAction = () => {
        if (!action || !node) return;
        const copy = JSON.parse(JSON.stringify(action)) as AppAction;
        const { def: withCopy, actionId: newId } = applyAction(definition, null, copy);
        onCommit(wireEvent(withCopy, node.id, event, newId));
    };

    const onDeleteAction = () => {
        setConfirmDelete(false);
        let next = dropAction(definition, actionId);
        for (const ref of eventRefsToAction(next, actionId)) {
            next = wireEvent(next, ref.nodeId, ref.event, null);
        }
        if (next !== definition) onCommit(next);
    };

    // Nothing else points at it → nothing to warn about, so don't stop the user.
    const requestDelete = () => {
        if (sharedWith.length || resultShownBy.length) setConfirmDelete(true);
        else onDeleteAction();
    };

    /**
     * Apply a picked automation: id + param prefill from its declared contract —
     * agent_call's schema properties, or app_trigger's typed trigger.params
     * (file params snap to the first file-upload input of the enclosing form).
     */
    const onPickAutomation = (automation: WiredAutomation) => {
        setPickerOpen(false);
        if (!action) return;
        if (automations && !automations.some((a) => a.id === automation.id)) {
            setAutomations([...automations, automation]);
        }
        const next: AppAction = { ...action, automationId: automation.id };
        const trigger = automation?.definition?.trigger;
        let declared: Array<{ name: string; type: string }> | null = null;
        if (trigger?.kind === 'agent_call' && trigger.parametersSchema?.properties) {
            declared = Object.keys(trigger.parametersSchema.properties).map((name) => ({ name, type: 'string' }));
        } else if (trigger?.kind === 'app_trigger' && Array.isArray(trigger.params)) {
            declared = trigger.params.filter((p) => p?.name).map((p) => ({ name: p!.name as string, type: p!.type || 'string' }));
        }
        if (declared) {
            const firstFileField = formFields.find((f) => f.type === 'input_file')?.name || '';
            // Only the params the NEW automation declares survive. This used to
            // carry the previous automation's mapping across untouched, so
            // switching from an automation taking invoiceFile + amount to one taking
            // ticketId left three rows: two of them belonged to nothing, were
            // POSTed on every run, and looked identical to the real one.
            const previous = action.inputMapping || {};
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
            if (Object.keys(mapping).length) next.inputMapping = mapping;
            else delete next.inputMapping;
        }
        commitAction(next);
    };

    const mappingEntries = Object.entries(action?.inputMapping || {});

    const setMapping = (param: string, value: InputMapping) => {
        if (!action) return;
        commitAction({ ...action, inputMapping: { ...(action.inputMapping || {}), [param]: value } });
    };
    const renameMapping = (oldName: string, newName: string) => {
        if (!action) return;
        const current = action.inputMapping || {};
        // Renaming onto an existing parameter would silently delete it.
        if (!newName.trim() || (newName !== oldName && newName in current)) return;
        const mapping: Record<string, InputMapping> = {};
        for (const [k, v] of Object.entries(current)) {
            mapping[k === oldName ? newName : k] = v;
        }
        commitAction({ ...action, inputMapping: mapping });
    };
    const removeMapping = (param: string) => {
        if (!action) return;
        const mapping = { ...(action.inputMapping || {}) };
        delete mapping[param];
        const next: AppAction = { ...action };
        if (Object.keys(mapping).length) next.inputMapping = mapping;
        else delete next.inputMapping;
        commitAction(next);
    };
    const addMapping = () => {
        if (!action) return;
        const taken = new Set(Object.keys(action.inputMapping || {}));
        let name = 'param';
        let n = 1;
        while (taken.has(name)) name = `param${++n}`;
        setMapping(name, fieldNames.length ? { kind: 'field', name: fieldNames[0] } : { kind: 'static', value: '' });
    };

    const setEffect = (slot: 'onSuccess' | 'onError', effect: ActionEffect | null) => {
        if (!action) return;
        const next: AppAction = { ...action };
        if (effect) next[slot] = effect;
        else delete next[slot];
        commitAction(next);
    };

    /*
     * "Test" is not a rehearsal.
     *
     * It POSTs to the same production run endpoint the Automations page uses, with
     * no dry-run flag — so an automation that e-mails customers e-mails them, and
     * one that writes rows writes them. The button said none of that; the only
     * caveat on screen ("static values only") rendered for app_trigger automations
     * alone and is about the payload, not the consequences. There is no dry-run
     * mode in the runner to fall back on, so the honest fix is to ask first.
     *
     * ── It now tests with WHAT IS ON SCREEN ────────────────────────────────
     *
     * It used to send only the mapping's STATIC values, so every parameter fed
     * by a form field arrived as `undefined`, dropped out of the JSON, and the
     * automation started with an empty `trigger.output`. The run then looked
     * exactly like a broken step. The live values come from the canvas through
     * editor/ScreenValuesContext; which of them may travel — and which cannot,
     * file fields above all — is decided in testPayload.js, and whatever is
     * left out is SAID rather than silently missing.
     */
    const [confirmTest, setConfirmTest] = useState(false);

    // The live values of the form this action sits in. A ref-backed store, so
    // reading it costs nothing and typing in the canvas does not re-render the
    // inspector; null outside the editor (the run page has no inspector).
    const screenValues = screenValuesStore();
    const formName = useMemo(() => formNameOf(definition, node), [definition, node]);

    // What can NEVER travel, known without the live values — so it can be said
    // under the button instead of after the run.
    const structuralSkips = useMemo(() => structuralSkipsOf({
        inputMapping: action?.inputMapping, formFields, paramMeta: paramMetaByName,
    }), [action?.inputMapping, formFields, paramMetaByName]);

    const runTest = async () => {
        setConfirmTest(false);
        if (!action?.automationId) return;
        setTest({ status: 'running' });
        // Outside the try: a failed run still has to be able to say what it
        // was not carrying — that is often the reason it failed.
        const { payload, skipped } = testPayloadOf({
            inputMapping: action.inputMapping,
            formFields,
            formValues: screenValues ? screenValues.readForm(formName) : null,
            paramMeta: paramMetaByName,
        });
        try {
            const r = await authFetch(`${API_BASE}/api/automation/${encodeURIComponent(action.automationId)}/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ triggerPayload: payload }),
            });
            let body: { error?: string; run?: { id?: unknown } } | null = null;
            try { body = await r.json(); } catch { /* empty body */ }
            if (!r.ok) throw new Error(body?.error || `Run failed (${r.status})`);
            // A 200 carries the finished run; a 202 says "still going" and has
            // no id yet, so the link then opens the automation's Runs tab instead
            // of claiming a run that cannot be addressed.
            const runId = typeof body?.run?.id === 'string' ? body.run.id : null;
            setTest({ status: 'done', body, skipped, runId });
            onTestActionResult?.(actionId, body);
            openRunInBuilder(builderHref(action.automationId, appRef, { view: 'runs', runId }));
        } catch (e) {
            setTest({ status: 'error', error: e instanceof Error ? e.message : String(e), skipped, runId: null });
        }
    };
    return {
        action,
        actionId,
        automationRows,
        pickerOpen, setPickerOpen,
        confirmDelete, setConfirmDelete,
        test, setTest,
        flowFor, setFlowFor,
        confirmFlatten, setConfirmFlatten,
        confirmTest, setConfirmTest,
        screens,
        appRef,
        formFields,
        formName,
        targetTrigger,
        paramMetaByName,
        sharedWith,
        resultShownBy,
        choices,
        structuralSkips,
        mappingEntries,
        commitAction,
        onPickKind,
        onSelectAction,
        onForkAction,
        onDeleteAction,
        requestDelete,
        onPickAutomation,
        setMapping,
        renameMapping,
        removeMapping,
        addMapping,
        setEffect,
        runTest,
    };
}
