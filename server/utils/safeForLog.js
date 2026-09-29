// @typecheck
'use strict';

/**
 * Anything a remote caller controls becomes untrusted input the moment it is
 * written to a log: truncate it and strip control characters so a crafted
 * header cannot forge extra log records or bloat every line of the log.
 */
function safeForLog(value, max = 120) {
    return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, max);
}

module.exports = { safeForLog };
