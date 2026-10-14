import type { ComponentType } from 'react';
import type { AppDefinition, AppNode } from './appDefinition';

/** The props every per-type Content panel receives from InspectorPanel. */
export interface PanelProps {
    node: AppNode;
    definition: AppDefinition;
    onCommit: (next: AppDefinition) => void;
    disabled?: boolean;
}

/** Commits a props delta (see usePatch in panels/kit.tsx). */
export type PanelPatch = (propsDelta: Record<string, unknown>) => void;

/** A registered per-type Content panel. */
export type ContentPanel = ComponentType<PanelProps>;
