// @typecheck
/**
 * The operator switch for the legacy user_sessions OAuth fallback of unattended
 * runs: AUTOMATION_AUTH_LEGACY ('0' turns the fallback off, '1' forces the
 * old session-borrow path where a caller offers one).
 *
 * The variable was ROUTINE_AUTH_LEGACY until 2026-10. An install that set the
 * old name to '0' did so to keep browser-session tokens out of unattended
 * runs; reading only the new name would silently turn that fallback back on.
 * So the old name still counts when the new one is unset, with one warning.
 */

'use strict';

let warned = false;

/** The switch's value, or undefined when neither name is set. */
function automationAuthLegacy() {
    if (process.env.AUTOMATION_AUTH_LEGACY !== undefined) return process.env.AUTOMATION_AUTH_LEGACY;
    const old = process.env.ROUTINE_AUTH_LEGACY;
    if (old !== undefined && !warned) {
        warned = true;
        require('../telemetry/log').warn('[Config] ROUTINE_AUTH_LEGACY is deprecated: rename it to AUTOMATION_AUTH_LEGACY (same values).');
    }
    return old;
}

module.exports = { automationAuthLegacy };
