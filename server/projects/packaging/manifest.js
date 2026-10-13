/**
 * Moved to core/packaging/manifest.js (the packaging leaves live in core/, so
 * appStudio/ and automation/ can use them without a cycle through projects/).
 * This re-export keeps the old path working; new code requires the core path.
 */

'use strict';

module.exports = require('../../core/packaging/manifest');
