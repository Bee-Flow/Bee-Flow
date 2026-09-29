/**
 * App Studio data model — helper shared by the dataModel/ modules.
 */

'use strict';

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

module.exports = { isPlainObject };
