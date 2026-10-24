/**
 * Moved to utils/nextcloudTarget.js: core/kb/fetchGuard.js shares its metadata
 * host list, and core may not require a feature. This re-export keeps the old
 * require path working; new code requires the utils module directly.
 */

'use strict';

module.exports = require('../utils/nextcloudTarget');
