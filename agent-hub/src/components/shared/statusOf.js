/**
 * statusOf — the adapters that turn each Studio kind's own "is it live?"
 * fields into the ONE status word `shared/StatusActionPill` paints
 * (Bee Flow Builder redesign, Sep 2026; Studio Home artboard 1b "Gedeelde
 * patronen", plan 0.3b).
 *
 * Six words, shared by all nine kinds:
 *   live       switched on and doing work (an automation) — or, for an app,
 *              the version people use IS the canvas being edited
 *   paused     exists, finished, deliberately switched off (an automation)
 *   draft      never activated / not visible to anyone but its owner
 *   published  visible to its audience (a step, agent, KB, webpage)
 *   stale      published AND behind — the audience runs an older version
 *              than the one on screen (apps today). The artboard's two-state
 *              capsule has no slot for it; not showing it would lie.
 *   unknown    cannot be told from the row (an app row that predates
 *              `publishedVersion`) — claiming "up to date" on a guess would
 *              be worse than saying nothing (AppStudio EditorHeader.jsx:196-203).
 *
 * Pure functions over plain rows: no React, no fetch, no words, no colours —
 * the pill owns those, this module owns the truth. Each adapter takes the
 * WHOLE row so a caller hands over whatever it has, camelCase from a client
 * store or snake_case straight from the API. Unknown input never throws.
 *
 * A leaf module (imports nothing) so the pill, every Studio header and the
 * list rows can all read it without a cycle.
 */

/** The vocabulary, in the order the pill's docblock explains it. */
export const STATUSES = Object.freeze(['live', 'paused', 'draft', 'published', 'stale', 'unknown']);

/** Any status word outside the vocabulary is `unknown` — never a crash, never a guess. */
export function normalizeStatus(status) {
    return STATUSES.includes(status) ? status : 'unknown';
}

/**
 * Automations: `isDraft` wins over `isActive` — the same precedence
 * BuilderShell uses for its status label (a draft is finalised BY activating
 * it, so the two are never both true on a real row).
 */
export function automation(row) {
    if (row?.isDraft) return 'draft';
    return row?.isActive ? 'live' : 'paused';
}

/**
 * Steps (kind='block'): published once a version has been rolled out
 * (`publishedVersion != null`, BuilderHeader's own chip), a draft until then.
 */
export function step(row) {
    return (row?.publishedVersion ?? row?.published_version) != null ? 'published' : 'draft';
}

/**
 * The published flag as agents / KBs / webpages carry it today
 * (`is_published`, server/auth/audience.js) — and, once A1/W2 land a version
 * column, as `published_version` / `published_version_id`. An explicit flag
 * is the truth when present (an unpublished thing keeps its old version
 * number); the version column only speaks when the flag is absent.
 */
function isPublishedRow(row, versionFields) {
    const flag = row?.is_published ?? row?.isPublished;
    if (flag != null) return !!flag;
    return versionFields.some((f) => row?.[f] != null);
}

const AGENT_VERSION_FIELDS = ['published_version', 'publishedVersion'];
const WEBPAGE_VERSION_FIELDS = ['published_version_id', 'publishedVersionId'];

/** Agents: `is_published` today, `published_version` after A1. */
export function agent(row) {
    return isPublishedRow(row, AGENT_VERSION_FIELDS) ? 'published' : 'draft';
}

/** Knowledge bases: `is_published` (same audience contract as agents). */
export function kb(row) {
    return isPublishedRow(row, AGENT_VERSION_FIELDS) ? 'published' : 'draft';
}

/** Webpages: `is_published` today, `published_version_id` after W2. */
export function webpage(row) {
    return isPublishedRow(row, WEBPAGE_VERSION_FIELDS) ? 'published' : 'draft';
}

/**
 * Apps — the one THREE-valued model, mirrored from EditorHeader.jsx:200-203:
 *   unknown  not published, or the row predates `publishedVersion`
 *   live     the published version matches this canvas ('current')
 *   stale    the published version is older than this canvas ('behind')
 * A row without a canvas `version` cannot be compared either, so it is
 * `unknown` too rather than a `stale` it cannot back up.
 */
export function app(row) {
    const publishedVersion = row?.publishedVersion ?? row?.published_version ?? null;
    if (!(row?.isPublished ?? row?.is_published) || publishedVersion == null) return 'unknown';
    if (row?.version == null) return 'unknown';
    return Number(publishedVersion) === Number(row.version) ? 'live' : 'stale';
}

/** `statusOf.automation(row)` reads better at a call site than a bare `automation(row)`. */
const statusOf = Object.freeze({ automation, step, agent, kb, webpage, app, normalizeStatus, STATUSES });

export default statusOf;
