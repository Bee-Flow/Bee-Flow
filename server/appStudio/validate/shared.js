/**
 * App Studio validator — helpers shared by the validate/ modules.
 */

'use strict';

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Data-reference finding — an error normally (publish), demoted to a warning
// when the caller opted in via opts.dataRefsAsWarnings (human draft saves).
function pushDataRef(ctx, rec) {
    if (ctx.dataRefsAsWarnings) ctx.pushW({ ...rec, severity: 'warning' });
    else ctx.pushE(rec);
}

module.exports = { isObject, pushDataRef };
