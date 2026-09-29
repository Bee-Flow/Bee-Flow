/**
 * ONE FULL PASS over a spreadsheet mirror — the shared pipeline
 * (../mirror/syncPipeline explains the eleven steps and why their order is
 * the correctness) driven by this kind's adapter. What is a file's is in
 * adapter.open(): the marker probe that answers "unchanged" before any
 * download, the read through the download cache, the content hash, the row
 * ids. Nothing here knows a storage.
 *
 * Exports the same surface as the Nextcloud twin: `syncRows`, `isStale`,
 * `kickStale`, `nextRunAtFor`, `scheduleOf`, `siblingsOf`, the constants and
 * the `_kicks` map (shared by every kind).
 */

'use strict';

const { makeSync } = require('../mirror/syncPipeline');
const adapter = require('./adapter');

module.exports = makeSync(adapter);
