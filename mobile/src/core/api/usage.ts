/**
 * "Who uses this" — the `GET /…/:id/usage` answer every Studio object gives.
 *
 * Skills (server/routes/skills.js, `{ usage, unchecked }` from
 * skillStore.listSkillUsage) and knowledge bases
 * (server/routes/knowledgeBases/usage.js, `{ usage, unchecked }` from
 * core/kb/kbUsage) answer in the same shape as the delete guard's 409 body,
 * so the rows are the guard's own DeleteGuardRow and a screen can show the
 * same list before a delete as the guard shows during one.
 *
 * `unchecked` names the kinds the scan could NOT look at. It is kept apart
 * from the rows on purpose: "nothing uses this" and "nobody could look" are
 * different claims, and the Used-by tab says which one it is making.
 */

import { field, pick, shapeOf } from './contract';
import type { DeleteGuardRow } from './deleteGuard';

export interface UsageAnswer {
    usage: DeleteGuardRow[];
    unchecked: string[];
}

const readRow: (raw: unknown) => DeleteGuardRow = shapeOf({
    kind: field.optStr,
    id: (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : undefined),
    title: field.strOrNull,
    role: field.optStr,
    foreign: field.optBool,
    siteLabel: field.strOrNull,
    stepId: field.strOrNull,
});

export function readUsageAnswer(raw: unknown): UsageAnswer {
    const rows = pick(raw, 'usage');
    return {
        usage: Array.isArray(rows) ? rows.filter((r) => r !== null && typeof r === 'object').map(readRow) : [],
        unchecked: field.strArray(pick(raw, 'unchecked')).filter(Boolean),
    };
}
