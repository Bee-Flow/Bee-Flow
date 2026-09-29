// @typecheck
/**
 * Integration Activity Store — the ledger of outbound tool/integration calls,
 * for data-sovereignty monitoring (Privacy Shield, Art-30/44 evidence).
 *
 * Logs which integrations are used, what server endpoints they connect to,
 * what data direction (sent/received), what PII categories were detected, and
 * WHERE the bytes went: the location of every call is determined at LOG TIME
 * from the connection the egress capture saw (core/http/egressCapture.js) and
 * a local IP database (core/http/geo/, reached through serverGeoResolver).
 * No lookup leaves the box and nothing is resolved again after the call.
 *
 * Split by responsibility:
 *   integrationActivitySchema.js  column ladder, backfills, indexes
 *   integrationLocationSql.js     the SQL every location reader shares
 *   integrationOverview.js        the consolidated Activity overview
 */

const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const { locateCall, loadGeoDb } = require('./serverGeoResolver');
const schema = require('./integrationActivitySchema');
const { LOC_STATE, LOC_BASIS, NON_EU, HAS_PII, stateCounts } = require('./integrationLocationSql');
const log = require('../telemetry/log');

/**
 * Canonical destination grouping key. NOT the same as
 * serverGeoResolver.extractHostname(): that one answers "can I DNS-resolve
 * this?" and returns null for anything without a dot; this one answers "which
 * bucket does this call belong to?" and must produce a stable key for values
 * like 'n8n-server (configured)' or 'mcp-server://filesystem' too — otherwise
 * the same destination splits into one bucket per label variant.
 */
