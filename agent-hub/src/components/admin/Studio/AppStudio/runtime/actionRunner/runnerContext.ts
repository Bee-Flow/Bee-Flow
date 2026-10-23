/**
 * What the runner's phases share: the hook's latest inputs (read through a
 * ref, so the callbacks stay identity-stable and never read stale data) and
 * the hook-owned writers.
 */
import type { EffectContext } from './applyEffects';
import type { DataState } from '../DataContext';
import type { BrowseEvent } from '../BrowserRunContext';
import type { ActionEntry, ActionState, EffectObject, RunnableAction, RunStep, Translate, Vars } from './core';

export type NavigateFn = (screenId: string, params?: unknown) => void;
export type RefreshFn = (target?: { tableId: string | null; datasetId: string | null }) => unknown;
export type ConfirmFn = (step: RunStep) => boolean | Promise<boolean>;
export type BrowseEventSink = (actionId: string, evt: BrowseEvent) => void;
export type BeforeServerStep = () => Promise<{ ok?: boolean; error?: string } | null | undefined | void>;

export interface RunnerDefinition {
    actions?: Record<string, RunnableAction>;
    screens?: unknown;
    variables?: unknown;
    [key: string]: unknown;
}

/** The hook's inputs as of the latest render. */
export interface LiveInputs {
    actionState: ActionState;
    vars: Vars;
    definition: RunnerDefinition | null | undefined;
    onNavigate?: NavigateFn | null;
    onBrowseEvent?: BrowseEventSink | null;
    confirm?: ConfirmFn | null;
    onRefresh?: RefreshFn | null;
    currentUser?: unknown;
    dataState?: DataState | null;
    forms?: Record<string, unknown> | null;
    screen?: Record<string, unknown> | null;
    beforeServerStep?: BeforeServerStep | null;
}

export interface RunnerContext {
    appId: string | null;
    draft: boolean;
    tr: Translate;
    live: { readonly current: LiveInputs };
    alive: { readonly current: boolean };
    setEntry: (actionId: string, entry: ActionEntry) => void;
    setVar: (name: string, value: unknown) => void;
    applyEffects: (effects: EffectObject | null | undefined, ctx?: EffectContext) => Promise<void>;
}
