/**
 * The stage engine's pure rules (design 6.2, 6.3, 6.6, D19): the deployment
 * status machine, who may receive which release, when a deployment needs the
 * PRD approval, and the one way a plan (or any payload) is hashed.
 *
 * No I/O and no requires beyond node and core/http: every other module of the
 * engine (release, plan, runner, routes) asks these questions here, so the
 * answer is the same wherever it is asked.
 *
 * ── The status machine ──────────────────────────────────────────────────────
 *
 *   awaiting_approval → approved | rejected | cancelled
 *   queued | approved → preparing | cancelled
 *   preparing         → committing | compensating | failed
 *   committing        → converging | compensating | failed
 *   converging        → succeeded | succeeded_with_warnings
 *   succeeded_with_warnings → converging   (a converge retry)
 *   compensating      → failed
 *
 * `compensating` is in the ACTIVE set on purpose (design 6.5): the store
 * guards accept a deployment's capability only while its row is active, and a
 * compensation still has to reset working copies with it.
 *
 * The kinds 'settings' (D19, a PRD gate change under approval) and 'remove'
 * (6.8) run through the same machine; neither carries a release.
 */

'use strict';

const crypto = require('crypto');

const STAGES = Object.freeze(['uat', 'prd']);
const KINDS = Object.freeze(['deploy', 'rollback', 'redeploy', 'settings', 'remove']);
/** The kinds that move a stage to a release. */
const RELEASE_KINDS = Object.freeze(['deploy', 'rollback', 'redeploy']);

const STATUSES = Object.freeze([
    'awaiting_approval', 'approved', 'rejected', 'queued',
    'preparing', 'committing', 'converging', 'compensating',
    'succeeded', 'succeeded_with_warnings', 'failed', 'cancelled',
]);
/** The statuses that hold the stage lock (uq_solution_deployments_active). */
const ACTIVE_STATUSES = Object.freeze(['queued', 'approved', 'preparing', 'committing', 'converging', 'compensating']);
const TERMINAL_STATUSES = Object.freeze(['succeeded', 'succeeded_with_warnings', 'failed', 'cancelled', 'rejected']);

const TRANSITIONS = Object.freeze({
    awaiting_approval: Object.freeze(['approved', 'rejected', 'cancelled']),
    queued: Object.freeze(['preparing', 'cancelled']),
    approved: Object.freeze(['preparing', 'cancelled']),
    preparing: Object.freeze(['committing', 'compensating', 'failed']),
    committing: Object.freeze(['converging', 'compensating', 'failed']),
    converging: Object.freeze(['succeeded', 'succeeded_with_warnings']),
    succeeded_with_warnings: Object.freeze(['converging']),
    compensating: Object.freeze(['failed']),
    succeeded: Object.freeze([]),
    failed: Object.freeze([]),
    cancelled: Object.freeze([]),
    rejected: Object.freeze([]),
});

