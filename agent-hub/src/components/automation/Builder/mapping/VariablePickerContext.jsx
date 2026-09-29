import React, { createContext, useContext } from 'react';

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
const VariablePickerContext = createContext({ groups: [], previewSample: null, stepLabelById: new Map(), stepTypeById: new Map() });

export function VariablePickerProvider({ groups, previewSample, stepLabelById, stepTypeById, children }) {
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
        }),
        [groups, previewSample, stepLabelById, stepTypeById],
    );
    return (
        <VariablePickerContext.Provider value={value}>
            {children}
        </VariablePickerContext.Provider>
    );
}

export function useVariablePickerContext() {
    return useContext(VariablePickerContext);
}
