/**
 * App Studio validator — helpers shared by the validate/ modules.
 */

'use strict';

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

module.exports = { isObject };
