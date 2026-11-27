// @typecheck strict
/**
 * The startup jobs of the first-party module "datatables" (part "jobs" of firstParty/datatables.js;
 * contract in modules/firstParty/contract.js). Moved verbatim out of boot/startupJobs.js,
 * started by loader.runStartupPhase in the same phase, which logs a throw as
 * '[Server] <label> load failed:' like the old catch did.
 */

'use strict';

/** @type {import('../modules/firstParty/contract').JobRow[]} */
const jobs = [
    // Datatables that mirror a Nextcloud table: the scheduled refresh. The
    // other triggers (push events, opening the rows, "Refresh now") run the
    // same engine on demand; this is the safety net under them. Advisory-
    // locked; each mirror is additionally claimed per row.
    // Started only where Automations is available, as before: that guard is of
    // another module than this one (datatables only uses automation), so it stays.
    { key: 'datatables:ncMirrorSync', phase: 'startRunnersAndFeeds', label: 'Nextcloud mirror sync',
        start: () => {
            if (require('../modules/catalog').isModuleAvailable('automation')) require('../jobs/datatableNcSync').start();
        } },
];

module.exports = { jobs };
