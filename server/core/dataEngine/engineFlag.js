// Moved to utils/engineFlag.js — a flag with no dependencies, so the platform layer may read it (layering.test.js).
// Kept so existing require paths resolve; new code requires the new path.
module.exports = require('../../utils/engineFlag');
