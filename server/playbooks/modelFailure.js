/**
 * WHEN A PLAYBOOK'S MODEL CALL FAILS: what the person sees, and what the
 * operator's log keeps.
 *
 * The provider's own words (an internal host and port, a provider's request
 * id, a proxy's error page) and a config store's (a database host) are for
 * the operator. The person gets a fixed sentence and an id to quote; the log
 * gets the whole error under that same id, the way
 * core/http/terminalErrorHandler ties a client's refusal to its log line. The
 * id is the request's own (the one on its X-Request-Id header) when there is
 * a request, a fresh one otherwise.
 *
 * Compose, the design phase and the access assistant each answered
 * `The model could not be reached: ${e.message}`, and the design phase also
 * stored that text as the phase's error on the playbook row.
 */

'use strict';

const { randomUUID } = require('node:crypto');
const log = require('../telemetry/log');

const UNREACHABLE_TEXT = 'The model could not be reached. Try again in a moment.';
const LOOKUP_TEXT = 'The model for this tier could not be looked up. Try again in a moment.';

function refuseLogged(line, err, refusal) {
    const correlationId = log.currentRequestId() || randomUUID();
    log.error(`${line} correlationId=${correlationId}`, err);
    return { ok: false, ...refusal, correlationId };
}

/**
 * The model call itself failed. `what` names the call in the log line
 * ('compose', 'design', 'access plan'); `code` and `status` are the refusal's.
 */
function modelUnreachable({ what, code, modelId, err, status = null }) {
    return refuseLogged(`[Playbooks] ${what}: the model could not be reached (model=${modelId})`, err, {
        code, ...(status ? { status } : {}), error: UNREACHABLE_TEXT,
    });
}

/**
 * Reading which model serves the tier failed: the config could not be read.
 * That is not "no model is configured" (resolveModelForTierName RETURNS null
 * for that), so it is refused as unavailable rather than named as missing.
 */
function modelLookupFailed({ what, err }) {
    return refuseLogged(`[Playbooks] ${what}: the model for this tier could not be looked up`, err, {
        code: 'model_unavailable', error: LOOKUP_TEXT,
    });
}

module.exports = { modelUnreachable, modelLookupFailed, UNREACHABLE_TEXT, LOOKUP_TEXT };
