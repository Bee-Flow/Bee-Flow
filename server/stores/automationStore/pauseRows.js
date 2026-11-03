// @typecheck strict
/**
 * pauseRows.js: the rows a person touches when they end a run's pause (the
 * paused step row, the journey's visitor session), as the automationStore
 * facade exposes them. The SQL lives in pauseRowStore.mts; this file only
 * gives it the pool.
 */

const { initDB, pool } = require('./core');
// Node strips the types of a .mts file on load, and require() takes an ES module.
const { makePauseRowStore } = require('./pauseRowStore.mts');

const store = makePauseRowStore({ query: (sql, params) => pool.query(sql, params) }, { ready: initDB });

module.exports = {
    closeAwaitingStepRow: store.closeAwaitingStepRow,
    getFormSessionsForJourney: store.getFormSessionsForJourney,
    endFormSessionForRun: store.endFormSessionForRun,
};
