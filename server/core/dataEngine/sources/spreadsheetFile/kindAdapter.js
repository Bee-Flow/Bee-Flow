// @typecheck strict
/**
 * The spreadsheet-file ADAPTER the registry (../index.js) hands to routes, jobs
 * and runners: adapter.js (what the sync pipeline drives) plus the four
 * modules built on top of it. The modules are LAZY getters: requiring the
 * registry, or this file, must never load a provider client.
 */

'use strict';

const core = require('./adapter');

const adapter = Object.create(core, {
    sync: { enumerable: true, get() { return require('./sync'); } },
    /**
     * The file first, then the copy (writeThrough.js): a read-only file is
     * refused before anything is probed, never written locally and swept by
     * the next pass.
     */
    writeThrough: { enumerable: true, get() { return require('./writeThrough'); } },
    link: { enumerable: true, get() { return require('./link'); } },
    /**
     * A storage push (events.js): a Nextcloud `file.*` event or a OneDrive
     * drive hint marks the mirror stale and kicks a pass — never a row patch,
     * a file event carries no row.
     */
    events: { enumerable: true, get() { return require('./events'); } },
});

module.exports = adapter;
