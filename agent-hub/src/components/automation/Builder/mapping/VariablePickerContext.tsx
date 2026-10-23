import React, { createContext, useContext } from 'react';
import type { FlowDefinition } from '../flow/types';
import type { Group } from './upstream/upstream.types';

export interface VariablePickerValue {
    groups: Group[];
    previewSample: unknown;
    stepLabelById: Map<string, string>;
    stepTypeById: Map<string, string | undefined>;
    definition: FlowDefinition | null;
}

interface VariablePickerProviderProps {
    groups?: Group[] | null;
    previewSample?: unknown;
    stepLabelById?: Map<string, string> | null;
    stepTypeById?: Map<string, string | undefined> | null;
    definition?: FlowDefinition | null;
    children?: React.ReactNode;
}

/**
 * Carries the upstream variable groups + merged sample-root tree from the
 * StepInspector down to BindingField/TemplateField without each settings
 * subcomponent having to thread `groups` through its own props. Lets the
 * per-field {} button open a VariablePicker that already knows what's
 * available — no parent coordination needed.
 *
 * Default empty so the fields render a graceful "no upstream variables
 * yet" message when used outside a provider.
 */
const VariablePickerContext = createContext<VariablePickerValue>({ groups: [], previewSample: null, stepLabelById: new Map(), stepTypeById: new Map(), definition: null });

export function VariablePickerProvider({ groups, previewSample, stepLabelById, stepTypeById, definition = null, children }: VariablePickerProviderProps) {
    const value = React.useMemo(
        () => ({
            groups: groups || [],
            previewSample: previewSample || null,
            // id → human label map, so BindingField/TemplateField can render
            // refs as chips showing the step name instead of the raw id.
            stepLabelById: stepLabelById || new Map(),
            // id → step type, so a reference pill can wear its step's family
            // colour (refEditorDom.pillTint).
            stepTypeById: stepTypeById || new Map(),
            // The graph, so a list picked from a flatten names its item (listNounKey).
            definition,
        }),
        [groups, previewSample, stepLabelById, stepTypeById, definition],
    );
    return (
        <VariablePickerContext.Provider value={value}>
            {children}
        </VariablePickerContext.Provider>
    );
}

export function useVariablePickerContext(): VariablePickerValue {
    return useContext(VariablePickerContext);
}
