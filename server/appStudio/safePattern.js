/**
 * Moved to core/text/safePattern.js: the Privacy Shield's own-data patterns
 * use the same check as file_intake, and neither is an App Studio concern.
 * This re-export keeps the existing require('./safePattern') call sites.
 */
module.exports = require('../core/text/safePattern');
