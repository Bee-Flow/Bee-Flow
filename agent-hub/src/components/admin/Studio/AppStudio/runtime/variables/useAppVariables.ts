/**
 * The run surface's `vars`: the declared variables seeded with their defaults, and the
 * schema 3 keys of a declaration (shared/appDefinition/variableScopes.mjs):
 *
 *   persist   a signed-in viewer's kept values are read once at mount (persistKey, from the
 *             run page; the editor and a public page pass none) and written back on change.
 *   scope     a screen variable goes back to its default when another screen opens: at the
 *             navigate itself when the run moves (so a step after the navigate writes the new
 *             screen's value), else when the screen id changes (the shell's nav, a deep link).
 *   derived   worked out over the whole scope on every render that changes what it reads,
 *             and per step by `deriveVars` (the runner's step scope): a write to one does nothing.
 *
 * An app that uses none of it gets back the same state and the same callbacks as before.
 */
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { reconcileVariableDefaults, seedVariableDefaults } from '../appVariables';
import { applyDerivedVariables, hasDerivedVariables, persistedVariables, resetScreenVariables, screenVariableNames } from '@shared/appDefinition/variableScopes.mjs';
import { buildScope, type ExpressionScope } from '../RuntimeContext';
import type { ActionState, Vars } from '../actionRunner/core';
import type { NavigateFn, RunnerDefinition } from '../actionRunner/runnerContext';
import type { DataState } from '../DataContext';
import { readPersistedVariables, writePersistedVariables } from './persistedVariables';

export interface AppVariablesInputs {
    /** Where a viewer's kept values live (app, viewer); null = nothing is kept. */
    persistKey?: string | null;
    actionState: ActionState;
    dataState?: DataState | null;
    currentUser?: unknown;
    forms?: Record<string, unknown> | null;
    screen?: Record<string, unknown> | null;
    onNavigate?: NavigateFn | null;
}

export interface AppVariables {
    /** The values formulas read: the live state with every derived variable worked out. */
    vars: Vars;
    setVars: Dispatch<SetStateAction<Vars>>;
    /** A step scope's `vars` with the derived variables worked out again; null when none is declared. */
    deriveVars: ((scope: ExpressionScope) => Vars) | null;
    /** onNavigate, resetting the screen variables first when the run moves to another screen. */
    onNavigate: NavigateFn | null | undefined;
}

/**
 * Fold a change in the DECLARATIONS into the live bag, keyed on a signature of the
 * declarations only (Canvas passes a new definition object on every inspector keystroke;
 * definitionOps keeps `variables` by reference across every other edit).
 */
function useDeclaredVariables(definition: RunnerDefinition | null | undefined, persistKey: string | null) {
    // SEEDED from definition.variables, so a records binding filtered on `vars.status` filters
    // on the FIRST paint; a viewer's kept values land on top.
    const [vars, setVars] = useState<Vars>(() => ({
        ...(seedVariableDefaults(definition?.variables) as Vars),
        ...readPersistedVariables(persistKey, definition?.variables),
    }));
    const declSignature = useMemo(
        () => JSON.stringify(((definition?.variables || []) as Array<{ name?: unknown; type?: unknown; default?: unknown }>)
            .map((v) => [v.name, v.type, v.default])),
        [definition?.variables],
    );
    const prevDeclsRef = useRef(definition?.variables || []);
    const reconcileDecls = useEffectEvent(() => {
        const next = definition?.variables || [];
        setVars((prev) => reconcileVariableDefaults(prev, prevDeclsRef.current, next));
        prevDeclsRef.current = next;
    });
    useEffect(() => { reconcileDecls(); }, [declSignature]);
    return [vars, setVars] as const;
}

/** Screen variables back at their default when another screen opens. */
function useScreenReset(definition: RunnerDefinition | null | undefined, screenId: unknown, setVars: AppVariables['setVars'], onNavigate: NavigateFn | null | undefined) {
    const variables = definition?.variables;
    const hasScreenVars = screenVariableNames(variables).length > 0;
    const declared = useRef(variables);
    useLayoutEffect(() => { declared.current = variables; });
    const reset = useCallback(() => { setVars((prev) => resetScreenVariables(prev, declared.current)); }, [setVars]);
    // The screen a navigate already reset for: the effect below then leaves it alone.
    const resetFor = useRef<unknown>(undefined);
    const shown = useRef(screenId);
    useLayoutEffect(() => {
        if (Object.is(shown.current, screenId)) return;
        shown.current = screenId;
        const alreadyReset = resetFor.current !== undefined && Object.is(resetFor.current, screenId);
        resetFor.current = undefined;
        if (hasScreenVars && !alreadyReset) reset();
    }, [screenId, hasScreenVars, reset]);
    return useMemo<NavigateFn | null | undefined>(() => {
        if (!hasScreenVars || !onNavigate) return onNavigate;
        return (target, params) => {
            if (!Object.is(target, shown.current)) {
                resetFor.current = target;
                reset();
            }
            onNavigate(target, params);
        };
    }, [hasScreenVars, onNavigate, reset]);
}

export default function useAppVariables(definition: RunnerDefinition | null | undefined, inputs: AppVariablesInputs): AppVariables {
    const { persistKey = null, actionState, dataState = null, currentUser = null, forms = null, screen = null } = inputs;
    const [vars, setVars] = useDeclaredVariables(definition, persistKey);
    const onNavigate = useScreenReset(definition, screen?.id, setVars, inputs.onNavigate);

    const keepsValues = !!persistKey && persistedVariables(definition?.variables).length > 0;
    useEffect(() => {
        if (keepsValues) writePersistedVariables(persistKey, definition?.variables, vars);
    }, [keepsValues, persistKey, definition?.variables, vars]);

    const variables = definition?.variables;
    const deriveVars = useMemo(
        () => (hasDerivedVariables(variables) ? (scope: ExpressionScope) => applyDerivedVariables(variables, scope) as Vars : null),
        [variables],
    );
    // Keyed on the parts of `screen`, not the object: callers build a new one on every render.
    const screenId = screen?.id;
    const screenParams = screen?.params;
    const shownVars = useMemo(() => (deriveVars
        ? deriveVars(buildScope({ actionState, dataState: dataState || {}, currentUser, vars, forms: forms || {}, screen: { id: screenId, params: screenParams || {} } }))
        : vars), [deriveVars, actionState, dataState, currentUser, vars, forms, screenId, screenParams]);

    return { vars: shownVars, setVars, deriveVars, onNavigate };
}
