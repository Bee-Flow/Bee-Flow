/**
 * The row engine this surface writes to, and the sizes it will move at once.
 *
 * Rows do not live in the `datatables` row — they live in a per-scope Postgres
 * schema addressed by a SCOPE KEY (`keyOf`). Everything else here is a number
 * this router refuses to go past, kept together so the caps can be read as one
 * list rather than hunted for across nine handlers.
 */

'use strict';

const datatableDbStore = require('../../stores/datatableDbStore');
const dataModel = require('../../core/dataEngine/dataModel/vocabulary');

// Rows always live in Postgres — see stores/datatableDbStore.js. Every compile
// on this path states that explicitly so a default self-host (whose App Studio
// engine flag says 'sqlite') cannot be handed SQLite SQL for a pg schema.
const PG = { dialect: 'pg' };

const DATA_LIMITS = dataModel.DATA_LIMITS;

// A page of rows. 500, not 50: a 100,000-row table read 50 at a time is 2,000
// requests against the 120/minute limiter below, which is a table nobody can
// actually page through. The compiler's own MAX_RESULT_ROWS still caps it.
const ROWS_PAGE_MAX = 500;
// Rows a single CSV export may stream. It pages with the keyset cursor, so this
// bounds the RESPONSE, not the page size.
const EXPORT_MAX_ROWS = 100_000;
// Rows one bulk import may carry, and the chunk each transaction writes.
// pgAppEngine.batch refuses more than 500 statements per call.
const BULK_MAX_ROWS = 5_000;
const BULK_CHUNK = 500;
// Rows one bulk delete may name. It is a selection made on screen, not a file:
// a page is 50 rows, so 200 is four pages, and it fits one engine batch (500).
const BULK_DELETE_MAX_IDS = 200;
// Rows one import into a Nextcloud MIRROR may carry: each is one Nextcloud
// call, so this bounds a request's duration, not a transaction's size.
const MIRROR_BULK_MAX_ROWS = 500;

// Ten years. Long enough for the statutory retention periods people actually
// cite (a seven-year tax obligation is the usual ceiling), short enough that a
// fat-fingered 36500 is a refusal rather than "never".
const MAX_RETENTION_DAYS = 3650;

/** The engine's tenant handle for a table's scope. */
function keyOf(scope) {
    return datatableDbStore.scopeKey(scope);
}

module.exports = {
    PG, DATA_LIMITS, keyOf,
    ROWS_PAGE_MAX, EXPORT_MAX_ROWS,
    BULK_MAX_ROWS, BULK_CHUNK, BULK_DELETE_MAX_IDS, MIRROR_BULK_MAX_ROWS,
    MAX_RETENTION_DAYS,
};
