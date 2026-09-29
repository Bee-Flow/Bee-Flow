/**
 * The access filter the mirror engine writes the COPY with: OWNER grade, no
 * viewer. A refresh, an event patch and the second half of a write-through
 * all rewrite rows on the table's own authority — exactly as the retention
 * sweep does (jobs/datatableRetention.js ownerFilter) — because there is no
 * person there, only the source. The CALLER's own filter is a different
 * thing and stays in writeThrough.js (the probe before the source is asked).
 */

'use strict';

const accessFilter = require('../../accessFilter');
const { PG } = require('./constants');

function ownerFilter(meta, action = 'read') {
    return accessFilter.compileAccessFilter(meta, 'owner', { id: null }, action, PG);
}

module.exports = { ownerFilter };
