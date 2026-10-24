// @typecheck
/**
 * Re-export shim: this module moved to core/http/serviceAuth.js (the core/ layout in
 * server/ARCHITECTURE.md). Kept so every existing require, test stub and
 * require.cache key on the old path keeps working; new code requires the new path.
 */
module.exports = require('./http/serviceAuth');
