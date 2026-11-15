// @typecheck strict
'use strict';

/**
 * GET /api/ready: the readiness probe. 200 { ready: true } when this process
 * can serve a request, 503 { ready: false, reason } when it cannot:
 *
 *   starting       the boot work (store schemas, migration ladders) has not ended
 *   database       the database did not answer
 *   schema         the database answers, the core tables are not there
 *   shutting_down  SIGTERM / SIGINT arrived and the process is draining
 *
 * /api/health stays the liveness answer (200 for as long as the process runs)
 * and /api/health/schema keeps its "always 200" contract. This is the route an
 * orchestrator may take a replica out of rotation on, so it checks only what
 * this process itself needs to answer: its own lifecycle (utils/runtimeState.mts),
 * the database and the schema sentinel. No sidecar: a guard or classifier that
 * is down must not take the server out of rotation with it.
 *
 * Unauthenticated like the two health routes (a probe runs before any session
 * exists), so the body is the coarse reason and nothing else: no table names,
 * no error text, no build stamp.
 *
 * The database is asked through the schema probe's cache: a healthy answer is
 * good for 30 s, an unhealthy one for 2 s, so a poller cannot hammer the
 * database and a fresh replica is not held back by one early look.
 *
 * No zod schema, for the reason routes/healthSchema.js gives: the probe reads
 * nothing from the request, and a monitor that adds `?t=` must not get a 400.
 */

const express = require('express');
const { readiness } = require('../utils/runtimeState.mts');
const { getSchemaHealth } = require('./healthSchema');

const FAILURE_TTL_MS = 2000;

/** @returns {Promise<{ ready: true } | { ready: false, reason: string }>} */
async function readinessAnswer() {
    const lifecycle = readiness();
    // Before the database: a process that is starting or leaving is not ready whatever the database says.
    if (!lifecycle.ready) return { ready: false, reason: lifecycle.reason || 'starting' };
    const { ok, schemaReady } = await getSchemaHealth({ failureTtlMs: FAILURE_TTL_MS });
    if (!ok) return { ready: false, reason: 'database' };
    if (!schemaReady) return { ready: false, reason: 'schema' };
    return { ready: true };
}

const router = express.Router();

router.get('/', async (/** @type {import('express').Request} */ _req, /** @type {import('express').Response} */ res) => {
    const answer = await readinessAnswer();
    res.status(answer.ready ? 200 : 503).json(answer);
});

module.exports = router;
