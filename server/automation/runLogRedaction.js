// @typecheck
/**
 * Re-export: the implementation lives in core/automationModel/runLogRedaction.js, below the
 * features, so core can use it (core may not require a feature,
 * server/ARCHITECTURE.md). Kept for the callers outside core.
 */

'use strict';

module.exports = require('../core/automationModel/runLogRedaction');
