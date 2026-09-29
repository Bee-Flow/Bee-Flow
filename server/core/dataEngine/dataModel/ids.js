/**
 * App Studio data model — id minting: the stable tbl_/fld_/conn_ identities the
 * migration diff relies on, and the runtime rec_ record id.
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

function hex6() {
    return crypto.randomBytes(3).toString('hex'); // 6 lowercase hex chars
}

function newTableId() { return `tbl_${hex6()}`; }
function newFieldId() { return `fld_${hex6()}`; }
function newConnectorId() { return `conn_${hex6()}`; }

/** Runtime record id (the value stored in the `id` PK column). */
function newRecordId() { return `rec_${crypto.randomBytes(9).toString('hex')}`; }

module.exports = {
    hex6,
    newTableId,
    newFieldId,
    newConnectorId,
    newRecordId,
};
