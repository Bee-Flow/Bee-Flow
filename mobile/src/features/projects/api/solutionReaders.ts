/**
 * Contract readers for the builder's view of a project: the Solutions
 * overview (projects/summary.js), the wiring graph (projects/graph.js) and
 * the checks (projects/completeness.js), as routes/projects.js serves them.
 *
 * Every verdict here fails SHUT. `complete` is `true` only when the server
 * said `true`; a missing `blocked` is not "not blocked" (the endpoint refuses
 * such an answer before it gets here); a tally the server sent as `null`
 * stays `null` rather than becoming a 0.
 */

import { asCount, field, pick, shapeOf } from '@/core/api/contract';

import { PROJECT_ROLES } from './readers';
import type {
    Completeness,
    Finding,
    GraphNode,
    RowCompleteness,
    RowUpdate,
    SolutionGraph,
    SolutionRow,
    SolutionSummary,
} from '../model/solution';

/** true / false as sent; anything else — absent, a string — is "not said". */
const verdict = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const readRowCompleteness: (raw: unknown) => RowCompleteness = shapeOf({
    blocked: (v) => v !== false,
    complete: (v) => v === true,
    findings: field.num(0),
    errors: field.num(0),
    warnings: field.num(0),
});

const readRowUpdate: (raw: unknown) => RowUpdate = shapeOf({
    installedVersion: field.numOrNull,
    latestVersion: field.numOrNull,
    available: verdict,
});

/** Per-section tallies: a number, or null when the server could not count it. */
function readCounts(raw: unknown): Record<string, number | null> {
    const out: Record<string, number | null> = {};
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [key, value] of Object.entries(raw)) out[key] = asCount(value);
    return out;
}

const objectOrNull = <T>(read: (raw: unknown) => T) => (raw: unknown): T | null =>
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? read(raw) : null;

const readSolutionRow: (raw: unknown) => SolutionRow = shapeOf({
    id: field.str(''),
    name: field.str('Untitled'),
    description: field.str(''),
    icon: field.strOrNull,
    permission: field.oneOf(PROJECT_ROLES, 'viewer'),
    installedFromBlueprintId: field.strOrNull,
    updatedAt: field.strOrNull,
    counts: readCounts,
    runs: objectOrNull(shapeOf({ today: field.numOrNull, failed: field.numOrNull })),
    completeness: objectOrNull(readRowCompleteness),
    update: objectOrNull(readRowUpdate),
});

/**
 * GET /api/projects/summary. A body without a `projects` array is not "you
 * have no Solutions": it reads as no rows WITH `unavailable: ['all']`, the
 * marker the route's own failure path carries.
 */
export function readSummary(raw: unknown): SolutionSummary {
    const projects = pick(raw, 'projects');
    const declared = field.strArray(pick(raw, 'unavailable')).filter(Boolean);
    if (!Array.isArray(projects)) {
        return { rows: [], unavailable: [...new Set([...declared, 'all'])], hasMore: false };
    }
    const rows = projects
        .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
        .map(readSolutionRow)
        .filter((row) => row.id !== '');
    return { rows, unavailable: declared, hasMore: pick(raw, 'hasMore') === true };
}

export const readFinding: (raw: unknown) => Finding = shapeOf({
    code: field.str(''),
    severity: field.str('warning'),
    message: field.str(''),
    remediation: field.strOrNull,
    blockedAt: field.strOrNull,
    deepLink: field.strOrNull,
    targetRef: objectOrNull(shapeOf({ kind: field.str(''), id: field.strOrNull })),
    from: field.strOrNull,
    targetId: field.strOrNull,
});

const readNode: (raw: unknown) => GraphNode = shapeOf({
    id: field.str(''),
    type: field.str(''),
    name: field.str(''),
    entityId: field.strOrNull,
    triggers: field.strOrNull,
});

export const readGraph: (raw: unknown) => SolutionGraph = shapeOf({
    nodes: field.list(readNode),
    edges: field.list(
        shapeOf({
            from: field.str(''),
            to: field.strOrNull,
            kind: field.str(''),
            targetId: field.strOrNull,
            problem: field.strOrNull,
        }),
    ),
    externals: field.list(shapeOf({ kind: field.str(''), id: field.str(''), referencedBy: field.strArray })),
    problems: field.list(readFinding),
    unavailable: field.strArray,
    complete: verdict,
});

/**
 * GET /:id/completeness, once the endpoint has checked that `blocked` is a
 * boolean. `unavailable` defaults to nothing; `complete` to "not said".
 */
export const readCompleteness: (raw: unknown) => Completeness = shapeOf({
    blocked: (v) => v !== false,
    complete: verdict,
    findings: field.list(readFinding),
    unavailable: field.strArray,
});
