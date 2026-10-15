// Option and value shapes shared by the CMS admin micro-widgets (primitives.tsx).

export interface SelectOption {
    value: string;
    label: string;
    labelKey?: string;
}

export interface SegmentedOption {
    value: string;
    label: string;
    labelKey?: string;
    icon?: string;
    hint?: string;
}

export interface StyleTripletValue {
    fontFamily?: string;
    fontSize?: number;
    color?: string | null;
}
