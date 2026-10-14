// Declarations for ./kit.jsx, which is still JavaScript. Typed here so the
// TypeScript panels can call it. Delete this file together with the
// conversion of kit.jsx (the .tsx then carries its own types).
import type { JSX, ReactNode } from 'react';
import type { AppDefinition, AppNode } from '../appDefinition';

export interface KitOption {
    value: string;
    label: string;
}

export declare function usePatch(
    node: AppNode,
    definition: AppDefinition | null | undefined,
    onCommit: (definition: AppDefinition) => void,
): (propsDelta: Record<string, unknown>) => void;

export declare const INPUT_CLS: string;

export declare function TextField(props: {
    label: ReactNode;
    value: unknown;
    onChange: (value: string) => void;
    placeholder?: string;
    hint?: ReactNode;
    disabled?: boolean;
    type?: string;
}): JSX.Element;

export declare function SelectField(props: {
    label: ReactNode;
    value: unknown;
    onChange: (value: string) => void;
    options: KitOption[];
    hint?: ReactNode;
    disabled?: boolean;
    ariaLabel?: string;
}): JSX.Element;

export declare function TextAreaField(props: {
    label: ReactNode;
    value: unknown;
    onChange: (value: string) => void;
    placeholder?: string;
    hint?: ReactNode;
    rows?: number;
    disabled?: boolean;
}): JSX.Element;

export declare function NumberField(props: {
    label: ReactNode;
    value: unknown;
    onChange: (value: number | null) => void;
    placeholder?: string;
    hint?: ReactNode;
    disabled?: boolean;
    step?: number;
}): JSX.Element;

export declare function IconField(props: {
    label?: ReactNode;
    value: unknown;
    onChange: (value: string | null) => void;
    hint?: ReactNode;
    disabled?: boolean;
}): JSX.Element;

export declare function FieldKeyField(props: {
    label?: ReactNode;
    value: unknown;
    onChange: (value: string) => void;
    source?: { kind?: string; tableId?: string; [key: string]: unknown } | null;
    placeholder?: string;
    hint?: ReactNode;
    ariaLabel?: string | null;
    disabled?: boolean;
}): JSX.Element;
