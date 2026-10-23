import type { AppDefinition } from '../inspector/appDefinition';
import type { DataState } from '../runtime/DataContext';
import type { Dispatch, SetStateAction, RefObject, JSX } from 'react';
import type { ActionState, RunOpts, Vars } from '../runtime/actionRunner/core';
import type { NavigateFn } from '../runtime/actionRunner/runnerContext';
import type { HeaderApp } from './header/headerModel';

export interface SectionDropZoneProps {
    sectionId: string;
    container: Element | DocumentFragment;
    onAddStarter: (sectionId: string, type: string) => void;
    disabled: boolean;
}

/**
 * The canvas surface itself — split out so it renders INSIDE AppDataScope and
 * can read the sampled/live `dataState` from the render-prop. The scope state
 * (forms/screenParams) and the preview action runner moved UP into Canvas
 * (Wave 2B2 — dynamic binding filters need the live scope ABOVE the data
 * layer); this body mirrors the data-scope values back to that runner and
 * keeps everything else (selection, dnd, resize, streamLock) unchanged.
 */
export interface CanvasBodyProps {
    appId: string | null;
    onCommit: (def: AppDefinition) => void;
    editActionState: {};
    dataState: DataState;
    refresh: (scopeArg?: { tableId?: string | null; datasetId?: string | null; } | null) => Promise<void>;
    onDataState: Dispatch<SetStateAction<{}>>;
    refreshRef: RefObject<CanvasBodyProps['refresh'] | null>;
    actionState: ActionState;
    runAction: (actionId: string, opts?: RunOpts) => Promise<void>;
    vars: Vars;
    setVar: (name: string, value: unknown) => void;
    forms: {};
    screenParams: {};
    registerFormValue: (formName: string, values: Record<string, unknown> | null | undefined) => void;
    onNavigate: NavigateFn | null;
    confirmDialog: JSX.Element;
}

/**
 * App Studio editor — the canvas. Wraps the surface in AppDataScope so bound
 * grids/charts/relation inputs show REAL records while editing (a small sampled
 * page) and the LIVE result in preview. A screen with no data bindings fetches
 * nothing, so fixtures/tests stay network-free.
 *
 * The scope state (forms/screenParams) and the preview action runner live
 * HERE, above AppDataScope, because dynamic binding filters resolve against
 * the live scope and `vars` is runner state — the exact mirror of
 * AppRunPage.RunSurface, so preview == production. The runner's own data
 * inputs flow back up from CanvasBody (see its bridge effects).
 */
export interface CanvasProps {
    app: HeaderApp;
    onCommit: (def: AppDefinition) => void;
    editActionState?: {};
}
