// @typecheck
/**
 * Degraded-mode handling — turning a guard's degraded reason into the kind of
 * failure the user is told about.
 */

/**
 * Which of three things went wrong, for the message the user reads.
 *
 * Every degraded reason used to collapse into "temporarily unavailable, try
 * again in a moment". For a transient model error that is true. For a 60,000-
 * character paste it is false and unhelpful in the same breath: retrying does
 * exactly the same amount of work and fails again, and nothing tells the user
 * that splitting the message would work. The distinction is not cosmetic — it
 * is the difference between advice that resolves the situation and advice that
 * guarantees a second failure.
 *
 * Note this changes only the COPY. All three remain fail-closed; a privacy
 * control does not get weaker because we can describe it better.
 */
function classifyDegradation(degradedReason) {
    const reason = String(degradedReason || '');
    if (/input_too_large/.test(reason)) return 'too_large';
    if (/timeout/i.test(reason)) return 'timeout';
    return 'unavailable';
}

module.exports = { classifyDegradation };
