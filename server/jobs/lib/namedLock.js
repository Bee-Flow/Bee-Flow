// @typecheck strict
/**
 * Re-export: the named advisory lock lives in core/scheduling/namedLock.js,
 * because the automation runner's Meet import tick (core) takes one too and
 * core may not require a feature (server/ARCHITECTURE.md).
 */

'use strict';

module.exports = require('../../core/scheduling/namedLock');
