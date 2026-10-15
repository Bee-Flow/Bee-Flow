// Types for the JavaScript picker, so TypeScript callers see its real props
// (the .jsx's own defaults infer `title: undefined`, `hiddenIds: never[]`).
import type { ReactElement } from 'react';

/** The model a picker reports, with its provider. */
export interface ModelSelection {
    providerId?: string;
    modelId?: string;
}

export interface SearchableModelSelectProps {
    /** A raw model id, or the { providerId, modelId } pair. */
    value: string | ModelSelection;
    label: string;
    /** Provider name → its models. */
    groups: Record<string, unknown[]>;
    onChange: (selection: ModelSelection) => void;
    title?: string;
    clearLabel?: string;
    hiddenIds?: readonly string[];
    onToggleHidden?: (modelId: string) => void;
}

export default function SearchableModelSelect(props: SearchableModelSelectProps): ReactElement;