function destHostFrom(tlsServername, serverEndpoint) {
    const raw = (tlsServername && String(tlsServername).trim()) || (serverEndpoint && String(serverEndpoint).trim()) || '';
    if (!raw) return null;
    // MCP synthetic URIs are kept whole: 'filesystem' alone would collide with
    // any future non-MCP label of the same name.
    if (/^mcp-server:\/\//i.test(raw)) return raw.toLowerCase();
    const host = raw
        .replace(/^https?:\/\//i, '')
        .replace(/\s*\(.*\)\s*$/, '') // parenthetical labels: 'api.serper.dev (Google Search)'
        .split('/')[0]
        .split(':')[0]
        .trim()
        .toLowerCase();
    return host || null;
}

// Single-flight init. The old version awaited ~25 DDL statements at the head
// of EVERY read and write; concurrent boot calls each ran the full ladder.
// Now: one shared promise, and a warm-boot probe on the NEWEST schema object
// so an already-migrated table costs a single SELECT.
// ⚠ When adding DDL (integrationActivitySchema.js), point the probe at the
// newest column/table or the new DDL will be silently skipped on existing installs.
const initDB = makeStoreInit('IntegrationActivityStore', _doInit);

async function _doInit() {
    // Probe the NEWEST schema objects (bump when adding DDL): the newest
    // column, the LAST-created table, and the absence of the retired index,
    // so a partial failure anywhere in the ladder forces a full, idempotent
    // re-run instead of being skipped forever. location_note is the marker the
    // location backfill leaves when it has reached every row.
    const probe = await getOne(`
        SELECT
            (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'integration_activity_log' AND column_name = 'peers') AS col,
            (to_regclass('compliance_signal_debounce') IS NOT NULL) AS tbl,
            (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_integ_org') AS retired,
            (SELECT col_description(a.attrelid, a.attnum) FROM pg_attribute a
              WHERE a.attrelid = to_regclass('integration_activity_log')
                AND a.attname = 'location_state') AS location_note
    `).catch(() => null);
    if (probe && probe.col && probe.tbl && !probe.retired) {
        if (!schema.locationBackfillDone(probe.location_note)) schema.startLocationBackfill();
        return;
    }

    await exec(`
        CREATE TABLE IF NOT EXISTS integration_activity_log (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            organization_id TEXT,
            user_id TEXT,
            agent_id TEXT,
            agent_name TEXT,
            conversation_id TEXT,
            tool_name TEXT NOT NULL,
            integration_type TEXT,
            server_endpoint TEXT,
            data_direction TEXT DEFAULT 'sent',
            data_categories TEXT,
            pii_categories_detected TEXT,
            pii_scan_enabled BOOLEAN DEFAULT false,
            data_summary TEXT,
            source TEXT DEFAULT 'unknown',
            model TEXT,
            server_ip TEXT,
            country_code TEXT,
            country_name TEXT,
            is_eu BOOLEAN DEFAULT false
        )
    `);
    // Column ladder, the batched backfills and the indexes.
    await schema.upgradeSchema();

    // Cross-replica debounce claims for compliance signals: the in-process
    // Map below only debounces within ONE pod, so an N-replica deployment
    // used to emit up to N notification storms per operator per day.
    await exec(`
        CREATE TABLE IF NOT EXISTS compliance_signal_debounce (
            org_id TEXT NOT NULL,
            signal_key TEXT NOT NULL,
            last_emitted TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (org_id, signal_key)
        )
    `);

    // Every pre-rework row gets a location state. DETACHED on purpose: every
    // write awaits initDB, and a backfill over a large ledger must not hold
    // the first write of the boot hostage.
    schema.startLocationBackfill();
}

log.info('[IntegrationActivityStore] Initialized (PostgreSQL)');

// ============ Logging ============

// Debounce for the EXTERNAL_TRANSFER_DETECTED compliance event: the listener
// re-runs the Art-44 check AND notifies every org admin, so a burst of non-EU
// calls must collapse to one signal per org+operator per day. In-process is
// good enough — a duplicate after a restart only costs one extra notification.
const _transferSignalCache = new Map(); // `${orgId}:${operator}` -> last emit ts
const TRANSFER_SIGNAL_TTL_MS = 24 * 60 * 60 * 1000;

function _signalExternalTransfer({ orgId, operator, countryCode }) {
    if (!orgId) return;
    const key = `${orgId}:${operator || 'unknown'}`;
    const last = _transferSignalCache.get(key) || 0;
    if (Date.now() - last < TRANSFER_SIGNAL_TTL_MS) return;
    _transferSignalCache.set(key, Date.now());
    // Opportunistic cleanup so the map never grows unbounded.
    if (_transferSignalCache.size > 5000) {
        const cutoff = Date.now() - TRANSFER_SIGNAL_TTL_MS;
        for (const [k, ts] of _transferSignalCache) if (ts < cutoff) _transferSignalCache.delete(k);
    }
    // The map is only a per-process pre-filter; the authoritative debounce is
    // a DB claim shared by every replica. Fire-and-forget on purpose — the
    // caller is the egress write path.
    _claimAndEmitTransferSignal(orgId, `external_transfer:${operator || 'unknown'}`, {
        orgId, operator: operator || null, country_code: countryCode || null,
    }).catch(() => {});
}

async function _claimAndEmitTransferSignal(orgId, signalKey, payload) {
    let claimed = true;
    try {
        await initDB();
        // Row returned ⇔ we won the claim (fresh insert, or >24 h since the
        // last emit by ANY replica). No row ⇔ someone else already emitted.
        const row = await getOne(`
            INSERT INTO compliance_signal_debounce (org_id, signal_key, last_emitted)
            VALUES ($1, $2, NOW())
            ON CONFLICT (org_id, signal_key) DO UPDATE SET last_emitted = NOW()
            WHERE compliance_signal_debounce.last_emitted < NOW() - INTERVAL '24 hours'
            RETURNING 1 AS claimed
        `, [orgId, signalKey]);
        claimed = !!row;
    } catch (_) {
        // DB unavailable → fail open to the in-process debounce. One extra
        // notification beats silently dropping an Art-44 signal.
        claimed = true;
    }
    if (!claimed) return;
    try {
        // Lazy-require: events.js lazy-loads the runner, and requiring it at
        // module scope here would create a boot cycle via runner → checks.
        const events = require('../compliance/events');
        events.emit(events.EVENTS.EXTERNAL_TRANSFER_DETECTED, payload);
    } catch (_) { /* compliance bus is best-effort */ }
}

/**
 * The peers of a probe snapshot. The current capture sends `peers`; a snapshot
 * in the old shape (one `peer_ip`, from a replica or caller not yet on the new
 * capture) counts as one socket peer that received the call.
 */
function _probePeers(probe) {
    if (!probe || typeof probe !== 'object') return [];
    if (Array.isArray(probe.peers)) return probe.peers;
    if (probe.peer_ip && probe.peer_ip_source !== 'local') {
        return [{ host: probe.tls_servername || probe.hostname || null, ip: probe.peer_ip, basis: 'socket', sentBody: true, edge: null }];
    }
    return [];
}

/** Legacy peer_ip_source for old readers: how the recorded address was seen. */
function _legacySource(primary, state) {
    if (!primary || !primary.ip) return state === 'local' ? 'local' : null;
    if (primary.basis === 'socket' || primary.basis === 'edge_header') return 'socket';
    if (primary.basis === 'no_geo_db' || primary.basis === 'none') return 'socket';
    return primary.basis;
}

/** Column → value, in INSERT order. Built as pairs so the two can never drift apart. */
function _insertRow(event, loc, probe) {
    const row = loc.row;
    const primary = loc.primary;
    // 'none' | 'basic' | 'full'. pii_scan_enabled is derived, kept only
    // for readers that predate the level column.
    const scanLevel = ['none', 'basic', 'full'].includes(event.pii_scan_level)
        ? event.pii_scan_level
        : (event.pii_scan_enabled ? 'full' : 'none');
    const status = ['success', 'error', 'blocked'].includes(event.status) ? event.status : 'success';
    // The host the connection went to. A peer without an address (a stdio MCP
    // child) had no connection of ours: its name is a label, and the endpoint
    // (`mcp-server://…`) stays the grouping key. An old-shape probe keeps its
    // own tls_servername.
    let tlsServername;
    if (primary) tlsServername = primary.ip ? primary.host : null;
    else tlsServername = Array.isArray(probe?.peers) ? null : (probe?.tls_servername || null);
    return [
        ['timestamp', event.timestamp || new Date().toISOString()],
        ['organization_id', event.organization_id || null],
        ['user_id', event.user_id || null],
        ['agent_id', event.agent_id || null],
        ['agent_name', event.agent_name || null],
        ['conversation_id', event.conversation_id || null],
        ['tool_name', event.tool_name || 'unknown'],
        ['integration_type', event.integration_type || null],
        ['server_endpoint', event.server_endpoint || null],
        ['data_direction', event.data_direction || 'sent'],
        ['data_categories', event.data_categories || null],
        ['pii_categories_detected', event.pii_categories_detected || null],
        ['pii_scan_enabled', scanLevel !== 'none'],
        ['data_summary', event.data_summary || null],
        ['source', event.source || 'unknown'],
        ['model', event.model || null],
        ['server_ip', null], // retired duplicate of peer_ip; readers COALESCE(peer_ip, server_ip)
        ['country_code', row.country_code],
        ['country_name', row.country_name],
        ['is_eu', row.state === 'eu'],
        ['peer_ip', (primary && primary.ip) || null],
        ['peer_ip_source', _legacySource(primary, row.state)],
        ['tls_servername', tlsServername],
        ['connect_ms', Number.isInteger(probe?.connect_ms) ? probe.connect_ms : null],
        ['is_local', row.state === 'local'],
        ['operator', row.operator],
        ['automation_id', event.automation_id || null],
        ['run_id', event.run_id || null],
        ['step_id', event.step_id || null],
        ['is_dry_run', event.is_dry_run || false],
        ['acting_user_id', event.acting_user_id || null],
        ['connection_id', event.connection_id || null],
        ['grant_id', event.grant_id || null],
        ['status', status],
        ['error_message', event.error_message ? String(event.error_message).slice(0, 500) : null],
        ['duration_ms', Number.isFinite(event.duration_ms) ? Math.round(event.duration_ms) : null],
        ['dest_host', destHostFrom(tlsServername, event.server_endpoint)],
        ['pii_scan_level', scanLevel],
        ['served_from_cache', event.served_from_cache === true],
        ['location_state', row.state],
        ['location_basis', row.basis],
        ['city', row.city],
        ['region', row.region],
        ['lat', row.lat],
        ['lon', row.lon],
        ['asn', row.asn],
        ['as_org', row.as_org],
        ['network', row.network],
        ['edge_pop', row.edge_pop],
        ['peers', loc.peers.length > 1 ? JSON.stringify(loc.peers) : null],
    ];
}

async function logIntegrationActivity(event) {
    await initDB();
    try {
        const probe = event.probe || null;
        const peers = _probePeers(probe);
        // The local hint (the logger's meta.isLocal, or markLocal() on the
        // probe) only decides when no connection was seen at all.
        const isLocalHint = event.is_local_hint === true || probe?.is_local === true;
        // The first write after boot waits for the local IP database instead
        // of recording "unknown"; afterwards this resolves immediately.
        if (peers.length) await loadGeoDb();
        const loc = locateCall({ peers, isLocalHint, serverEndpoint: event.server_endpoint });

        const pairs = _insertRow(event, loc, probe);
        await run(`
            INSERT INTO integration_activity_log (${pairs.map(p => p[0]).join(', ')})
            VALUES (${pairs.map((_, i) => `$${i + 1}`).join(', ')})
        `, pairs.map(p => p[1]));

        // Real (non-dry-run) data that LEFT Europe is a GDPR Art-44 signal,
        // debounced to one per org+operator per day. Only 'outside': a call
        // via a global network or without a known location is not a transfer
        // we can name. A cache hit is not a transfer either: nothing left the
        // box, so it must not raise the signal that says something did.
        if (loc.row.state === 'outside' && !event.is_dry_run && !event.served_from_cache) {
            _signalExternalTransfer({
                orgId: event.organization_id,
                operator: loc.row.operator,
                countryCode: loc.row.country_code,
            });
        }
    } catch (e) {
        log.error('[IntegrationActivityStore] Failed to log:', e.message);
    }
}

// ============ Query Helpers ============

const LOCATION_STATES = ['local', 'eu', 'outside', 'via_network', 'unknown'];

/** The location of a row as the egress views return it (legacy rows via LOC_STATE). */
const LOCATION_COLUMNS = `${LOC_STATE} AS location_state, ${LOC_BASIS} AS location_basis,
            city, region, lat, lon, asn, as_org, network, edge_pop`;

function buildFilters(filters, startIdx = 1) {
    const conditions = [];
    const params = [];
    let idx = startIdx;
    if (filters?.startDate) { conditions.push(`timestamp >= $${idx++}`); params.push(filters.startDate); }
    if (filters?.endDate) { conditions.push(`timestamp <= $${idx++}`); params.push(filters.endDate); }
    if (filters?.organizationId) { conditions.push(`organization_id = $${idx++}`); params.push(filters.organizationId); }
    if (filters?.userId) { conditions.push(`user_id = $${idx++}`); params.push(filters.userId); }
    if (filters?.integrationType) { conditions.push(`integration_type = $${idx++}`); params.push(filters.integrationType); }
    if (filters?.agentId) { conditions.push(`agent_id = $${idx++}`); params.push(filters.agentId); }
    if (filters?.piiCategory) {
        // Exact match on the trimmed category. The old ILIKE '%cat%' was a
        // substring match, so drilling on "Email" also matched "Email Address"
        // and any category containing it. string_to_array on ',' + trim
        // tolerates both the legacy ', ' encoding and the canonical ','.
        conditions.push(`EXISTS (
            SELECT 1 FROM unnest(string_to_array(pii_categories_detected, ',')) AS c
            WHERE lower(trim(c)) = lower($${idx++})
        )`);
        params.push(String(filters.piiCategory).trim());
    }
    // Dashboards exclude dry-run rows (compliance checks always did); the raw
    // per-run views pass excludeDryRun: false to keep showing them.
    if (filters?.excludeDryRun) conditions.push(`is_dry_run = false`);
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
    return { where, params, nextIdx: idx };
}

// ============ Queries ============

async function getIntegrationSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getOne(`
        SELECT
            COUNT(*) as total_calls,
            COUNT(DISTINCT integration_type) as unique_integrations,
            COUNT(DISTINCT server_endpoint) as unique_servers,
            COUNT(*) FILTER (WHERE data_direction = 'sent') as sent_count,
            COUNT(*) FILTER (WHERE data_direction = 'received') as received_count,
            COUNT(*) FILTER (WHERE data_direction = 'both') as both_count,
            COUNT(*) FILTER (WHERE pii_categories_detected IS NOT NULL AND pii_categories_detected != '') as pii_events,
            COUNT(DISTINCT user_id) as unique_users
        FROM integration_activity_log ${where}
    `, params);
}

async function getIntegrationTimeline(filters = {}, interval = 'day') {
    await initDB();
    const { where, params } = buildFilters(filters);
    const groupExpr = interval === 'hour'
        ? "to_char(date_trunc('hour', timestamp), 'YYYY-MM-DD HH24:00')"
        : "to_char(date_trunc('day', timestamp), 'YYYY-MM-DD')";
    return getAll(`
        SELECT
            ${groupExpr} as period,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE data_direction = 'sent') as sent,
            COUNT(*) FILTER (WHERE data_direction = 'received') as received,
            COUNT(*) FILTER (WHERE ${HAS_PII}) as pii_events,
            ${stateCounts()},
            COUNT(*) FILTER (WHERE ${NON_EU}) as non_eu_count,
            COUNT(*) FILTER (WHERE ${NON_EU} AND ${HAS_PII}) as pii_non_eu_count
        FROM integration_activity_log ${where}
        GROUP BY period
        ORDER BY period ASC
    `, params);
}

/**
 * Sovereignty breakdown by one of four dimensions: user / integration / agent / pii.
 * Same row shape across all four so the frontend can render with one template.
 *
 * For pii: rows without detected PII categories don't contribute — the
 * denominator is "calls where any PII was detected", not "all calls".
 */
async function getSovereigntyByDimension(dimension, filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);

    // mode() returns the most-frequent operator per bucket — the "where most
    // of this bucket's data actually went" headline. pii_non_eu_count powers
    // the PII-weighted sovereignty score: each call leaking PII to a non-EU
    // server is the worst case and should cost double. "Non-EU" is the
    // located 'outside' state only; via_network / unknown have their own counts.
    const sharedSelect = `
        COUNT(*) as total,
        ${stateCounts()},
        COUNT(*) FILTER (WHERE ${NON_EU}) as non_eu_count,
        COUNT(*) FILTER (WHERE ${NON_EU} AND ${HAS_PII}) as pii_non_eu_count,
        MAX(timestamp) as last_seen,
        mode() WITHIN GROUP (ORDER BY operator) as top_operator
    `;

    if (dimension === 'user') {
        return getAll(`
            SELECT user_id as key, user_id as label, ${sharedSelect}
            FROM integration_activity_log ${where}
            ${where ? 'AND' : 'WHERE'} user_id IS NOT NULL
            GROUP BY user_id
            ORDER BY total DESC
        `, params);
    }
    if (dimension === 'agent') {
        return getAll(`
            SELECT
                COALESCE(agent_id, 'direct-chat') as key,
                COALESCE(NULLIF(agent_name, ''), agent_id, 'Direct Chat') as label,
                ${sharedSelect}
            FROM integration_activity_log ${where}
            GROUP BY key, label
            ORDER BY total DESC
        `, params);
    }
    if (dimension === 'integration') {
        return getAll(`
            SELECT integration_type as key, integration_type as label, ${sharedSelect}
            FROM integration_activity_log ${where}
            ${where ? 'AND' : 'WHERE'} integration_type IS NOT NULL
            GROUP BY integration_type
            ORDER BY total DESC
        `, params);
    }
    if (dimension === 'pii') {
        // Unnest the comma-separated PII category list; only rows with at
        // least one detected category contribute.
        return getAll(`
            SELECT
                trim(cat) as key,
                trim(cat) as label,
                ${sharedSelect}
            FROM integration_activity_log,
                 unnest(string_to_array(pii_categories_detected, ',')) AS cat
            ${where ? where + ' AND' : 'WHERE'} pii_categories_detected IS NOT NULL
                AND pii_categories_detected != ''
                AND trim(cat) != ''
            GROUP BY trim(cat)
            ORDER BY total DESC
        `, params);
    }
    throw new Error(`Unknown sovereignty dimension: ${dimension}`);
}

