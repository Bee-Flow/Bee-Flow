'use strict';

/**
 * GET /api/health/schema — schema-gezondheidsprobe die DEGRADEERT, nooit crasht.
 *
 * Antwoordt ALTIJD HTTP 200 met een klein JSON-object { ok, schemaReady, build }:
 *   - ok          : de database heeft de probe beantwoord
 *   - schemaReady : alle sentinel-kerntabellen bestaan volgens information_schema
 *   - build       : de buildstempel (utils/buildInfo), zodat een deploy-smokecheck
 *                   in één call versie én schema kan verifiëren
 *
 * Het endpoint is bewust ongeauthenticeerd (deploy-pipelines en orchestrators
 * pollen het vóór er sessies bestaan), dus de response bevat NOOIT tabelnamen
 * of fouttekst — een onbereikbare database geeft alleen ok:false plus een
 * logregel server-side. Vergelijk de sanity-probe in boot/startupTasks.js die
 * historisch process.exit(1) deed: dít is de niet-fatale variant.
 *
 * De uitkomst wordt ~30 s in-proces gecachet (ook een mislukking), zodat een
 * agressieve poller of een liveness-loop de database niet lastigvalt.
 *
 * ── Bewust GEEN zod-schema ──────────────────────────────────────────
 *
 * De probe leest niets uit het verzoek, en haar contract is "altijd 200":
 * mobile/src/api/server.ts leest alles behalve een 200 als "onbekend" of
 * "server te oud", en selfhost.sh en deploy-pipelines wachten op haar.
 * Een strikte query zou van een cache-buster of een monitor die `?t=`
 * toevoegt een 400 maken — een gezonde server die ongezond oogt, om een
 * sleutel die aan het antwoord niets kon veranderen.
 */

const express = require('express');
const db = require('../db');
const { APP_BUILD_SHA } = require('../utils/buildInfo');
const log = require('../telemetry/log');

// Goedkope sentinel: een dwarsdoorsnede van kerntabellen uit verschillende
// store-eigenaren. Bestaan deze vier, dan heeft de migratieladder gedraaid.
const SENTINEL_TABLES = ['users', 'agents', 'automations', 'direct_conversations'];

const CACHE_TTL_MS = 30_000;

let _cache = null;     // { ok, schemaReady, at }
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
                // Degraderen, niet crashen — en het detail blijft server-side.
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

router.get('/', async (req, res) => {
    const { ok, schemaReady } = await getSchemaHealth();
    res.json({ ok, schemaReady, build: APP_BUILD_SHA });
});

module.exports = router;
module.exports.getSchemaHealth = getSchemaHealth;
// Alleen voor tests: de 30s-cache tussen cases legen.
module.exports._resetCache = () => { _cache = null; _inflight = null; };
