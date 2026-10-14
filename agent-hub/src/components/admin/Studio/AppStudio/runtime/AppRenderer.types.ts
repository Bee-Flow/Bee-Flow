import type { ComponentType, CSSProperties, ReactNode } from 'react';
import type { AppDefinition, AppNode } from '../inspector/appDefinition';
import type { DataState } from './DataContext';

/** The renderer's mode: an editor canvas, or the end-user run view. */
export type RenderMode = 'edit' | 'run';

/** What a NodeWrapper receives for each node. */
export interface NodeWrapperProps {
    node: AppNode;
    className?: string;
    style?: CSSProperties;
    children?: ReactNode;
}

/** The result of resolving one boolean-or-formula flag. */
export interface FlagResult {
    set: boolean;
    value?: boolean;
    error?: string | null;
}

export interface AppRendererProps {
    definition: AppDefinition | null | undefined;
    screenId: string | null | undefined;
    mode?: RenderMode;
    NodeWrapper?: ComponentType<NodeWrapperProps>;
    actionState?: Record<string, unknown>;
    dataState?: DataState;
    runAction?: (actionId: string, opts?: unknown) => unknown;
    onSelectNode?: ((id: string | null) => void) | null;
    selectedNodeId?: string | null;
    selectedNodeIds?: ReadonlySet<string> | null;
    recentlyAddedIds?: ReadonlySet<string> | string[] | null;
    registerFormValue?: ((key: string, value: unknown) => void) | null;
    currentUser?: unknown;
    previewRole?: string | null;
    vars?: Record<string, unknown>;
    setVar?: ((name: string, value: unknown) => void) | null;
    forms?: Record<string, unknown>;
    screenParams?: Record<string, unknown>;
}
