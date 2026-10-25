// @typecheck strict
/**
 * Moved to core/automationModel/constants.js. The automation definition model is
 * pure (no stores, db or network) and core/ (the runner, agentRuntime) reads
 * it as much as the features do, so it lives below both. This re-export keeps
 * the old require path working; new code requires the core module directly.
 */

'use strict';

module.exports = require('../../core/automationModel/constants');
