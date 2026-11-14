// @typecheck strict
/**
 * App Studio public surface: the usage row of a public visitor's step
 * (routes/studioAppPublic.js, source studio_app_public).
 *
 * The work happens under the OWNER, so the row is theirs, the same row as a
 * signed-in step (usecases/studioAppsRunUsage.js). A public visitor is nobody's
 * account: the row has no actor, never a guessed one.
 */

'use strict';

const usageStore = require('../stores/usageStore');
const { bestEffort } = require('../utils/bestEffort');
const { actionUsageRow } = require('./studioAppsRunUsage');

/** @typedef {import('./studioAppsRunUsage').UsageApp} UsageApp */

/**
 * The zero-token usage row of one public step.
 * @param {UsageApp} app
 * @param {number} startedAt
 */
function publicStepUsageRow(app, startedAt) {
    return actionUsageRow(app, { actorUserId: null, startedAt, source: 'studio_app_public' });
}

/**
 * Write the usage row of one public step (fire-and-forget: a failed write is
 * logged, never thrown).
 * @param {UsageApp} app
 * @param {number} startedAt
 * @returns {void}
 */
function logPublicStepUsage(app, startedAt) {
    usageStore.logUsage(publicStepUsageRow(app, startedAt))
        .catch((/** @type {unknown} */ e) => bestEffort('routes/studioAppPublic:anon', e));
}

module.exports = { publicStepUsageRow, logPublicStepUsage };
