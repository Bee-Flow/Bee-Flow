/**
 * ONE FULL PASS over a Nextcloud mirror — the shared pipeline
 * (../mirror/syncPipeline explains the eleven steps and why their order is
 * the correctness) driven by this kind's adapter. Nothing Nextcloud-shaped
 * lives here any more: the adapter says how to reach the table, what its
 * columns are and what one of its rows means; the pipeline does the rest.
 *
 * Every export the callers and the tests knew is kept: `syncRows`,
 * `isStale`, `kickStale`, `nextRunAtFor`, `scheduleOf`, `siblingsOf`, the
 * constants and the `_kicks` map (shared by every kind).
 */

'use strict';

const { makeSync } = require('../mirror/syncPipeline');
const adapter = require('./adapter');

module.exports = makeSync(adapter);
