import type { ComponentType, CSSProperties, ReactNode } from 'react';
import type { AppDefinition, AppNode } from '../inspector/appDefinition';
import type { ActionState, Vars } from './actionRunner/core';
import type { DataState } from './DataContext';
import type { RuntimeValue } from './RuntimeContext';

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
