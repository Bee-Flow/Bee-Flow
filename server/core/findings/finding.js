/**
 * Finding — the ONE shape every "this needs your attention" row is drawn from.
 *
 * Three surfaces draw the same list (Studio Home "Vraagt aandacht", a
 * Solution's "Te controleren", a builder's "Nog niet klaar") and the things
 * that produce it are scattered: the App Studio validator, the routine
 * validator with its draft/activate ladder, the Solution dependency graph,
 * the app dry run. Four of them already emit `{ code, severity, path|nodeId,
 * message, hint }`; what they lacked was WHICH object the row belongs to and
 * WHERE in it to jump. This module names that shape once, so a consumer never
 * has to know which validator it is reading:
 *
 *   Finding = {
 *     code,                    // 'component.control_inert' | 'trigger.missing' | …
 *     severity,                // 'error' | 'warning' | 'info'
 *     blockedAt?,              // 'activate' | 'publish' — the stage this blocks
 *     kind,                    // the object kind: drives the tinted glyph
 *     targetRef: {             // where "Show me" goes
 *       kind, id,              // the object (id null when the producer has none)
 *       title?, path?, nodeId?, stepId?,
 *     },
 *     message,                 // the sentence, with the object's name in it
 *     remediation?,            // today's `hint`
 *   }
 *
 * `message` and `remediation` ARE the existing `message` and `hint` — nothing
 * is rephrased. `blockedAt` keeps the routine validator's draft/activate ladder
 * intact (validate/completenessCodes.js): a completeness code at stage 'draft'
 * is a warning tagged `blockedAt: 'activate'`, and flattening that into a
 * plain severity would re-break BFSF-323. The ladder stays where it is; this
 * shape only carries its verdict.
 *
 * The producers keep their legacy fields (`path`, `hint`) for the callers they
 * already have and ADD `kind` + `targetRef`; `fromLegacy` turns such a record
 * into a Finding for the consumers that want one shape. `makeFinding`
 * validates, because a Finding with a kind the palette does not know renders
 * grey and a Finding with no message renders nothing — both quietly.
 *
 * Kinds mirror agent-hub/src/components/shared/kindColors.js KIND_KEYS: the
 * ten things one makes in Studio. Keep the two lists identical.
 */

'use strict';

const SEVERITIES = Object.freeze(['error', 'warning', 'info']);
const BLOCKED_AT = Object.freeze(['activate', 'publish']);
const FINDING_KINDS = Object.freeze([
    'automation', 'datatable', 'app', 'webpage', 'form',
    'agent', 'skill', 'kb', 'meeting',
    'solution',
]);

/** Sort order for a mixed list: what blocks comes before what merely warns. */
const SEVERITY_RANK = Object.freeze({ error: 0, warning: 1, info: 2 });

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

/** Thrown for a malformed Finding — a TypeError so callers can tell it from a runtime failure. */
class FindingShapeError extends TypeError {
    constructor(message, field) {
        super(`Finding: ${message}`);
        this.name = 'FindingShapeError';
        this.field = field;
    }
}

/**
 * The target half, validated. `id` may be null: a validator sees a definition,
 * not the row it came from, and "unknown object" must stay distinguishable
 * from "object with id ''". Every optional locator is kept only when it is a
 * non-empty string, so a consumer can test `'nodeId' in targetRef`.
 */
function normalizeTargetRef(ref, fallbackKind) {
    if (!isObject(ref)) throw new FindingShapeError('targetRef must be an object', 'targetRef');
    const kind = ref.kind ?? fallbackKind;
    if (!FINDING_KINDS.includes(kind)) {
        throw new FindingShapeError(`targetRef.kind must be one of ${FINDING_KINDS.join(', ')} (got ${JSON.stringify(kind)})`, 'targetRef.kind');
    }
    let id = null;
    if (ref.id !== undefined && ref.id !== null) {
        if (typeof ref.id !== 'string' && typeof ref.id !== 'number') {
            throw new FindingShapeError('targetRef.id must be a string, a number or null', 'targetRef.id');
        }
        id = String(ref.id);
    }
    const out = { kind, id };
    for (const key of ['title', 'path', 'nodeId', 'stepId']) {
        const v = ref[key];
        if (v === undefined || v === null || v === '') continue;
        if (typeof v !== 'string' && typeof v !== 'number') {
            throw new FindingShapeError(`targetRef.${key} must be a string`, `targetRef.${key}`);
        }
        out[key] = String(v);
    }
    return out;
}

