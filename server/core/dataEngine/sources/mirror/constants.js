/**
 * The numbers every source mirror runs on — ONE set for every kind, because
 * they describe the engine underneath (what one pass can read back, how many
 * statements one batch may carry, how live "live" is), not the source.
 *
 * Kept here rather than on each adapter so a second kind cannot quietly pick
 * a row cap the id snapshot could not verify (ENGINE_READ_CAP is the SELECT
 * ceiling of pgAppEngine, and the snapshot is a SELECT).
 */

'use strict';

const PG = { dialect: 'pg' };

// pgAppEngine caps a SELECT at 10 000 rows, and the id snapshot is a SELECT:
// a mirror bigger than that could not compute its own deletions. The cap is
// therefore that number, tunable DOWN, never up. The old NC-specific env
// name is still honoured so a deployment that set it keeps its cap.
const ENGINE_READ_CAP = 10_000;
const DEFAULT_ROW_CAP = Math.min(
    ENGINE_READ_CAP,
    parseInt(process.env.DATATABLE_MIRROR_ROW_CAP, 10) || parseInt(process.env.DATATABLE_NC_ROW_CAP, 10) || ENGINE_READ_CAP,
);
// pgAppEngine.batch refuses more than 500 statements per call.
const WRITE_CHUNK = 500;
const DEFAULT_MINUTES = 15;
// The fastest a mirror may be polled. One minute, not the connectors' 15:
// the ticker is advisory-locked (one replica scans), a pass on an unchanged
// source is one metadata call, and the point of a mirror is to be close to
// what the source has. `live` sits on top of it (see staleness.isStale).
const MIN_MIRROR_MINUTES = 1;
const MAX_MIRROR_MINUTES = 7 * 24 * 60;
// A mirror is LIVE: while somebody has it open the client pulses
// (GET /:id/source/pulse) every few seconds and each pulse re-checks the
// source — but never twice inside this window: a grid, its filters, its
// count and two colleagues all pulse at once, and one pass answers them all.
// One constant for every kind: a pulse re-check on a file is one metadata
// call, not a download.
const LIVE_STALE_MS = 5_000;
// A pass that has held its claim this long is presumed dead (a replica that
// went away mid-fetch) and may be taken over.
const CLAIM_STALE_MS = 10 * 60 * 1000;
// One pending kick per mirror: a burst of opens (a grid, its filters, its
// count) is one refresh, KICK_DEBOUNCE_MS after the first.
const KICK_DEBOUNCE_MS = 5000;
const MAX_ERROR_LEN = 500;

module.exports = {
    PG,
    ENGINE_READ_CAP,
    DEFAULT_ROW_CAP,
    WRITE_CHUNK,
    DEFAULT_MINUTES,
    MIN_MIRROR_MINUTES,
    MAX_MIRROR_MINUTES,
    LIVE_STALE_MS,
    CLAIM_STALE_MS,
    KICK_DEBOUNCE_MS,
    MAX_ERROR_LEN,
};
