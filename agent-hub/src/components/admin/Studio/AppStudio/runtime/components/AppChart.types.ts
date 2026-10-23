import type { BindingInput } from '../resolveBinding.types';

/** One data row as the binding returned it. */
export type ChartRow = Record<string, unknown>;

/** One plotted series: the row key it reads, and optionally its label and colour. */
export interface SeriesSpec {
    key: string;
    label?: string;
    color?: string;
}

/** A reference line at one value. */
export interface ReferenceLineSpec {
    value: string | number;
    label?: string;
    color?: string;
}

/** A reference band between two values. */
export interface ReferenceBandSpec {
    from: number | string;
    to: number;
    label?: string;
    color?: string;
}

export interface ChartProps {
    chartType?: string;
    title?: string | null;
    xKey?: string;
    series?: SeriesSpec[];
    stacked?: boolean;
    showLegend?: boolean;
    showGrid?: boolean;
    valueFormat?: string;
    xType?: string;
    yMin?: number | string | null;
    yMax?: number | string | null;
    referenceLines?: ReferenceLineSpec[];
    referenceBands?: ReferenceBandSpec[];
    unitLabel?: string | null;
    orientation?: string;
    source?: BindingInput;
}
