import type { ReactNode } from 'react';

/** One data row, read by field name. */
export type ChartRow = Record<string, unknown>;

/** One plotted series: the column it reads, and how it is named and coloured. */
export interface SeriesSpec {
    key: string;
    label?: string;
    color?: string;
}

/** A reference line as the author wrote it (the value is checked on use). */
export interface RefLine {
    value?: unknown;
    color?: string;
    label?: string;
}

/** A reference band as the author wrote it (the bounds are checked on use). */
export interface RefBand {
    from?: unknown;
    to?: unknown;
    color?: string;
    label?: string;
}

/** A reference band with its bounds checked and ordered. */
export interface NormalizedBand {
    from: number;
    to: number;
    color?: string;
    label?: string;
}

/** The chart node's props, as the chart reads them (spec: componentSpecs.js). */
export interface ChartProps {
    chartType?: string;
    title?: ReactNode;
    xKey?: string;
    series?: SeriesSpec[];
    stacked?: boolean;
    showLegend?: boolean;
    showGrid?: boolean;
    valueFormat?: string;
    xType?: string;
    yMin?: unknown;
    yMax?: unknown;
    referenceLines?: RefLine[];
    referenceBands?: RefBand[];
    unitLabel?: string | null;
    orientation?: string;
    source?: unknown;
}

/** The app design fields a chart reads (palette and motion). */
export interface ChartDesign {
    chartPalette?: string;
    primary?: string | null;
    motion?: string;
}
