/**
 * Moved to core/automationModel/automationCallDepth.js: core (skillInjection,
 * the tool dispatcher) reads the nested-call frame as much as the automation
 * feature does, so it lives below both. This re-export keeps the old require
 * path working; new code requires the core module directly.
 */

'use strict';

module.exports = require('../core/automationModel/automationCallDepth');