async function getIntegrationByType(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            integration_type,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE data_direction = 'sent') as sent,
            COUNT(*) FILTER (WHERE data_direction = 'received') as received,
            COUNT(*) FILTER (WHERE pii_categories_detected IS NOT NULL AND pii_categories_detected != '') as pii_events,
            MAX(timestamp) as last_used
        FROM integration_activity_log ${where}
        GROUP BY integration_type
        ORDER BY total DESC
    `, params);
}

async function getIntegrationByTool(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            tool_name,
            integration_type,
            server_endpoint,
            data_direction,
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE pii_categories_detected IS NOT NULL AND pii_categories_detected != '') as pii_events,
            MAX(timestamp) as last_used
        FROM integration_activity_log ${where}
        GROUP BY tool_name, integration_type, server_endpoint, data_direction
        ORDER BY total DESC
    `, params);
}

async function getIntegrationByUser(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            user_id,
            COUNT(*) as total,
            COUNT(DISTINCT integration_type) as integrations_used,
            COUNT(*) FILTER (WHERE data_direction = 'sent') as sent,
            COUNT(*) FILTER (WHERE data_direction = 'received') as received,
            COUNT(*) FILTER (WHERE pii_categories_detected IS NOT NULL AND pii_categories_detected != '') as pii_events,
            MAX(timestamp) as last_activity
        FROM integration_activity_log ${where}
        GROUP BY user_id
        ORDER BY total DESC
    `, params);
}

async function getIntegrationPiiSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    // Split on ',' + trim — reads BOTH the legacy ', ' rows and the canonical
    // ',' encoding (core/piiCategories.js). The old ', ' split glued canonical
    // rows into one giant pseudo-category.
    const baseWhere = where ? `${where} AND` : 'WHERE';
    return getAll(`
        SELECT
            trim(cat) as pii_category,
            COUNT(*) as count,
            integration_type
        FROM integration_activity_log,
             unnest(string_to_array(pii_categories_detected, ',')) AS cat
        ${baseWhere}
            pii_categories_detected IS NOT NULL
            AND pii_categories_detected != ''
            AND trim(cat) != ''
        GROUP BY trim(cat), integration_type
        ORDER BY count DESC
    `, params);
}

async function getIntegrationServers(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    // Group by the probe-captured tls_servername when available — that is
    // provably where the call went. Fall back to server_endpoint only when
    // there's no probe data (legacy rows / SDK gaps). This stops the
    // dashboard from claiming the call went to a stale hardcoded fallback
    // hostname (e.g. 'youtrack.cloud' for a self-hosted YouTrack).
    return getAll(`
        SELECT
            COALESCE(NULLIF(tls_servername, ''), server_endpoint) AS server_endpoint,
            COUNT(*) as total,
            COUNT(DISTINCT integration_type) as integration_count,
            array_agg(DISTINCT integration_type) as integrations,
            COUNT(*) FILTER (WHERE data_direction = 'sent') as sent,
            COUNT(*) FILTER (WHERE data_direction = 'received') as received,
            MAX(timestamp) as last_contact,
            array_agg(DISTINCT COALESCE(peer_ip, server_ip)) FILTER (WHERE COALESCE(peer_ip, server_ip) IS NOT NULL) as server_ips,
            array_agg(DISTINCT country_code) FILTER (WHERE country_code IS NOT NULL) as country_codes,
            array_agg(DISTINCT country_name) FILTER (WHERE country_name IS NOT NULL) as country_names,
            bool_or(is_eu) as is_eu
        FROM integration_activity_log ${where}
            ${where ? 'AND' : 'WHERE'} COALESCE(NULLIF(tls_servername, ''), server_endpoint) IS NOT NULL
        GROUP BY COALESCE(NULLIF(tls_servername, ''), server_endpoint)
        ORDER BY total DESC
    `, params);
}

async function getRecentIntegrationActivity(limit = 50, filters = {}) {
    await initDB();
    // Built on the shared buildFilters ON PURPOSE: the old hand-rolled WHERE
    // ignored filters.userId, and attachOrgFilter scopes consumer (org-less)
    // accounts by userId ONLY — so a consumer hitting /integrations/recent got
    // every org's rows. Defense in depth: the store honors the filter even if
    // a future route forgets its middleware.
    const { where, params, nextIdx } = buildFilters(filters);
    const guard = (!filters?.startDate && !filters?.endDate)
        ? `${where ? where + ' AND' : 'WHERE'} timestamp >= NOW() - INTERVAL '90 days'`
        : where;
    // Explicit column list, NOT SELECT * — this deprecated endpoint kept its
    // old shape, but SELECT * would silently widen it with the new
    // error_message column (raw upstream error text: URLs, endpoint paths,
    // whatever the provider echoes). The authoritative egress view exposes it
    // deliberately; this one must not grow it by accident.
    return getAll(`
        SELECT
            id, timestamp, organization_id, user_id, agent_id, agent_name,
            conversation_id, tool_name, integration_type, server_endpoint, dest_host,
            data_direction, data_categories, pii_categories_detected,
            pii_scan_enabled, pii_scan_level, data_summary, source, model,
            server_ip, country_code, country_name, is_eu,
            peer_ip, peer_ip_source, tls_servername, connect_ms, is_local, operator,
            automation_id, run_id, step_id, is_dry_run,
            acting_user_id, connection_id, grant_id, status, duration_ms
        FROM integration_activity_log
        ${guard}
        ORDER BY timestamp DESC
        LIMIT $${nextIdx}
    `, [...params, Math.max(1, Math.min(Number(limit) || 50, 200))]);
}

/**
 * Per-call data egress log — the authoritative "where did the data go" view.
 * Each row is one tool call. peer_ip is the address the connection went to
 * (the primary peer), peer_ip_source how it was seen. The location fields
 * (location_state, location_basis, city, lat, lon, edge_pop, network, as_org)
 * describe the whole call; `peers` lists every host when there was more than
 * one. A row from before the location rework reads its state from the legacy
 * flags (LOC_STATE) with basis 'backfill'.
 */
async function getEgressLog(filters = {}, limit = 200) {
    await initDB();
    const conditions = [];
    const params = [];
    let idx = 1;
    if (filters.organizationId) { conditions.push(`organization_id = $${idx++}`); params.push(filters.organizationId); }
    if (filters.startDate) { conditions.push(`timestamp >= $${idx++}`); params.push(filters.startDate); }
    if (filters.endDate) { conditions.push(`timestamp <= $${idx++}`); params.push(filters.endDate); }
    if (filters.integrationType) { conditions.push(`integration_type = $${idx++}`); params.push(filters.integrationType); }
    if (filters.userId) { conditions.push(`user_id = $${idx++}`); params.push(filters.userId); }
    if (filters.agentId) { conditions.push(`agent_id = $${idx++}`); params.push(filters.agentId); }
    if (filters.piiCategory) {
        // Exact trimmed-category match — see buildFilters for why not ILIKE.
        conditions.push(`EXISTS (
            SELECT 1 FROM unnest(string_to_array(pii_categories_detected, ',')) AS c
            WHERE lower(trim(c)) = lower($${idx++})
        )`);
        params.push(String(filters.piiCategory).trim());
    }
    if (filters.euOnly === true) conditions.push(`is_eu = true`);
    if (filters.euOnly === false) conditions.push(NON_EU);
    if (filters.localOnly) conditions.push(`is_local = true`);
    if (LOCATION_STATES.includes(filters.locationState)) {
        conditions.push(`${LOC_STATE} = $${idx++}`);
        params.push(filters.locationState);
    }
    if (filters.excludeDryRun) conditions.push(`is_dry_run = false`);
    // Keyset pagination: rows strictly older than the cursor id. id DESC and
    // timestamp DESC agree (SERIAL, monotonic-enough inserts), and a cursor
    // survives concurrent inserts where OFFSET would shift.
    if (Number.isFinite(filters.beforeId)) { conditions.push(`id < $${idx++}`); params.push(filters.beforeId); }
    if (!filters.startDate && !filters.endDate) {
        conditions.push(`timestamp >= NOW() - INTERVAL '90 days'`);
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    return getAll(`
        SELECT
            id, timestamp, organization_id, user_id, agent_id, agent_name,
            tool_name, integration_type, server_endpoint, dest_host, data_direction,
            COALESCE(peer_ip, server_ip) AS peer_ip,
            COALESCE(peer_ip_source, CASE WHEN server_ip IS NOT NULL THEN 'dns_post_call' ELSE NULL END) AS peer_ip_source,
            tls_servername, connect_ms, is_local, operator,
            country_code, country_name, is_eu,
            pii_categories_detected, status, error_message, duration_ms, is_dry_run,
            source, automation_id,
            -- Whether the content was checked at all: 'none' is "not looked",
            -- which the Shield must not read as "nothing found". A pre-rework
            -- row with level 'none' but pii_scan_enabled WAS scanned (the same
            -- read-side fallback as the overview's scan_levels).
            CASE WHEN pii_scan_level = 'none' AND pii_scan_enabled = true THEN 'full'
                 ELSE pii_scan_level END AS pii_scan_level,
            ${LOCATION_COLUMNS}, peers
        FROM integration_activity_log
        ${where}
        ORDER BY id DESC
        LIMIT $${idx}
    `, [...params, Math.max(1, Math.min(Number(limit) || 50, 200))]);
}

/**
 * Per-run egress — every external call an automation run made, with destination,
 * geo/EU flag and detected PII categories, for the automation run-detail UI.
 * Ordered by step so it lines up with the run timeline.
 */
async function getEgressLogForRun(runId) {
    if (!runId) return [];
    await initDB();
    return getAll(`
        SELECT
            id, timestamp, step_id, tool_name, integration_type, server_endpoint, data_direction,
            data_categories, pii_categories_detected, is_dry_run,
            COALESCE(peer_ip, server_ip) AS peer_ip,
            country_code, country_name, is_eu, is_local, operator,
            ${LOCATION_COLUMNS}
        FROM integration_activity_log
        WHERE run_id = $1
        ORDER BY timestamp ASC
    `, [runId]);
}

/**
 * Operator-level summary — group by operator name (Google / Microsoft / Cloudflare / …)
 * with a count, distinct-IP count, and last-seen timestamp.
 */
async function getOperatorSummary(filters = {}) {
    await initDB();
    const { where, params } = buildFilters(filters);
    return getAll(`
        SELECT
            COALESCE(operator, 'Unknown') AS operator,
            COUNT(*) AS total,
            COUNT(DISTINCT COALESCE(peer_ip, server_ip)) AS unique_ips,
            COUNT(DISTINCT integration_type) AS unique_integrations,
            bool_or(is_eu) AS any_eu,
            MAX(timestamp) AS last_seen
        FROM integration_activity_log
        ${where}
        ${where ? 'AND' : 'WHERE'} is_local = false
        GROUP BY operator
        ORDER BY total DESC
    `, params);
}

// ── Consolidated overview (one round-trip for the Activity dashboard) ───────

/**
 * Everything the Activity dashboard needs, in one response: summary (with the
 * SERVER-side sovereignty score), timeline, top breakdowns, the map block,
 * category aggregations and a health block. Built in integrationOverview.js.
 *
 * @param {object} [filters]
 * @param {'day'|'hour'} [interval]
 * @param {{ normalizeCategory?: Function }} [opts]  the PII category normaliser
 *   (core/privacy/piiCategories), passed in by the route: this store is
 *   platform code and does not reach up into core for it.
 */
async function getIntegrationOverview(filters = {}, interval = 'day', { normalizeCategory } = {}) {
    await initDB();
    return require('./integrationOverview').buildOverview(filters, interval, { buildFilters, normalizeCategory });
}

module.exports = {
    logIntegrationActivity,
    _signalExternalTransfer, // exported for tests (debounce contract)
    destHostFrom,            // exported for tests + the shared egress logger
    buildFilters,            // exported for tests (excludeDryRun / pii-match contract)
    getIntegrationOverview,
    getEgressLogForRun,
    getIntegrationSummary,
    getIntegrationTimeline,
    getIntegrationByType,
    getIntegrationByTool,
    getIntegrationByUser,
    getIntegrationPiiSummary,
    getIntegrationServers,
    getRecentIntegrationActivity,
    getEgressLog,
    getOperatorSummary,
    getSovereigntyByDimension,
};

// Awaitable init entry point for migrateDb.
module.exports.initDB = initDB;