function canTransition(from, to) {
    return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

/** Throws a 409 `invalid_transition` for a move the machine does not have. */
function assertTransition(from, to) {
    if (canTransition(from, to)) return;
    const { HttpError } = require('../../core/http/errors');
    throw new HttpError(409, 'invalid_transition', `A deployment cannot go from ${from} to ${to}.`, { from, to });
}

const isActiveStatus = (status) => ACTIVE_STATUSES.includes(status);
const isTerminalStatus = (status) => TERMINAL_STATUSES.includes(status);

const refusal = (code) => ({ ok: false, code });
const OK = Object.freeze({ ok: true, code: null });

/**
 * May this stage receive this release (design 6.2)?
 *
 * - UAT: any pipeline release of the Solution whose gate is clean.
 * - PRD: the release succeeded in UAT (`testedInUat`) and its gate is clean; a
 *   rollback must target a release that succeeded in PRD before
 *   (`succeededInPrd`).
 * - A redeploy re-applies the release the stage runs now.
 * - Authority (D12): the actor is the Solution owner, and run-as is the actor.
 *   Both checks run only when the caller passes the ids.
 * - `settings` and `remove` carry no release.
 *
 * @param {{ stage: string, kind?: string, release?: {id?: string, channel?: string, gate?: object}|null,
 *   testedInUat?: boolean, succeededInPrd?: boolean, currentReleaseId?: string|null,
 *   actorId?: string|null, solutionOwnerId?: string|null, runAsUserId?: string|null }} input
 * @returns {{ ok: boolean, code: string|null }}
 */
function eligibleForStage({
    stage, kind = 'deploy', release = null, testedInUat = false, succeededInPrd = false,
    currentReleaseId = null, actorId = null, solutionOwnerId = null, runAsUserId = null,
} = /** @type {any} */ ({})) {
    if (!STAGES.includes(stage)) return refusal('stage_invalid');
    if (!KINDS.includes(kind)) return refusal('kind_invalid');
    if (actorId && solutionOwnerId && actorId !== solutionOwnerId) return refusal('solution_owner_only');
    if (actorId && runAsUserId && actorId !== runAsUserId) return refusal('run_as_mismatch');
    if (!RELEASE_KINDS.includes(kind)) return OK;

    if (!release || !release.id) return refusal('release_not_found');
    if (release.channel && release.channel !== 'pipeline') return refusal('release_not_pipeline');
    if (!release.gate || release.gate.blocked !== false) return refusal('release_blocked');
    if (kind === 'redeploy' && release.id !== currentReleaseId) return refusal('redeploy_target_invalid');
    if (stage === 'prd') {
        if (kind === 'rollback') return succeededInPrd ? OK : refusal('rollback_target_invalid');
        if (!testedInUat) return refusal('release_not_in_uat');
    }
    return OK;
}

/**
 * Does this deployment pass the PRD approval gate (design 6.2, 6.6, D19)?
 *
 * Only PRD, only with `requires_approval` on. Then every deploy, redeploy
 * (bindings and steering variables decide whose credentials and who approves),
 * settings change and removal needs it; a rollback needs it when
 * `rollback_needs_approval` is on as well. UAT never does.
 *
 * `stage` is 'uat' | 'prd' or a stage row (`{ stage, requiresApproval,
 * rollbackNeedsApproval }`), whose settings are used when none are passed.
 *
 * @param {{ stage: string|{stage: string, requiresApproval?: boolean, rollbackNeedsApproval?: boolean},
 *   kind: string, settings?: {requiresApproval?: boolean, rollbackNeedsApproval?: boolean}|null }} input
 */
function needsApproval({ stage, kind, settings = null } = /** @type {any} */ ({})) {
    const row = stage && typeof stage === 'object' ? stage : null;
    const name = row ? row.stage : stage;
    const s = settings || row || {};
    if (name !== 'prd' || s.requiresApproval !== true) return false;
    if (kind === 'rollback') return s.rollbackNeedsApproval === true;
    return ['deploy', 'redeploy', 'settings', 'remove'].includes(kind);
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/**
 * JSON with sorted keys, `undefined` and functions left out (as JSON does),
 * so two equal documents give one string whatever order their keys were
 * written in (jsonb does not keep key order).
 */
function stableStringify(value) {
    if (value === undefined || typeof value === 'function') return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (typeof value.toJSON === 'function') return stableStringify(value.toJSON());
    if (Array.isArray(value)) return `[${value.map(v => (v === undefined || typeof v === 'function' ? 'null' : stableStringify(v))).join(',')}]`;
    const keys = Object.keys(value).filter(k => value[k] !== undefined && typeof value[k] !== 'function').sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256(text) {
    return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** `sha256:<hex>` of a value's stable form: the one hash of the engine. */
function hashOf(value) {
    return `sha256:${sha256(stableStringify(value))}`;
}

/**
 * The plan hash (design 6.3): what a deployment was planned against. Admission
 * and an approved deployment recompute the plan and compare this, so anything
 * that changes what a deploy does must be in it. Beyond the design's list it
 * covers the kind, the release and a settings patch, so a plan for another
 * release or another patch can never pass as this one.
 */
function planHash(plan) {
    const p = plan || {};
    return hashOf({
        kind: p.kind ?? null,
        releaseId: p.release?.id ?? null,
        parts: p.parts ?? [],
        data: p.data ?? [],
        referenceRows: p.referenceRows ?? [],
        knowledge: p.knowledge ?? [],
        bindings: p.bindings ?? null,
        variables: p.variables ?? null,
        settingsVersion: p.settingsVersion ?? null,
        fromReleaseId: p.from?.releaseId ?? p.fromReleaseId ?? null,
        settingsPatch: p.settingsPatch ?? null,
        deleteData: p.deleteData ?? null,
    });
}

module.exports = {
    STAGES, KINDS, RELEASE_KINDS, STATUSES, ACTIVE_STATUSES, TERMINAL_STATUSES, TRANSITIONS,
    canTransition, assertTransition, isActiveStatus, isTerminalStatus,
    eligibleForStage, needsApproval,
    stableStringify, sha256, hashOf, planHash,
};
