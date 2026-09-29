// @typecheck
/**
 * Schema upgrades and backfills of the outbound-call ledger
 * (integration_activity_log). The store (integrationActivityStore.js) owns the
 * table itself and its warm-boot probe; this module holds what an EXISTING
 * table needs to reach the current shape:
 *
 *   upgradeSchema()          the one consolidated column ladder, the batched
 *                            dest_host / pii_scan_level backfills, the indexes
 *   startLocationBackfill()  DETACHED: gives every pre-rework row a location
 *                            state (see integrationLocationSql.js)
 *
 * ⚠ When adding a column below, point the store's warm-boot probe at it, or
 * existing installs skip the new DDL silently.
 */

'use strict';

const { run, getOne, getAll, exec } = require('../db');
const { runDdl } = require('./lib/_ddl');
const log = require('../telemetry/log');
const { LEGACY_STATE_CASE, IS_PRIVATE_PEER, DEST_EXPR } = require('./integrationLocationSql');

const BACKFILL_BATCH = 20000;
const BACKFILL_MAX_BATCHES = 500;

/** Stored as the column comment of location_state once every row has a state. */
const LOCATION_BACKFILL_DONE = 'location backfill: done';

async function upgradeSchema() {
    // One consolidated, idempotent column ladder (upgrades of existing tables).
    // Grouped in one statement: one lock acquisition, one catalog update.
    await exec(`
        ALTER TABLE integration_activity_log
            ADD COLUMN IF NOT EXISTS server_ip TEXT,
            ADD COLUMN IF NOT EXISTS country_code TEXT,
            ADD COLUMN IF NOT EXISTS country_name TEXT,
            ADD COLUMN IF NOT EXISTS is_eu BOOLEAN DEFAULT false,
            -- Probe columns, from the connection the call actually made.
            ADD COLUMN IF NOT EXISTS peer_ip TEXT,
            ADD COLUMN IF NOT EXISTS peer_ip_source TEXT,
            ADD COLUMN IF NOT EXISTS tls_servername TEXT,
            ADD COLUMN IF NOT EXISTS connect_ms INTEGER,
            ADD COLUMN IF NOT EXISTS is_local BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS operator TEXT,
            -- Automation/routine egress attribution.
            ADD COLUMN IF NOT EXISTS automation_id TEXT,
            ADD COLUMN IF NOT EXISTS run_id TEXT,
            ADD COLUMN IF NOT EXISTS step_id TEXT,
            ADD COLUMN IF NOT EXISTS is_dry_run BOOLEAN DEFAULT false,
            -- Borrowed-connection attribution (lent named connections).
            ADD COLUMN IF NOT EXISTS acting_user_id TEXT,
            ADD COLUMN IF NOT EXISTS connection_id TEXT,
            ADD COLUMN IF NOT EXISTS grant_id TEXT,
            -- Call outcome + latency (naming after OTel span status/duration).
            -- Failed and blocked calls now get a row too: bytes already left
            -- the box, so "no row on error" was a hole in the audit ledger.
            ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'success',
            ADD COLUMN IF NOT EXISTS error_message TEXT,
            ADD COLUMN IF NOT EXISTS duration_ms INTEGER,
            -- Canonical destination key (see destHostFrom in the store).
            ADD COLUMN IF NOT EXISTS dest_host TEXT,
            -- 'none' | 'basic' (regex sniff) | 'full' (GLiNER). Replaces the
            -- always-true pii_scan_enabled, which is still written for old readers.
            ADD COLUMN IF NOT EXISTS pii_scan_level TEXT NOT NULL DEFAULT 'none',
            -- The answer was replayed from the durable response cache: no bytes
            -- crossed the boundary on THIS call. A flag, never a synthetic row:
            -- a row that did not happen would inflate the Art-44 transfer count,
            -- and no row at all would erase a processor from the Art-30 register
            -- once a cross-run hit answers every call for a day. Also declared in
            -- migrations/integration-cache-scopes-2026-09 so a DBA reading the
            -- migrations folder sees it.
            ADD COLUMN IF NOT EXISTS served_from_cache BOOLEAN NOT NULL DEFAULT false,
            -- Location of the call (core/http/geo/locate.js): state is
            -- local | eu | outside | via_network | unknown, basis says how it
            -- was determined. Nullable without a default, so adding them is a
            -- catalog change only, no table rewrite. peers is set only when
            -- the call reached more than one host.
            ADD COLUMN IF NOT EXISTS location_state TEXT,
            ADD COLUMN IF NOT EXISTS location_basis TEXT,
            ADD COLUMN IF NOT EXISTS city TEXT,
            ADD COLUMN IF NOT EXISTS region TEXT,
            ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION,
            ADD COLUMN IF NOT EXISTS lon DOUBLE PRECISION,
            ADD COLUMN IF NOT EXISTS asn BIGINT,
            ADD COLUMN IF NOT EXISTS as_org TEXT,
            ADD COLUMN IF NOT EXISTS network TEXT,
            ADD COLUMN IF NOT EXISTS edge_pop TEXT,
            ADD COLUMN IF NOT EXISTS peers JSONB
    `);

    // One-time backfills, idempotent (guarded by their own WHERE) and BATCHED:
    // a single whole-table UPDATE hits the pool-wide 30 s statement_timeout on
    // a production-sized ledger, rolls back entirely, and, because the probed
    // DDL still succeeded, would never be attempted again. Batches keep every
    // statement small; a transient failure resumes on the next cold boot, and
    // both columns also have read-side fallbacks (DEST_EXPR / the scan-level
    // CASE in the overview) so unbackfilled rows stay correct.
    // dest_host: SQL approximation of destHostFrom for historical rows.
    // The 'i' flag on the scheme strip matches destHostFrom's /^https?:\/\//i;
    // without it 'HTTPS://Host…' rows backfilled to the bogus bucket 'https'.
    await _batched('dest_host', `
        UPDATE integration_activity_log SET dest_host = CASE
            WHEN COALESCE(NULLIF(tls_servername, ''), server_endpoint) ILIKE 'mcp-server://%'
                THEN lower(COALESCE(NULLIF(tls_servername, ''), server_endpoint))
            ELSE NULLIF(lower(trim(split_part(split_part(
                regexp_replace(regexp_replace(
                    COALESCE(NULLIF(tls_servername, ''), server_endpoint),
                    '^https?://', '', 'i'),
                    '\\s*\\(.*\\)\\s*$', ''),
                '/', 1), ':', 1))), '')
        END
        WHERE id IN (
            SELECT id FROM integration_activity_log
            WHERE dest_host IS NULL
              AND COALESCE(NULLIF(tls_servername, ''), server_endpoint) IS NOT NULL
            LIMIT ${BACKFILL_BATCH}
        )
    `);
    // pii_scan_level: historical rows all carried pii_scan_enabled=true and were
    // GLiNER-scanned on the chat paths. New writers always set the level, and set
    // pii_scan_enabled = (level !== 'none'), so this matches historical rows only.
    await _batched('pii_scan_level', `
        UPDATE integration_activity_log SET pii_scan_level = 'full'
        WHERE id IN (
            SELECT id FROM integration_activity_log
            WHERE pii_scan_enabled = true AND pii_scan_level = 'none'
            LIMIT ${BACKFILL_BATCH}
        )
    `);

    // Dashboard queries always filter org + time and exclude dry runs: the
    // partial composites are the workhorses (pattern from usageStore.js).
    // The old single-column org index is fully covered by the composite.
    // Through runDdl (stores/lib/_ddl.js), which collects a failure per
    // statement. Runbook rule from _ddl.js: integration_activity_log is a
    // volume table without retention, so any NEW index is created by hand
    // with CONCURRENTLY, never here. The location columns got none on purpose:
    // every location query also filters on org + time.
    await runDdl('integrationActivityStore', [
        `CREATE INDEX IF NOT EXISTS idx_integ_timestamp ON integration_activity_log(timestamp DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_integ_org_timestamp ON integration_activity_log(organization_id, timestamp DESC)`,
        `CREATE INDEX IF NOT EXISTS idx_integ_org_ts_live ON integration_activity_log(organization_id, timestamp DESC) WHERE is_dry_run = false`,
        `CREATE INDEX IF NOT EXISTS idx_integ_org_ts_noneu ON integration_activity_log(organization_id, timestamp DESC) WHERE is_eu = false AND is_local = false AND is_dry_run = false`,
        `CREATE INDEX IF NOT EXISTS idx_integ_user ON integration_activity_log(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_integ_type ON integration_activity_log(integration_type)`,
        `CREATE INDEX IF NOT EXISTS idx_integ_tool ON integration_activity_log(tool_name)`,
        `CREATE INDEX IF NOT EXISTS idx_integ_run ON integration_activity_log(run_id)`,
        `CREATE INDEX IF NOT EXISTS idx_integ_automation ON integration_activity_log(automation_id)`,
        `DROP INDEX IF EXISTS idx_integ_org`,
    ]);
}

