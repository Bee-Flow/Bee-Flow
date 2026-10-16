import type { LucideIcon } from 'lucide-react';
import type { FlowletAgentState } from '../../../hooks/useFlowletAgentStream';
import type { getLayerDependencies, listLayers } from './flow/flowletScope';
import type { FlowDefinition, FlowStep } from './flow/types';

/** One flowlet as the panel lists it (title, step count, params, output fields). */
export type Layer = ReturnType<typeof listLayers>[number];

/** What a flowlet calls and who calls it. */
export type LayerDeps = ReturnType<typeof getLayerDependencies>;

/** A flowlet's definition, as the preview reads its steps. */
export type PreviewLayer = FlowDefinition;

/** A step as the preview reads it. */
export interface PreviewStep extends FlowStep {
    tool?: string;
    layerKey?: string;
}

/** One step of a flowlet in the preview: its type chip, its label and the flowlet it calls. */
export interface PreviewRow {
    id: string;
    type: string | undefined;
    label: string | undefined;

    layerKey: string | null;
}

/** The AI flowlet builder's live state. */
export type LayerAgentState = FlowletAgentState;

export interface FlowletsPanelProps {
    onClose?: () => void;
    rootDef: FlowDefinition | null;
    currentScopeKey?: string | null;
    onOpenLayer?: (key: string | null) => void;
    onRenameLayer?: (key: string, title: string) => void;
    onDeleteLayer?: (key: string) => void;
    refCountFor?: (key: string) => number;
    onCreateLayer?: () => void;
    aiEnabled?: boolean;
    onToggleAi?: () => void;
    onSummarize?: (key: string) => void;
    summarizingKey?: string | null;
    rootDescription?: string;
    onSummarizeRoot?: () => void;
    summarizingRoot?: boolean;
    onBuildLayer?: ((text: string) => Promise<boolean>) | null;
    onRefineLayer?: ((key: string, text: string) => Promise<boolean>) | null;
    layerAgentState?: LayerAgentState | null;
}

export interface DepLineProps {
    icon: LucideIcon;
    label: string;
    targets?: string[];
    titleByKey: Record<string, string>;
    onNavigate?: (key: string) => void;
}

export interface MainFlowRowProps {
    isCurrent: boolean;
    calls: string[];
    titleByKey: Record<string, string>;
    onOpen: () => void;
    onNavigate: (key: string) => void;
    aiEnabled: boolean;
    description: string;
    onSummarize?: () => void;
    summarizing: boolean;
}

export interface LayerRowProps {
    layer: Layer;
    steps: PreviewRow[];
    deps: LayerDeps;
    titleByKey: Record<string, string>;
    isCurrent: boolean;
    refCount: number;
    onOpen: () => void;
    onNavigate: (key: string) => void;
    onRename: (title: string) => void;
    onDelete: () => void;
    aiEnabled: boolean;
    onSummarize: () => void;
    summarizing: boolean;
    onRefine?: ((text: string) => Promise<boolean>) | null;
    refining?: boolean;
    refineProgress?: string;
}

export interface LayerAiComposerProps {
    onSubmit?: (text: string) => void | Promise<void>;
    running?: boolean;
    progress?: string;
    placeholder?: string;
    submitLabel?: string;
    autoFocus?: boolean;
    compact?: boolean;
}
