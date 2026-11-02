/**
 * A connector sync's watermark: how the stored high-water mark is rendered for
 * an action's since-param, and how it advances over the rows a run wrote.
 * connectorSync.js uses and re-exports both.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const connectorSchema = nodeRequire('./connectorSchema') as {
    toIsoStamp: (value: unknown) => string | null;
    readPath: (row: unknown, path: string) => unknown;
};

/** Render the stored watermark into the shape the action's since-param wants. */
export function renderWatermark(iso: string | null | undefined, format?: string | null): string | number | null {
    if (!iso) return null;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return null;
    if (format === 'unix') return Math.floor(t / 1000);
    if (format === 'date') return new Date(t).toISOString().slice(0, 10);
    return new Date(t).toISOString();
}

/** The highest watermark value across a set of rows, as a comparable ISO string. */
export function highWatermark(rows: unknown[], field: string | null | undefined, current: string | null = null): string | null {
    if (!field) return current;
    let best = current;
    for (const row of rows) {
        const iso = connectorSchema.toIsoStamp(connectorSchema.readPath(row, field));
        if (iso && (!best || iso > best)) best = iso;
    }
    return best;
}
