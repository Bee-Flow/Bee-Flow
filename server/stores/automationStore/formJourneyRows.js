// @typecheck strict
/**
 * formJourneyRows.js: the rows of a paused form journey (the visitor session
 * held to the pause deadline, the "next page is ready" notice claimed once),
 * as the automationStore facade exposes them. The SQL lives in
 * formJourneyStore.mts; this file only gives it the pool.
 */

const { initDB, pool } = require('./core');
// Node strips the types of a .mts file on load, and require() takes an ES module.
const { makeFormJourneyStore } = require('./formJourneyStore.mts');

const store = makeFormJourneyStore({ query: (sql, params) => pool.query(sql, params) }, { ready: initDB });

module.exports = {
    formSessionsOfJourney: store.formSessionsOfJourney,
    extendFormSessionUntil: store.extendFormSessionUntil,
    claimFormPageNotice: store.claimFormPageNotice,
    settleFormPageNotice: store.settleFormPageNotice,
};
