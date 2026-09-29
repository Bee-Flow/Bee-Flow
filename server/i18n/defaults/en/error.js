// English GUI defaults — namespace "error": every key whose part before the first "." is "error".
// Merged into GUI_DEFAULTS by ./index.js. The frontend copy (agent-hub/src/i18n/en-defaults.js)
// is GENERATED from these files: after an edit, run `node scripts/gen-i18n-defaults.mjs`.
module.exports = {
    'error.automation_run_timeout_exceeded_max': 'Run exceeded the configured timeout. Increase the per-automation timeout in expert settings, or split the work into smaller steps.',

    // ── Errors ───────────────────────────────────────────────────
    'error.network': 'Network error. Please check your connection.',
    'error.server': 'Server error. Please try again.',
    'error.not_found': 'Not found',
    'error.unauthorized': 'You are not authorized to perform this action.',
    'error.session_expired': 'Your session has expired. Please sign in again.',
};
