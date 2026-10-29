// @typecheck strict
/**
 * The deployment runner's records (runner.js): what a row stores as its
 * settings patch, who asked, which acknowledgements are still missing, and
 * what a failed row records.
 */

'use strict';

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * What the row stores as its settings patch: the gate change of a `settings` row; for a `remove`, the flag the PLAN carries.
 * @param {string} kind
 * @param {unknown} settingsPatch
 * @param {{ deleteData?: unknown } | null | undefined} plan
 */
function storedPatchOf(kind, settingsPatch, plan) {
    if (kind === 'remove') return plan && plan.deleteData === true ? { deleteData: true } : null;
    return kind === 'settings' ? (settingsPatch || null) : null;
}

/**
 * @param {string | { id: string; }} actor
 */
const actorIdOf = (actor) => (typeof actor === 'string' ? actor : (actor && actor.id) || null);

/**
 * An acknowledgement the requester gave covers a required one with the same code (and ref, when it has one).
 * @param {unknown} required  the plan's acknowledgementsRequired
 * @param {unknown} given  what the requester acknowledged
 */
function missingAcknowledgements(required, given) {
    const list = (Array.isArray(given) ? given : []).map(g => (typeof g === 'string' ? { code: g } : g)).filter(isObject);
    return (Array.isArray(required) ? required : []).filter((r) => {
        const need = typeof r === 'string' ? { code: r } : r;
        return !list.some(g => g.code === need.code && (need.ref == null || g.ref === need.ref));
    });
}

/**
 * What a failed row records: a code, a message we wrote, refs and finding codes; never a stack or content.
 * @param {{ code?: unknown, expose?: unknown, message?: unknown, details?: unknown } | null | undefined} err  an HttpError, or whatever was thrown
 * @returns {import('./runner').DeploymentError}
 */
function errorOf(err) {
    const code = err && typeof err.code === 'string' && err.code ? err.code : 'deployment_failed';
    const exposed = err && err.expose === true && typeof err.message === 'string';
    /** @type {import('./runner').DeploymentError} */
    const out = { code, message: exposed ? /** @type {string} */ (err.message) : 'The deployment failed. Nothing changed in the stage.' };
    const d = err && isObject(err.details) ? err.details : null;
    if (d && typeof d.ref === 'string') out.ref = d.ref;
    if (d && typeof d.why === 'string') out.why = d.why;
    if (d && Array.isArray(d.findings)) out.findings = d.findings.slice(0, 50).map(f => ({ code: f.code, ...(f.ref ? { ref: f.ref } : {}) }));
    return out;
}

module.exports = { isObject, storedPatchOf, actorIdOf, missingAcknowledgements, errorOf };