async function _batched(label, sql) {
    for (let i = 0; i < BACKFILL_MAX_BATCHES; i++) {
        const res = await run(sql).catch(err => {
            log.error(`[IntegrationActivityStore] ${label} backfill batch failed:`, err.message);
            return null;
        });
        if (!res || (res.rowCount || 0) < BACKFILL_BATCH) break;
    }
}

// ── Location backfill ───────────────────────────────────────────────────────

function locationBackfillDone(columnNote) {
    return columnNote === LOCATION_BACKFILL_DONE;
}

/**
 * Pass 1 (only with a location database): rows with a PUBLIC peer address are
 * located again through the same locatePeer() new rows use. That is what
 * turns "Cloudflare, Canada" (ip-api's registry country for an anycast prefix)
 * into via_network. Unknown in the database is a state too.
 */
async function _locateRange(from, to, geo) {
    const rows = await getAll(`
        SELECT id, COALESCE(peer_ip, server_ip) AS ip, ${DEST_EXPR} AS host
        FROM integration_activity_log
        WHERE id > $1 AND id <= $2 AND location_state IS NULL
          AND COALESCE(peer_ip, server_ip) IS NOT NULL
          AND COALESCE(is_local, false) = false
          AND NOT ${IS_PRIVATE_PEER}
    `, [from, to]);
    const located = [];
    for (const r of rows || []) {
        const l = geo.locatePeer({ ip: r.ip, host: r.host, basis: 'backfill' });
        if (l.basis === 'none' || l.state === 'local') continue; // not an address / private: pass 2 decides
        located.push({ id: r.id, l });
    }
    if (!located.length) return 0;
    const col = (f) => located.map(x => f(x.l));
    await run(`
        UPDATE integration_activity_log AS t SET
            location_state = v.state, location_basis = 'backfill',
            is_eu = (v.state = 'eu'), is_local = false,
            country_code = v.cc, country_name = v.cn, region = v.region, city = v.city,
            lat = v.lat, lon = v.lon, asn = v.asn, as_org = v.as_org, network = v.network,
            operator = COALESCE(v.operator, t.operator)
        FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                    $7::float8[], $8::float8[], $9::bigint[], $10::text[], $11::text[], $12::text[])
            AS v(id, state, cc, cn, region, city, lat, lon, asn, as_org, network, operator)
        WHERE t.id = v.id AND t.location_state IS NULL
    `, [
        located.map(x => x.id), col(l => l.state), col(l => l.country_code), col(l => l.country_name),
        col(l => l.region), col(l => l.city), col(l => l.lat), col(l => l.lon), col(l => l.asn),
        col(l => l.as_org), col(l => l.network), col(l => l.operator),
    ]);
    return located.length;
}

