import { useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { defaultActionForKind } from './actionKindCatalog';
import { componentsShowingResult, eventRefsToAction, formNameOf, getFormFields, otherComponentsRunning } from './actionRefs';
import type {
    ActionEffect, AppAction, AppDefinition, AppNode, AppRef, AppScreen, FormFieldRef, InputMapping,
    ParamMetaByName,
} from './appDefinition';
import { automationHref } from './AutomationTile';
import { alwaysSkipped, buildTestPayload } from './testPayload';
import toast from '@/components/shared/Toast';
import useTranslation from '@/hooks/useTranslation';
import { useAutomationRows } from '../editor/automationTitles';
import { useScreenValues } from '../editor/ScreenValuesContext';
import { removeAction, setAction, setNodeEvent } from '../state/definitionOps';
import {
    actionChoices, appRefOf, kindSwitchOf, nextParamName, paramMetaOf, renamedMapping, startTestRun, targetTriggerOf,
    withEffect, withPickedAutomation, withoutMapping, type AutomationTrigger, type WiredAutomation,
} from './eventWiring.helpers';

export type { WiredAutomation } from './eventWiring.helpers';

/** One input the test run could NOT carry, and why (testPayload.js). */
export interface SkippedInput {
    param: string;
    field: string | null;
    reason: string;
}

/** The state of the test run: one shape, three moments. */
interface EventWiringTest {
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
    titleFor?: ((automationId?: string | null) => string | null) | null;
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
    const { t } = useTranslation();
    const actions = useMemo(() => definition?.actions || {}, [definition?.actions]);
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
    // "Which button, in which screen, of which app": see appRefOf.
    const appRef = useMemo<AppRef | null>(() => appRefOf(appId, definition, node?.id), [appId, definition, node?.id]);
    const formFields = useMemo(() => getFormFields(definition, node), [definition, node]);
    const fieldNames = useMemo(() => formFields.map((f) => f.name), [formFields]);

    const targetTrigger = useMemo(() => targetTriggerOf(action, automations), [action, automations]);
    const paramMetaByName = useMemo(() => paramMetaOf(targetTrigger), [targetTrigger]);

    // Everything else that runs this action, or shows what it produced.
    const sharedWith = useMemo(
        () => (actionId ? otherComponentsRunning(definition, actionId, node?.id) : []),
        [definition, actionId, node?.id],
    );
    const resultShownBy = useMemo(
        () => (actionId ? componentsShowingResult(definition, actionId) : []),
        [definition, actionId],
    );

    const choices = useMemo(
        () => actionChoices(actions, definition, node?.id, titleFor, t),
        [actions, definition, node?.id, titleFor, t],
    );

    const commitAction = (nextAction: AppAction) => {
        const { def } = applyAction(definition, actionId, nextAction);
        if (def !== definition) onCommit(def);
    };

    // Change what this action IS: see kindSwitchOf.
    const onPickKind = (kind: string) => {
        const change = kindSwitchOf(action, kind);
        if (change.type === 'sequence') {
            commitAction({ kind: 'sequence', steps: change.steps });
            if (change.dropsOnError) {
                toast.info(t('studio_apps_insp.wiring.on_error_lost', 'The "on error" part could not come across — a flow stops at the step that fails.'));
            }
            setFlowFor(actionId);
        } else if (change.type === 'confirm') {
            setConfirmFlatten(kind);
        } else if (change.type === 'replace') {
            commitAction(defaultAction(kind, definition, formFields));
        }
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

    // Apply a picked automation: see withPickedAutomation.
    const onPickAutomation = (automation: WiredAutomation) => {
        setPickerOpen(false);
        if (!action) return;
        if (automations && !automations.some((a) => a.id === automation.id)) {
            setAutomations([...automations, automation]);
        }
        commitAction(withPickedAutomation(action, automation, formFields, fieldNames));
    };

    const mappingEntries = Object.entries(action?.inputMapping || {});

    const setMapping = (param: string, value: InputMapping) => {
        if (!action) return;
        commitAction({ ...action, inputMapping: { ...(action.inputMapping || {}), [param]: value } });
    };
    const renameMapping = (oldName: string, newName: string) => {
        if (!action) return;
        const mapping = renamedMapping(action.inputMapping || {}, oldName, newName);
        if (mapping) commitAction({ ...action, inputMapping: mapping });
    };
    const removeMapping = (param: string) => {
        if (!action) return;
        commitAction(withoutMapping(action, param));
    };
    const addMapping = () => {
        if (!action) return;
        setMapping(nextParamName(action.inputMapping), fieldNames.length ? { kind: 'field', name: fieldNames[0] } : { kind: 'static', value: '' });
    };

    const setEffect = (slot: 'onSuccess' | 'onError', effect: ActionEffect | null) => {
        if (!action) return;
        commitAction(withEffect(action, slot, effect));
    };

    /*
     * "Test" is not a rehearsal (see startTestRun): it asks first.
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
        // Outside the try: a failed run can still say what it was not carrying.
        const { payload, skipped } = testPayloadOf({
            inputMapping: action.inputMapping,
            formFields,
            formValues: screenValues ? screenValues.readForm(formName) : null,
            paramMeta: paramMetaByName,
        });
        try {
            const { body, runId } = await startTestRun(action.automationId, payload, t);
            setTest({ status: 'done', body, skipped, runId });
            onTestActionResult?.(actionId, body);
            openRunInBuilder(automationHref(action.automationId, appRef, { view: 'runs', runId }));
        } catch (e) {
            setTest({ status: 'error', error: e instanceof Error ? e.message : String(e), skipped, runId: null });
        }
    };
    return {
        action, actionId, automationRows,
        pickerOpen, setPickerOpen, confirmDelete, setConfirmDelete, test, setTest,
        flowFor, setFlowFor, confirmFlatten, setConfirmFlatten, confirmTest, setConfirmTest,
        screens, appRef, formFields, formName, targetTrigger, paramMetaByName,
        sharedWith, resultShownBy, choices, structuralSkips, mappingEntries,
        commitAction, onPickKind, onSelectAction, onForkAction, onDeleteAction, requestDelete, onPickAutomation,
        setMapping, renameMapping, removeMapping, addMapping, setEffect, runTest,
    };
}
