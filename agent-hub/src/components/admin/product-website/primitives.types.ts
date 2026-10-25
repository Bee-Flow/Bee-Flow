import type { ReactNode } from 'react';

// Prop and value types of primitives.tsx (kept apart so the component file stays
// under the file-size ceiling). Import them from here.

export interface CollapsibleCardProps {
    title?: ReactNode;
    defaultOpen?: boolean;
    persistKey?: string | null;
    children?: ReactNode;
}

export interface ColorSwatchProps {
    value?: string | null;
    onChange: (value: string) => void;
    title?: string;
}

export interface PxSizeInputProps {
    /** Pixels; 0, empty or a non-number shows the "inherit" placeholder. */
    value?: number | null;
    onChange: (px: number) => void;
    min?: number;
    max?: number;
    ariaLabel?: string;
}

export interface ColorRowProps {
    label?: string;
    value?: string | null;
    onChange: (value: string) => void;
    hint?: ReactNode;
}

export interface FontRowProps {
    label?: ReactNode;
    value?: string | null;
    onChange: (family: string) => void;
    sample?: ReactNode;
    weight?: number | string;
}

export type StyleBlob = {
    fontFamily?: string;
    fontSize?: number;
    color?: string;
};

export interface StyleTripletProps {
    label?: string;
    value?: StyleBlob;
    onChange: (next: StyleBlob) => void;
    sample?: ReactNode;
    weight?: number | string;
    min?: number;
    max?: number;
}

export interface SelectOption {
    value: string;
    label?: string;
    /** Translation key for the label; `label` is its fallback. */
    labelKey?: string;
}

export interface FieldSelectProps {
    value?: string | null;
    onChange: (value: string) => void;
    options: SelectOption[];
    label?: ReactNode;
    hint?: ReactNode;
}

export interface CtaStyleSelectProps {
    label?: string;
    value?: string | null;
    onChange: (value: string) => void;
}

export interface BackgroundVariantSelectProps {
    label?: string;
    value?: string | null;
    onChange: (value: string) => void;
    options?: SelectOption[];
}

/** A block's content blob: the card reads and writes only `backgroundVariant`. */
interface BackgroundCardData {
    backgroundVariant?: string;
    [key: string]: unknown;
}

export interface BackgroundCardProps {
    data?: BackgroundCardData;
    onChange: (next: BackgroundCardData) => void;
    persistKey?: string | null;
}

export interface SegmentedOption<V extends string | number = string> {
    value: V;
    label?: string;
    /** Translation key for the label; `label` is its fallback. */
    labelKey?: string;
    /** AppIcon name; with `iconOnly` the label is hidden. */
    icon?: string;
    /** Button tooltip; falls back to the label. */
    hint?: string;
}

export interface SegmentedControlProps<V extends string | number = string> {
    options: SegmentedOption<V>[];
    value?: V | null;
    onChange: (value: V) => void;
    iconOnly?: boolean;
}

export interface MonoTextareaProps {
    value?: string;
    onChange: (value: string) => void;
    rows?: number;
    minHeight?: number | null;
    placeholder?: string;
    ariaLabel?: string;
}
