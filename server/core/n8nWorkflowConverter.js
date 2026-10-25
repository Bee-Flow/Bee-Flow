// @typecheck noImplicitAny
/**
 * Re-export shim: this module moved to core/kb/n8nWorkflowConverter.js (the core/ layout in
 * server/ARCHITECTURE.md). Kept so every existing require, test stub and
 * require.cache key on the old path keeps working; new code requires the new path.
 */
module.exports = require('./kb/n8nWorkflowConverter');
