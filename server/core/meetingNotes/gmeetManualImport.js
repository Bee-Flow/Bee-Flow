// @typecheck strict
/**
 * The background half of POST /from-gmeet (see manualImportRunner.js for why
 * a manual import cannot run inside the request): reserve a slot, reset the
 * job row for a fresh run, let the route answer 202, then run the shared
 * ingest detached. Access is checked again when the work starts; a failure
 * that the pipeline did not record itself lands on the job as a classified,
 * terminal error.
 */

const runner = require('./manualImportRunner');

const INGEST_LEASE_MINUTES = Number(process.env.GMEET_INGEST_LEASE_MINUTES) || 120;

/**
 * @param {string} jobId
 * @param {{ code?: string, message?: string } | null | undefined} err
 * @param {Record<string, number>} knownCodes the classified failure codes (code -> HTTP status)
 */
async function recordImportFailure(jobId, err, knownCodes) {
    const store = require('../../stores/gmeetImportStore');
    const fresh = await store.getJob(jobId);
    if (!fresh || fresh.status === 'ingested' || fresh.errorCode || fresh.status === 'awaiting_artifacts') return;
    await store.failJob(jobId, {
        errorCode: err?.code && err.code in knownCodes ? err.code : 'failed',
        terminal: true,
        lastError: String(err?.message || 'Google Meet import failed').slice(0, 500),
    });
}

/**
 * @param {{
 *   job: { id: string },
 *   userId: string,
 *   orgId: string | null,
 *   knownCodes: Record<string, number>,
 *   work: () => Promise<unknown>,
 *   accept: () => void,
 *   tooMany: () => Error,
 * }} args `accept` sends the 202; `tooMany` builds the error for a full user / org
 * @returns {Promise<'started' | 'already_running'>}
 */
async function startBackgroundImport({ job, userId, orgId, knownCodes, work, accept, tooMany }) {
    const slot = runner.acquire({ jobKey: `gmeet:${job.id}`, userId, orgId });
    if (slot.ok === false) {
        if (slot.reason !== 'already_running') throw tooMany();
        return 'already_running';
    }
    const store = require('../../stores/gmeetImportStore');
    try {
        // A fresh run: drop the previous outcome and keep the poller's tick off the row.
        await store.updateJob(job.id, { status: 'pending', errorCode: null, lastError: null });
        await store.heartbeatJob(job.id, INGEST_LEASE_MINUTES);
    } catch (err) {
        slot.release();
        throw err;
    }
    accept();
    void runner.runDetached({
        label: 'Transcriptions',
        release: slot.release,
        work,
        onFailure: (err) => recordImportFailure(job.id, /** @type {{ code?: string, message?: string }} */ (err), knownCodes),
    });
    return 'started';
}

module.exports = { startBackgroundImport };
