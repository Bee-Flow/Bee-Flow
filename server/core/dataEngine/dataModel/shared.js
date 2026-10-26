// @typecheck strict
/**
 * App Studio data model — helper shared by the dataModel/ modules.
 */

'use strict';

function isPlainObject(/** @type {unknown} */ v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

module.exports = { isPlainObject };
