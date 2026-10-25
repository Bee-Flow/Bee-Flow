// @typecheck noImplicitAny
'use strict';

/**
 * GET /api/health/schema — schema health probe that DEGRADES, never crashes.
 *
 * Always answers HTTP 200 with a small JSON object { ok, schemaReady, build }:
 *   - ok          : the database answered the probe
 *   - schemaReady : all sentinel core tables exist according to information_schema
 *   - build       : the build stamp (utils/buildInfo), so that a deploy smoke check
 *                   can verify both version and schema in one call
 *
 * The endpoint is deliberately unauthenticated (deploy pipelines and orchestrators
 * poll it before any sessions exist), so the response NEVER contains table names
 * or error text — an unreachable database gives only ok:false plus a
 * log line server-side. Compare the sanity probe in boot/startupTasks.js, which historically did process.exit(1): this is the non-fatal variant.
 *
 * The outcome is cached in-process for ~30 s (failures too), so that an aggressive poller or a liveness loop does not hammer the database.
 *
 * ── Deliberately NO zod schema ──────────────────────────────────────
 *
 * The probe reads nothing from the request, and its contract is "always 200":
 * mobile/src/api/server.ts reads everything except a 200 as "unknown" or "server too old", and selfhost.sh and deploy pipelines wait for it.
 * A strict query would turn a cache-buster or a monitor that adds `?t=` into a 400 — a healthy server that looks unhealthy, over a key that could not change the answer.
 */

const express = require('express');
const db = require('../db');
const { APP_BUILD_SHA } = require('../utils/buildInfo');
const log = require('../telemetry/log');

// Cheap sentinel: a cross-section of core tables from different store owners. If these four exist, the migration ladder has run.
const SENTINEL_TABLES = ['users', 'agents', 'automations', 'direct_conversations'];

const CACHE_TTL_MS = 30_000;

/** @type {{ at: number; ok: boolean; schemaReady: boolean; } | { at: number; ok: boolean; schemaReady: boolean; } | null} */
let _cache = null;     // { ok, schemaReady, at }
/** @type {Promise<{ at: number; ok: boolean; schemaReady: boolean; } | { at: number; ok: boolean; schemaReady: boolean; }> | null} */
let _inflight = null;  // promise-memo: gelijktijdige polls delen één query

async function _probe() {
    const rows = await db.getAll(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
        [SENTINEL_TABLES],
    );
    const present = new Set(rows.map((r) => r.table_name));
    return { ok: true, schemaReady: SENTINEL_TABLES.every((t) => present.has(t)) };
}

/**
 * Cachende, nooit-werpende schema-check. Exported voor hergebruik (bv. een
 * toekomstige readiness-gate) en voor de colocated test.
 * @returns {Promise<{ok: boolean, schemaReady: boolean}>}
 */
function getSchemaHealth() {
    if (_cache && (Date.now() - _cache.at) < CACHE_TTL_MS) return Promise.resolve(_cache);
    if (!_inflight) {
        _inflight = _probe()
            .catch((err) => {
                // Degrade, do not crash — and the detail stays server-side.
                log.warn('[HealthSchema] schema-probe faalde:', err && err.message);
                return { ok: false, schemaReady: false };
            })
            .then((result) => {
                _cache = { ...result, at: Date.now() };
                _inflight = null;
                return _cache;
            });
    }
    return _inflight;
}

const router = express.Router();

router.get('/', async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
    const { ok, schemaReady } = await getSchemaHealth();
    res.json({ ok, schemaReady, build: APP_BUILD_SHA });
});

module.exports = router;
/** @type {import('express').Router & Record<string, unknown>} */ (module.exports).getSchemaHealth = getSchemaHealth;
// Alleen voor tests: de 30s-cache tussen cases legen.
/** @type {import('express').Router & Record<string, unknown>} */ (module.exports)._resetCache = () => { _cache = null; _inflight = null; };