/**
 * Build a Finding, or throw a FindingShapeError naming the first field that
 * is wrong. Unknown input keys are dropped: the whole point is that a consumer
 * can rely on exactly this set.
 */
function makeFinding(input) {
    if (!isObject(input)) throw new FindingShapeError('expected an object', '');
    const { code, severity, blockedAt, kind, targetRef, message, remediation } = input;

    if (!isNonEmptyString(code)) throw new FindingShapeError('code must be a non-empty string', 'code');
    if (!SEVERITIES.includes(severity)) {
        throw new FindingShapeError(`severity must be one of ${SEVERITIES.join(', ')} (got ${JSON.stringify(severity)})`, 'severity');
    }
    if (blockedAt !== undefined && blockedAt !== null && !BLOCKED_AT.includes(blockedAt)) {
        throw new FindingShapeError(`blockedAt must be one of ${BLOCKED_AT.join(', ')} (got ${JSON.stringify(blockedAt)})`, 'blockedAt');
    }
    if (!FINDING_KINDS.includes(kind)) {
        throw new FindingShapeError(`kind must be one of ${FINDING_KINDS.join(', ')} (got ${JSON.stringify(kind)})`, 'kind');
    }
    if (!isNonEmptyString(message)) throw new FindingShapeError('message must be a non-empty string', 'message');
    if (remediation !== undefined && remediation !== null && typeof remediation !== 'string') {
        throw new FindingShapeError('remediation must be a string', 'remediation');
    }

    const finding = {
        code,
        severity,
        kind,
        targetRef: normalizeTargetRef(targetRef, kind),
        message,
    };
    if (blockedAt) finding.blockedAt = blockedAt;
    if (isNonEmptyString(remediation)) finding.remediation = remediation;
    return finding;
}

/**
 * A validator record → Finding.
 *
 *   { code, severity, blockedAt?, path?, nodeId?, stepId?, message, hint?,
 *     kind?, targetRef? }
 *
 * `hint` becomes `remediation`. `path` / `nodeId` / `stepId` become locators
 * on the targetRef. A record that already carries `targetRef` (the producers
 * add one now) wins over the loose fields; `target` — `{ id, title }` of the
 * object the record was produced FOR — fills in what the validator could not
 * know, because it only ever saw a definition. `kind` is the caller's word:
 * the validator that produced the record is the one that knows what it
 * validated.
 */
function fromLegacy(kind, legacy, target = null) {
    if (!isObject(legacy)) throw new FindingShapeError('expected a legacy record object', '');
    const own = isObject(legacy.targetRef) ? legacy.targetRef : {};
    const targetRef = {
        kind: own.kind ?? kind,
        id: own.id ?? target?.id ?? null,
        title: own.title ?? target?.title ?? undefined,
        path: own.path ?? legacy.path ?? undefined,
        nodeId: own.nodeId ?? legacy.nodeId ?? undefined,
        stepId: own.stepId ?? legacy.stepId ?? undefined,
    };
    return makeFinding({
        code: legacy.code,
        severity: legacy.severity,
        blockedAt: legacy.blockedAt ?? undefined,
        kind: legacy.kind ?? kind,
        targetRef,
        message: legacy.message,
        remediation: legacy.remediation ?? legacy.hint ?? undefined,
    });
}

/** True when `value` already has the Finding shape — a non-throwing makeFinding. */
function isFinding(value) {
    try {
        makeFinding(value);
    } catch (err) {
        if (err instanceof FindingShapeError) return false;
        throw err;
    }
    return true;
}

/** Comparator: errors first, then warnings, then info; stable within a rank. */
function bySeverity(a, b) {
    return (SEVERITY_RANK[a?.severity] ?? 9) - (SEVERITY_RANK[b?.severity] ?? 9);
}

module.exports = {
    makeFinding,
    fromLegacy,
    isFinding,
    bySeverity,
    FindingShapeError,
    SEVERITIES,
    BLOCKED_AT,
    FINDING_KINDS,
    SEVERITY_RANK,
};
