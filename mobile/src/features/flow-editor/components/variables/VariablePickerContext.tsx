/**
 * What the node editor knows about the data upstream of the step it edits —
 * its groups, the sample root they resolve against and the step names — and
 * the one picker sheet every field opens. The web's VariablePickerContext
 * (agent-hub `Builder/mapping/VariablePickerContext.jsx`) plus its "active
 * field": the last field that had focus, so a tap in the Input tab inserts
 * where the author was typing, as a click in the web's Input column does.
 *
 * Outside a provider (a field rendered on its own, a test) `enabled` is
 * false and the fields hide their insert button rather than offer a picker
 * with nothing in it.
 */

import React, { createContext, useContext, useRef, useState, type ReactNode } from 'react';

import type { StepLabelMap, VariableGroup } from '@/features/flow-editor/bindings';

import { VariablePickerSheet, type PickRequest } from './VariablePickerSheet';

export type { PickRequest } from './VariablePickerSheet';

/** A field that can take a picked path: what it is called, and how it inserts. */
export interface ActiveField {
    label: string;
    insert: (path: string) => void;
}

export interface VariablePickerValue {
    enabled: boolean;
    groups: readonly VariableGroup[];
    sampleRoot: unknown;
    stepLabelById: StepLabelMap;
    /** Step id → type, for the colour of a reference's pill. */
    stepTypeById: Map<string, string> | null;
    /** The step editor shows Simple (not All options): no formula switch on a plain value. */
    simple: boolean;
    open: (request: PickRequest) => void;
    /** A field gained focus (or, with null, the one that had it went away). */
    focus: (field: ActiveField | null) => void;
    /** This field went away: if it is still the active one, nothing is. */
    release: (field: ActiveField) => void;
    /** The last field that had focus, read at the moment of a tap. */
    activeField: () => ActiveField | null;
}

const NONE: VariablePickerValue = {
    enabled: false,
    groups: [],
    sampleRoot: null,
    stepLabelById: null,
    stepTypeById: null,
    simple: false,
    open: () => undefined,
    focus: () => undefined,
    release: () => undefined,
    activeField: () => null,
};

const Context = createContext<VariablePickerValue>(NONE);

export function useVariablePicker(): VariablePickerValue {
    return useContext(Context);
}

export function VariablePickerProvider({
    groups,
    sampleRoot,
    stepLabelById,
    stepTypeById = null,
    simple,
    children,
}: {
    groups: readonly VariableGroup[];
    sampleRoot: unknown;
    stepLabelById: StepLabelMap;
    stepTypeById?: Map<string, string> | null;
    simple?: boolean;
    children: ReactNode;
}) {
    // A scoped provider (a list's current row) keeps the step types and mode above it.
    const outer = useContext(Context);
    const [request, setRequest] = useState<PickRequest | null>(null);
    const active = useRef<ActiveField | null>(null);
    const value: VariablePickerValue = {
        enabled: true,
        groups,
        sampleRoot,
        stepLabelById,
        stepTypeById: stepTypeById ?? outer.stepTypeById,
        simple: simple ?? outer.simple,
        open: setRequest,
        // A scoped provider (a list's current row) tells the one above too:
        // the Input tab reads the step editor's, and a tap there must land
        // in the field inside the list the author was typing in.
        focus: (field) => {
            active.current = field;
            outer.focus(field);
        },
        release: (field) => {
            if (active.current === field) active.current = null;
            outer.release(field);
        },
        activeField: () => active.current,
    };
    return (
        <Context.Provider value={value}>
            {children}
            <VariablePickerSheet request={request} groups={groups} sampleRoot={sampleRoot} onClose={() => setRequest(null)} />
        </Context.Provider>
    );
}
