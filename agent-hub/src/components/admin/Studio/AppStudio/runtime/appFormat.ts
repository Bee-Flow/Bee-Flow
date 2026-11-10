/**
 * App Studio runtime: value formatting (definition.format and a node's or column's
 * formatOptions, schema 3).
 *
 * The formatter itself is the shared module (server/shared/format/valueFormat.mjs, generated to
 * src/shared/format/): the server cleans the same shapes with the same code, so the canvas, a
 * public page and the validator agree. AppRenderer puts the app's format on the runtime context
 * (`appFormat`); a component reads it with useAppFormat() and hands it, with its own
 * formatOptions, to formatContext(). Neither present gives null, and every formatter then runs
 * the code the runtime had before formatting was configurable.
 *
 * Converted so far: the shared cell renderer (table, data_grid), the chart's value axis,
 * tooltip and time axis, and the stat tile. Every other runtime file that writes a number or a
 * date with toLocaleString still does so directly.
 */

import { useRuntime } from './RuntimeContext';
import { formatContext } from '@shared/format/valueFormat.mjs';
import type { AppFormat, FormatOptions, FormatContext } from '@shared/format/valueFormat.mjs';

export type { AppFormat, FormatOptions, FormatContext };
export { formatContext, formatNumber, formatDate, localeDateArgs, makeValueFormatter, LEGACY } from '@shared/format/valueFormat.mjs';

/** The app's format from the runtime context, or null (no format, or outside a renderer). */
export function useAppFormat(): AppFormat | null {
    const value = useRuntime().appFormat;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AppFormat : null;
}

/** The context for one component: the app's format and its own formatOptions (null = legacy path). */
export function useFormatContext(options: unknown): FormatContext | null {
    return formatContext(useAppFormat(), options);
}