/**
 * Pass 2: everything still without a state gets LEGACY_STATE_CASE, and the
 * flags follow the state (is_eu = eu, is_local = local), so a private
 * Nextcloud address stops counting as "left Europe". An anycast row loses the
 * registry country it never really had and gets its network name.
 */
const _LEGACY_PASS = `
    UPDATE integration_activity_log AS t SET
        location_state = s.state,
        location_basis = 'backfill',
        is_local = (s.state = 'local'),
        is_eu = (s.state = 'eu'),
        country_code = CASE WHEN s.state = 'via_network' THEN NULL ELSE t.country_code END,
        country_name = CASE WHEN s.state = 'via_network' THEN NULL ELSE t.country_name END,
        -- OpenAI's prefixes are Cloudflare's edge; the others name their own network.
        network = CASE WHEN s.state <> 'via_network' THEN t.network
                       WHEN t.operator = 'OpenAI' THEN 'Cloudflare' ELSE t.operator END
    FROM (
        SELECT id, ${LEGACY_STATE_CASE} AS state
        FROM integration_activity_log
        WHERE id > $1 AND id <= $2 AND location_state IS NULL
    ) AS s
    WHERE t.id = s.id AND t.location_state IS NULL
`;

/**
 * Every pre-rework row, in id ranges up to the highest id at the start (rows
 * written after that carry a state already), idempotent through
 * `location_state IS NULL`, so a crash, a second replica or a second boot only
 * repeats the ranges that still have work. Marks itself done in the column
 * comment, which the store's warm-boot probe reads.
 *
 * @param {{ batch?: number, geo?: { loadGeoDb: Function, geoDbStatus: Function, locatePeer: Function },
 *           pauseMs?: number }} [opts]
 */
