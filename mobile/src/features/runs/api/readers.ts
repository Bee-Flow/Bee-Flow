/**
 * Contract readers for the run log, written from the server's serialisers:
 * stores/automationStore/runs.js (rowToRunWithAutomation, rowToOrgRunRow and
 * getRunFacetsScoped). serverContract.test.ts pins those field lists.
 */

import { asCount, field, pick, shapeOf } from '@/core/api/contract';
import { withId } from '@/shared/lib/withId';

import type { LogRun, RunFacets, RunPage, RunRollup } from '../model/types';

export const readLogRun: (raw: unknown) => LogRun = shapeOf({
    id: field.str(''),
    journeyRunId: field.strOrNull,
    automationId: field.str(''),
    automationTitle: field.strOrNull,
    automationKind: field.str('automation'),
    triggerKind: field.strOrNull,
    rootStepId: field.strOrNull,
    rootTriggerLabel: field.strOrNull,
    mode: field.strOrNull,
    status: field.str('queued'),
    startedAt: field.strOrNull,
    finishedAt: field.strOrNull,
    durationMs: field.numOrNull,
    summary: field.strOrNull,
    error: field.strOrNull,
    errorClass: field.strOrNull,
    handledErrorCount: field.num(0),
    mine: field.optBool,
});

/** A page of either list. A row without an id has nothing to open and is dropped. */
export function readRunPage(raw: unknown): RunPage {
    return {
        runs: withId(field.list(readLogRun)(pick(raw, 'runs'))),
        nextCursor: field.strOrNull(pick(raw, 'nextCursor')),
    };
}

/** A value→count map; non-numeric counts are dropped rather than trusted. */
function readCounts(raw: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        const n = asCount(value);
        if (n !== null) out[key] = n;
    }
    return out;
}

const readRollup: (raw: unknown) => RunRollup = shapeOf({
    automationId: field.str(''),
    title: field.strOrNull,
    kind: field.str('automation'),
    total: field.num(0),
    status: readCounts,
    lastRunAt: field.strOrNull,
    lastErrorAt: field.strOrNull,
    lastErrorClass: field.strOrNull,
});

const readFacetBody: (raw: unknown) => RunFacets = shapeOf({
    status: readCounts,
    triggerKind: readCounts,
    automationId: readCounts,
    errorClass: readCounts,
    // Null, never []: a server without the rollup is not a quiet day.
    automations: (value: unknown) =>
        Array.isArray(value) ? field.list(readRollup)(value).filter((r) => r.automationId !== '') : null,
    automationsTotal: field.numOrNull,
});

/** `{ facets, rangeHours }` → the facets, or null for a body this build cannot read. */
export function readFacets(raw: unknown): RunFacets | null {
    const body = pick(raw, 'facets');
    return body && typeof body === 'object' && !Array.isArray(body) ? readFacetBody(body) : null;
}
