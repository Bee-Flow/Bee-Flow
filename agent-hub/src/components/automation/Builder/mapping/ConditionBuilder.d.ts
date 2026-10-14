// Declarations for ./ConditionBuilder.jsx, which is still JavaScript. Typed
// here for the TypeScript caller in App Studio (inspector/logic/ConditionField).
// Delete this file together with the conversion of ConditionBuilder.jsx.
import type { JSX } from 'react';

export interface ConditionFieldOption {
    path: string;
    label?: string;
    sample?: unknown;
    group?: string;
}

export interface ConditionBuilderPlaceholders {
    field?: string;
    raw?: string;
}

export interface ConditionBuilderProps {
    value?: string;
    onChange?: (expr: string) => void;
    onFocusField?: (path: string) => void;
    previewSample?: Record<string, unknown> | null;
    context?: string;
    fieldOptions?: ConditionFieldOption[] | null;
    fieldBase?: string;
    showSerialized?: boolean;
    placeholders?: ConditionBuilderPlaceholders | null;
    topics?: unknown;
}

export default function ConditionBuilder(props: ConditionBuilderProps): JSX.Element;
