/** Contract readers for the rules' automation calls (see endpoints.ts for the routes). */

import { field, pick, shapeListOf } from '@/core/api/contract';

import type { MeetingRule } from '../model/types';

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const readRows: (raw: unknown) => MeetingRule[] = shapeListOf({
    id: field.str(''),
    title: field.str(''),
    userId: field.strOrNull,
    isActive: bool,
    isDraft: bool,
    definition: field.record<Record<string, unknown>>({}),
});

export function readRules(raw: unknown): MeetingRule[] {
    return readRows(pick(raw, 'automations')).filter((row) => row.id);
}

export interface RunFacets {
    /** The facets object as sent; rules.ts decides whether it is readable. */
    facets: unknown;
    /** The window the server actually counted (it clamps the request). */
    hours: number;
}

export function readFacets(raw: unknown, asked: number): RunFacets {
    const hours = pick(raw, 'rangeHours');
    return { facets: pick(raw, 'facets') ?? null, hours: typeof hours === 'number' && Number.isFinite(hours) ? hours : asked };
}

/** `{ automation: { id } }`, or a bare `{ id }` from an older server. */
export function readCreated(raw: unknown): string | null {
    const nested = pick(pick(raw, 'automation'), 'id');
    if (typeof nested === 'string' && nested) return nested;
    const flat = pick(raw, 'id');
    return typeof flat === 'string' && flat ? flat : null;
}
