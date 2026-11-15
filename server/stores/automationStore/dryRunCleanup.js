// @typecheck strict
/**
 * dryRunCleanup.js: removing a dry run whose data may not be kept, as the
 * automationStore facade exposes it (usecases/automation/windmillCompare.mts).
 */

const { initDB, pool } = require('./core');

/**
 * Delete one finished DRY run and the legs of its journey, for a dry run whose
 * data may not be kept (the Windmill comparison runs real customer input and
 * keeps only a summary unless the person saves the runs as test data). Steps,
 * full outputs and test rows cascade; run tables lose their run and the
 * reaper takes them, as with run retention. A live run, a run of another
 * automation and a run that has not finished are never touched.
 * @param {string} automationId
 * @param {string} rootRunId
 * @returns {Promise<number>} the number of runs deleted
 */
async function deleteFinishedDryRun(automationId, rootRunId) {
    await initDB();
    const { rowCount } = await pool.query(
        `DELETE FROM automation_runs
          WHERE automation_id = $1
            AND COALESCE(root_run_id, id) = $2
            AND mode = 'dry_run'
            AND status IN ('success', 'error', 'cancelled')`,
        [automationId, rootRunId],
    );
    return rowCount || 0;
}

module.exports = { deleteFinishedDryRun };
