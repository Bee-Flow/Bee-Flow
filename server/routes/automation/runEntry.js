// @typecheck strict
'use strict';

/**
 * Which definition a run enters, and which trigger of it: entryDefinitionOf(a)
 * and resolveTriggerStepId(def, triggerStepId), moved out of runs.js. The code
 * lives in core/automationRunner/entryPoint.js so that automation/ (the MCP
 * tools) can use it without requiring a route.
 */
module.exports = require('../../core/automationRunner/entryPoint');