async function runLocationBackfill({ batch = BACKFILL_BATCH, geo = require('./serverGeoResolver'), pauseMs = 20 } = {}) {
    const bounds = await getOne(`SELECT MIN(id) AS min_id, MAX(id) AS max_id FROM integration_activity_log`);
    const minId = Number(bounds?.min_id);
    const maxId = Number(bounds?.max_id);
    let located = 0, legacy = 0, ranges = 0;
    if (Number.isFinite(minId) && Number.isFinite(maxId) && bounds?.max_id !== null) {
        await geo.loadGeoDb();
        const withDb = !!geo.geoDbStatus().available;
        for (let from = minId - 1; from < maxId; from += batch) {
            const to = Math.min(from + batch, maxId);
            if (withDb) located += await _locateRange(from, to, geo);
            const res = await run(_LEGACY_PASS, [from, to]);
            legacy += res?.rowCount || 0;
            ranges++;
            if (pauseMs) await new Promise(r => setTimeout(r, pauseMs)); // leave room for live traffic
        }
    }
    await exec(`COMMENT ON COLUMN integration_activity_log.location_state IS '${LOCATION_BACKFILL_DONE}'`);
    if (located || legacy) {
        log.info(`[IntegrationActivityStore] location backfill: ${located} row(s) located, ${legacy} from the legacy flags, ${ranges} range(s)`);
    }
    return { located, legacy, ranges };
}

let _backfill = null;

/** Start the location backfill once per process, detached. Never rejects. */
function startLocationBackfill() {
    if (!_backfill) {
        _backfill = runLocationBackfill().catch(err => {
            log.warn('[IntegrationActivityStore] location backfill stopped (resumes on the next boot):', err.message);
            _backfill = null;
        });
    }
    return _backfill;
}

module.exports = {
    upgradeSchema,
    startLocationBackfill,
    runLocationBackfill,
    locationBackfillDone,
    LOCATION_BACKFILL_DONE,
};
