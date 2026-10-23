import type { ComponentType, CSSProperties, ReactNode } from 'react';
import type { AppDefinition, AppNode } from '../inspector/appDefinition';
import type { ActionState, Vars } from './actionRunner/core';
import type { DataState } from './DataContext';
import type { RuntimeValue, ExpressionScope } from './RuntimeContext';

/** Props of the component that wraps every rendered node (DefaultNodeWrapper, or the editor's). */
export interface NodeWrapperProps {
    node: AppNode;
    className?: string;
    style?: CSSProperties;
    children?: ReactNode;
}

/**
 * Props of AppRenderer (AppRenderer.jsx). Every prop may be left out: without a
 * `definition` (or a screen) it renders nothing, and each state / callback prop
 * falls back to an empty object or a no-op.
 */
export interface AppRendererProps {
    definition?: AppDefinition | null;
    /** Without a known id the home screen, then the first, is shown. */
    screenId?: string | null;
    /** Anything but 'edit' renders as 'run'. Default 'run'. */
    mode?: 'edit' | 'run';
    /** Default DefaultNodeWrapper (a plain div). */
    NodeWrapper?: ComponentType<NodeWrapperProps>;
    actionState?: ActionState | null;
    dataState?: DataState | null;
    runAction?: RuntimeValue['runAction'] | null;
    onSelectNode?: RuntimeValue['onSelectNode'] | null;
    selectedNodeId?: string | null;
    /** Editor multi-select; only a Set counts, anything else reads as null. */
    selectedNodeIds?: Set<string> | null;
    /** A Set is used as is; any other iterable is copied into one. */
    recentlyAddedIds?: Iterable<string> | null;
    registerFormValue?: RuntimeValue['registerFormValue'];
    currentUser?: unknown;
    /** View-as-role preview: nodes and screens gated away from it are hidden. */
    previewRole?: string | null;
    vars?: Vars | null;
    /** Only a function is passed on; otherwise the no-op default stays. */
    setVar?: RuntimeValue['setVar'] | null;
    forms?: Record<string, unknown> | null;
    screenParams?: Record<string, unknown> | null;
}

/** A boolean-or-formula flag as it is stored: a boolean, a bare string, or `{ kind, expr }`. */
export type FlagInput = boolean | string | null | undefined | { kind?: string; expr?: string; value?: string };

/** The theme members the renderer reads off `definition.theme`. */
export type ThemeLike = { primary?: string; radius?: string; density?: string; fontScale?: string; appearance?: string; accent?: string; canvas?: string };

export interface UnknownTypeProps {
    type: string;
}

export interface FormulaErrorBadgeProps {
    message: string;
}

/**
 * Inert wrapper for a disabled node — blocks pointer + keyboard interaction.
 *
 * It also tells the inputs below it that they are switched off. Without that a
 * required field behind `enabledWhen:false` still registered as required, so
 * submit failed on a field nobody could focus or type into and the form could
 * never be sent.
 */
export interface DisabledWrapProps {
    children?: React.ReactNode;
}

/**
 * Render a node's children, threading a per-row item scope when it repeats.
 * Inside a `form` container the child scope's `form` root is that form's live
 * values (forms[name] — published by AppForm via registerFormValue), so
 * visibleWhen/computed formulas like "form.email != ''" react to typing. Same
 * mechanism as the repeater's per-item scope.
 */
export interface RenderChildrenOpts {
    actionState: ActionState;
    dataState: DataState;
    NodeWrapper: React.ComponentType<NodeWrapperProps>;
    mode: string;
}

export interface RenderNodeProps {
    node: AppNode;
    scope: ExpressionScope;
    NodeWrapper: React.ComponentType<NodeWrapperProps>;
    mode: string;
}
