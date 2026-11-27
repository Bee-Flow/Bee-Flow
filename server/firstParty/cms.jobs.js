// @typecheck strict
/**
 * The startup jobs of the first-party module "cms" (part "jobs" of firstParty/cms.js;
 * contract in modules/firstParty/contract.js). Moved verbatim out of boot/startupOneShots.js,
 * started by loader.runStartupPhase in the same phase.
 */

'use strict';

const log = require('../telemetry/log');

/** @type {import('../modules/firstParty/contract').JobRow[]} */
const jobs = [
    // Resized AVIF/WebP copies of CMS images uploaded before they existed:
    // at most 50 per boot, one at a time through the upload queue, a minute
    // after boot so it never competes with start-up. Fail-safe.
    { key: 'cms:assetVariantBackfill', phase: 'runOneShotTasks', label: 'Image variant backfill',
        start: () => {
            setTimeout(() => {
                const storageStore = require('../stores/storageStore');
                if (!storageStore.isAvailable()) return;
                require('../core/cms/assetVariantStore').backfillVariants(storageStore).catch((/** @type {Error} */ e) =>
                    log.warn('[Server] image variant backfill error:', e.message));
            }, 60 * 1000).unref();
        } },
];

module.exports = { jobs };
