/**
 * Everything the node editor shows about one step, from the open routine's
 * draft: the step's form (useStepForm), what flows into it (the upstream
 * groups, with real output from this screen's last test and every pin laid
 * over the samples), its findings, where it sits in the run order, and the
 * "Test step" run. The web's useNodeDetailData + NodeDetailView plumbing.
 *
 * The routine's last test run is shared with the build screen
 * (components/run/testRunStore): a dry run started there gives this step
 * real upstream output and its own row, and a Test here colours the card.
 */

import { useState } from 'react';
import { Keyboard } from 'react-native';
import { useStore } from 'zustand';

import type { AutomationRunStep } from '@/features/automations';
import type { StepRunResult } from '@/features/flow-editor/api';
import { buildRealOutputMap, buildSampleRoot, type RunStepRow, type VariableGroup } from '@/features/flow-editor/bindings';
import { useCatalog, useDraftState, useStepRun, type FlowDraft } from '@/features/flow-editor/hooks';
import { sectionsWithErrors, type FlowDefinition, type FlowPosition, type StepIssues } from '@/features/flow-editor/model';

import { isNestedAddress, positionAt, upstreamGroupsAt } from './address';
import { useFormMode } from './formMode';
import { renameAcross } from './renameAcross';
import { stepLabelsInScope } from './stepLabels';
import { useStepForm, type StepFormState } from './useStepForm';
import type { StepEditorContext } from '../editors/types';
import { runInputFor } from '../run/runMenu';
import { recordStepRun, testRunStoreFor } from '../run/testRunStore';

/**
 * Some fields write on blur (names, case names, params). Test sits outside
 * the form, so pressing it never blurred the field being typed in, and the
 * test ran the step as it was before that edit. Close the keyboard first —
 * the field blurs and commits — and run on the next tick, from the store.
 */
function testAfterCommit(run: () => void): void {
    if (!Keyboard.isVisible()) {
        run();
        return;
    }
    Keyboard.dismiss();
    setTimeout(run, 60);
}

const NO_ISSUES: StepIssues = { errors: [], warnings: [] };
const EMPTY: FlowDefinition = { steps: [], edges: [] };

export interface NodeEditorModel {
    form: StepFormState;
    ctx: StepEditorContext;
    groups: VariableGroup[];
    position: FlowPosition;
    stepIssues: StepIssues;
    /** "Test step" runs one step of the flow; a step held in a loop or a branch has no run of its own. */
    canTest: boolean;
    /** This screen's last test run of the step. */
    run: StepRunResult | null;
    runStep: AutomationRunStep | null;
    testStep: () => void;
    testing: boolean;
    testError: Error | null;
    setMode: (mode: StepEditorContext['mode']) => void;
}

function runStepOf(run: StepRunResult | null, shared: readonly AutomationRunStep[], stepId: string): AutomationRunStep | null {
    const own = run ? run.stepRecord ?? run.steps.find((s) => s.stepId === stepId && !s.parentStepId) : null;
    return own ?? shared.find((s) => s.stepId === stepId && !s.parentStepId) ?? null;
}

/** `stepId` is the step's id, or a held step's address; `focusSection` the section a finding opened it at. */
/** `flowlet`: the flowlet the step lives in — `flow` is then scoped to it (useFlowletDraft), and it cannot be test-run alone. */
export function useNodeEditor(flow: FlowDraft, stepId: string, focusSection: string | null = null, flowlet: string | null = null): NodeEditorModel {
    const store = flow.store;
    const definition = useDraftState(store, (s) => s.definition) ?? EMPTY;
    const locked = useDraftState(store, (s) => s.locked);
    const stepIssues = useDraftState(store, (s) => s.issuesByStep.get(stepId)) ?? NO_ISSUES;
    const form = useStepForm(store, stepId);
    const catalog = useCatalog().data ?? null;
    const [mode, setMode] = useFormMode();
    const [run, setRun] = useState<StepRunResult | null>(null);
    const [testError, setTestError] = useState<Error | null>(null);
    const shared = useStore(testRunStoreFor(flow.key), (s) => s.rows);
    const stepRun = useStepRun(flow.key, {
        onSuccess: (result) => {
            setRun(result);
            setTestError(null);
            recordStepRun(flow.key, stepId, 'only', result);
        },
        onError: setTestError,
    });

    const real = buildRealOutputMap(definition, shared as unknown as RunStepRow[]);
    const groups = upstreamGroupsAt(definition, stepId, catalog, real);
    const ctx: StepEditorContext = {
        flowKey: flow.key,
        definition,
        stepAddress: stepId,
        flowlet,
        catalog,
        groups,
        sampleRoot: buildSampleRoot(groups),
        stepLabelById: stepLabelsInScope(definition, groups),
        errorSections: sectionsWithErrors(form.step, stepIssues),
        focusSection,
        mode,
        disabled: locked,
        renameField: (base, from, to) => renameAcross(flow.store, base, from, to),
    };
    return {
        form,
        ctx,
        groups,
        position: positionAt(definition, stepId),
        stepIssues,
        canTest: !flowlet && !isNestedAddress(stepId) && form.step?.type !== 'note',
        run,
        runStep: runStepOf(run, shared, stepId),
        // Enters with the trigger's saved sample, as the web's executeStep does.
        testStep: () => testAfterCommit(() => stepRun.mutate({ stepId, mode: 'only', ...runInputFor(flow.store.getState().definition) })),
        testing: stepRun.isPending,
        testError,
        setMode,
    };
}
