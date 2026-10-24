// @typecheck
/**
 * Which runs of a journey the caller may read.
 *
 * The files and the tables a run produced are read the same way: the credential
 * is the one every other run read uses (`runGuard(..., 'read')` plus
 * `assertCanReadRunData`), and the data is only ever looked up THROUGH the runs
 * returned here. An id from another run, another automation or another
 * organisation therefore resolves to nothing.
 */

'use strict';

const { HttpError } = require('../core/http/errors');
const { assertCanReadRunData, canReadRunData } = require('../core/automationModel/callerRunVisibility');
const { fallback } = require('../utils/bestEffort');

/**
 * @param {{ store: () => any, access: { roleFor: Function, runGuard: Function }, what?: string }} deps
 *   `store` is a getter so a test can swap the store per call; `what` completes
 *   the caller-private refusal ("... so only they can <what>").
 * @returns {(req: any, res: any, runId: string, what?: string) => Promise<{run: any, root: any, legs: any[], runIds: string[]}|null>}
 *   The run, once the caller is allowed to read its data, the root of its
 *   journey, every leg of it that they may read, and those legs' ids. A form or approval pause continues in
 *   a child run, and data made before the pause belongs to the same journey.
 *   Null after a 403 was written; throws a 404 for every way of not seeing it.
 */
function makeJourneyReader({ store, access, what: defaultWhat = 'see its files' }) {
    return async function readableJourney(req, res, runId, what = defaultWhat) {
        const me = req.session.user.id;
        const run = await store().getRun(runId);
        if (!run) throw new HttpError(404, 'run_not_found', 'Not found');
        // Not on this automation at all (another organisation, nobody shared it
        // with them): the run does not exist as far as they can tell.
        if (run.userId !== me) {
            const automation = await store().getAutomation(run.automationId).catch((e) => fallback('automation/journeyReader:makeJourneyReader', e, null));
            const { role } = await access.roleFor(automation, me, { session: req.session });
            if (!role) throw new HttpError(404, 'run_not_found', 'Not found');
        }
        if (!await access.runGuard(req, res, run, 'read')) return null;
        assertCanReadRunData(run, me, what);
        const chain = await store().getRunsInChain(run.id).catch(() => [run]);
        const all = chain.length ? chain : [run];
        const legs = all.filter(leg => leg.automationId === run.automationId && canReadRunData(leg, me));
        if (!legs.some(leg => leg.id === run.id)) legs.push(run);
        const rootId = run.rootRunId || run.id;
        const root = all.find(leg => leg.id === rootId)
            || all.find(leg => !leg.parentRunId)
            || run;
        return { run, root, legs, runIds: legs.map(leg => leg.id) };
    };
}

module.exports = { makeJourneyReader };
