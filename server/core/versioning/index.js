// @typecheck
/**
 * Versioning helpers shared by every item with a version history (notebooks,
 * Studio documents) and by the project change feed that reports on them.
 *
 *   retention.js     which old versions may be thinned out (pure)
 *   contributors.js  who took part in a version, in one shape (pure)
 *   stats.js         how much changed, as counts; content fingerprints
 *
 * Each store keeps its own table and routes; what they share is the meaning of
 * a version, which lives here so the two cannot drift apart.
 */

'use strict';

const retention = require('./retention');
const contributors = require('./contributors');
const stats = require('./stats');

module.exports = {
    selectPrunable: retention.selectPrunable,
    PROTECTED_SOURCES: retention.PROTECTED_SOURCES,
    normalizeContributor: contributors.normalizeContributor,
    mergeContributors: contributors.mergeContributors,
    contributorsFromUserIds: contributors.contributorsFromUserIds,
    hasAiContributor: contributors.hasAiContributor,
    versionStats: stats.versionStats,
    isMinorChange: stats.isMinorChange,
    addStats: stats.addStats,
    cleanStats: stats.cleanStats,
    contentHash: stats.contentHash,
    /** Every source a version may carry, in the order the history explains them. */
    VERSION_SOURCES: Object.freeze([
        'created', 'checkpoint', 'autosave', 'named', 'ai', 'restore', 'pre_restore', 'conflict', 'import', 'legacy',
    ]),
};
