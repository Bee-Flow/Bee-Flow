/**
 * Store-level tests — integration activity ledger.
 *
 * Pins the contracts the monitoring rework introduced:
 *  1. initDB is single-flight and probes before running DDL — the old version
 *     awaited ~25 DDL statements at the head of EVERY read and write.
 *  2. buildFilters honors userId and excludeDryRun, and matches PII categories
 *     EXACTLY (the old ILIKE '%cat%' was a substring match).
 *  3. getRecentIntegrationActivity scopes by userId — this was the consumer
 *     cross-tenant leak: attachOrgFilter scopes org-less accounts by userId
 *     ONLY, and the old hand-rolled WHERE ignored it.
 *  4. destHostFrom produces one stable grouping key per destination.
 * And the location rework:
 *  5. every call is located from its probe peers: a private address is local
 *     (no longer "left Europe"), Cloudflare is via_network at its edge, an old
 *     single-address probe still works, and only 'outside' raises Art-44;
 *  6. the location backfill runs detached, in id ranges, in the right order;
 *  7. the overview scores located calls only and gives one location per host.
 *
 * Hermetic: ../db is stubbed (no Postgres); the location database is a fake
 * reader installed through geoDb.__setReadersForTests (no file, no network).
 *
 * Run: node --test server/stores/integrationActivityStore.test.js
 */

const assert = require('node:assert');
const { test } = require('node:test');
const path = require('path');
const Module = require('module');

// ── Stubs ──────────────────────────────────────────────────────────────
const dbCalls = { exec: [], run: [], getOne: [], getAll: [] };
let probeResult = null; // what the initDB warm-boot probe sees
let execDelayMs = 0;    // lets the single-flight test force overlap
const oneRoutes = [];   // [regex, (sql, params) => row]
const allRoutes = [];   // [regex, (sql, params) => rows]

const dbStub = {
    async exec(sql) {
        dbCalls.exec.push(sql);
        if (execDelayMs) await new Promise(r => setTimeout(r, execDelayMs));
        return { rowCount: 0 };
    },
    async run(sql, params) { dbCalls.run.push({ sql, params }); return { rowCount: 1 }; },
    async getOne(sql, params) {
        dbCalls.getOne.push({ sql, params });
        if (/information_schema\.columns/.test(sql)) return probeResult;
        const hit = oneRoutes.find(([re]) => re.test(sql));
        return hit ? hit[1](sql, params) : null;
    },
    async getAll(sql, params) {
        dbCalls.getAll.push({ sql, params });
        const hit = allRoutes.find(([re]) => re.test(sql));
        return hit ? hit[1](sql, params) : [];
    },
};

const STORES_DIR = path.sep + 'stores' + path.sep;
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(STORES_DIR) && request === '../db') {
        return path.join(__dirname, '__stub_db_integact__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
{
    const full = path.join(__dirname, '__stub_db_integact__.js');
    require.cache[full] = { id: full, filename: full, loaded: true, exports: dbStub };
}

// A fake location database: MaxMind-shaped records.
const geoDb = require('../core/http/geo/geoDb');
const CITY = {
    '95.216.1.1': { country: { iso_code: 'FI' }, city: { names: { en: 'Helsinki' } }, location: { latitude: 60.17, longitude: 24.94 } },
    '3.5.1.1': { country: { iso_code: 'US' }, city: { names: { en: 'Ashburn' } }, location: { latitude: 39.04, longitude: -77.49 } },
    '104.18.24.82': { country: { iso_code: 'CA' }, city: { names: { en: 'Toronto' } }, location: { latitude: 43.65, longitude: -79.38 } },
};
const ASN = {
    '95.216.1.1': { autonomous_system_number: 24940, autonomous_system_organization: 'Hetzner Online GmbH' },
    '3.5.1.1': { autonomous_system_number: 14618, autonomous_system_organization: 'Amazon.com, Inc.' },
    '104.18.24.82': { autonomous_system_number: 13335, autonomous_system_organization: 'Cloudflare, Inc.' },
};
const reader = (t) => ({ get: (ip) => t[ip] || null });
geoDb.__setReadersForTests({ city: reader(CITY), asn: reader(ASN) });

const store = require('./integrationActivityStore');
const schema = require('./integrationActivitySchema');

const flatSql = (s) => s.replace(/\s+/g, ' ');
const settle = () => new Promise(r => setImmediate(r));

/** The last INSERT as { column: value }. */
function lastInsert() {
    const call = dbCalls.run.filter(c => /INSERT INTO integration_activity_log/.test(c.sql)).at(-1);
    assert.ok(call, 'insert did not run');
    const cols = call.sql.match(/\(([^)]+)\)\s*VALUES/s)[1].split(',').map(s => s.trim());
    return Object.fromEntries(cols.map((c, i) => [c, call.params[i]]));
}
const signalClaims = () => dbCalls.getOne.filter(c => /INSERT INTO compliance_signal_debounce/.test(c.sql));

test('initDB runs the DDL exactly once under concurrent first calls', async () => {
    // Module load already kicked off one init (cold: probe null → full DDL).
    // Wait for it, note the count, then hammer it: no further DDL may run.
    execDelayMs = 5;
    await Promise.all([
        store.getIntegrationSummary({}),
        store.getIntegrationSummary({}),
        store.getEgressLog({}, 5),
    ]);
    execDelayMs = 0;
    const ddlRuns = dbCalls.exec.filter(s => /CREATE TABLE IF NOT EXISTS integration_activity_log/.test(s)).length;
    assert.strictEqual(ddlRuns, 1, `main CREATE TABLE ran ${ddlRuns}× — initDB is not single-flight`);
    // The cross-replica debounce table is created by the same init.
    assert.strictEqual(dbCalls.exec.filter(s => /CREATE TABLE IF NOT EXISTS compliance_signal_debounce/.test(s)).length, 1);
    // The consolidated ladder: exactly one ALTER TABLE statement, not ~20.
    const alters = dbCalls.exec.filter(s => /ALTER TABLE integration_activity_log/.test(s)).length;
    assert.strictEqual(alters, 1, `expected 1 consolidated ALTER, saw ${alters}`);
});

test('cold init creates the partial live indexes and drops the covered one', () => {
    const all = dbCalls.exec.join('\n');
    assert.match(all, /idx_integ_org_ts_live.*WHERE is_dry_run = false/s);
    assert.match(all, /idx_integ_org_ts_noneu.*is_eu = false AND is_local = false AND is_dry_run = false/s);
    assert.match(all, /DROP INDEX IF EXISTS idx_integ_org\b/);
    // Backfills are guarded (idempotent) AND batched (id IN … LIMIT): a
    // single whole-table UPDATE hit the pool-wide statement_timeout on large
    // ledgers, rolled back, and was never retried. They go through run().
    const backfills = dbCalls.run.map(c => c.sql).join('\n');
    assert.match(backfills, /UPDATE integration_activity_log SET dest_host[\s\S]*WHERE dest_host IS NULL[\s\S]*LIMIT \d+/);
    assert.match(backfills, /'\^https\?:\/\/', '', 'i'/, 'scheme strip must be case-insensitive like destHostFrom');
    assert.match(backfills, /SET pii_scan_level = 'full'[\s\S]*pii_scan_enabled = true AND pii_scan_level = 'none'[\s\S]*LIMIT \d+/);
});

test('the ladder adds the location columns, nullable, without any new index', () => {
    const ladder = dbCalls.exec.find(s => /ALTER TABLE integration_activity_log/.test(s));
    for (const col of ['location_state TEXT', 'location_basis TEXT', 'city TEXT', 'region TEXT', 'lat DOUBLE PRECISION',
        'lon DOUBLE PRECISION', 'asn BIGINT', 'as_org TEXT', 'network TEXT', 'edge_pop TEXT', 'peers JSONB']) {
        assert.match(ladder, new RegExp(`ADD COLUMN IF NOT EXISTS ${col},?\\s*$`, 'm'), col);
    }
    assert.ok(!/location_state[^\n]*DEFAULT/.test(ladder), 'no default: adding it must not rewrite the table');
    assert.ok(!dbCalls.exec.some(s => /CREATE INDEX[^\n]*(location_state|asn|lat)/.test(s)), 'volume table: no new index');
    // The warm-boot probe points at the newest column, so existing installs run this.
    assert.match(dbCalls.getOne[0].sql, /column_name = 'peers'/);
});

test('buildFilters: excludeDryRun, userId, and EXACT pii-category match', () => {
    const { where, params } = store.buildFilters({
        organizationId: 'org1', userId: 'u1', piiCategory: ' Email ', excludeDryRun: true,
    });
    const w = flatSql(where);
    assert.match(w, /organization_id = \$\d/);
    assert.match(w, /user_id = \$\d/);
    assert.match(w, /is_dry_run = false/);
    // Exact match via unnest+trim — NOT a substring ILIKE.
    assert.match(w, /EXISTS \( SELECT 1 FROM unnest\(string_to_array\(pii_categories_detected, ','\)\)/);
    assert.ok(!/ILIKE/.test(w), 'pii category must not use substring ILIKE');
    assert.deepStrictEqual(params, ['org1', 'u1', 'Email'], 'pii param is trimmed');
});

test('buildFilters: manualOnly keeps the chat sources only, never automations or pattern_scan reads', () => {
    const { where, params } = store.buildFilters({ userId: 'u1', manualOnly: true });
    const w = flatSql(where);
    assert.match(w, /user_id = \$1/);
    assert.match(w, /source = ANY\(\$2::text\[\]\)/);
    assert.match(w, /automation_id IS NULL/);
    assert.deepStrictEqual(params, ['u1', ['agent_chat', 'agent_stream', 'direct_chat']]);
    assert.ok(!params[1].includes('pattern_scan') && !params[1].includes('automation'));
    // Without the flag nothing changes for the dashboards.
    assert.ok(!/source = ANY/.test(flatSql(store.buildFilters({ userId: 'u1' }).where)));
});

test('getRecentIntegrationActivity scopes by userId (consumer leak regression)', async () => {
    dbCalls.getAll.length = 0;
    await store.getRecentIntegrationActivity(25, { userId: 'consumer-1' });
    const call = dbCalls.getAll.at(-1);
    assert.match(flatSql(call.sql), /user_id = \$\d/);
    assert.ok(call.params.includes('consumer-1'));
    // Deprecated endpoint, frozen shape: SELECT * would silently widen it
    // with the new error_message column (raw upstream error text).
    assert.ok(!/SELECT \*/.test(call.sql), 'recent must use an explicit column list');
    assert.ok(!/error_message/.test(call.sql), 'recent must NOT expose error_message');
});

test('getEgressLog: excludeDryRun, keyset cursor, clamped limit, no SELECT *', async () => {
    dbCalls.getAll.length = 0;
    await store.getEgressLog({ excludeDryRun: true, beforeId: 1000 }, 99999);
    const call = dbCalls.getAll.at(-1);
    const sql = flatSql(call.sql);
    assert.match(sql, /is_dry_run = false/);
    assert.match(sql, /id < \$\d/);
    assert.ok(!/SELECT \*/.test(sql), 'egress log must use an explicit column list');
    assert.match(sql, /dest_host/);
    // The authoritative admin view DOES carry the failure reason — the FE
    // renders "Failed — <message>" in the expanded row.
    assert.match(sql, /error_message/);
    assert.strictEqual(call.params.at(-1), 200, 'limit must clamp to 200');
});

test('getEgressLog: location fields, the legacy fallback, and the state filters', async () => {
    dbCalls.getAll.length = 0;
    await store.getEgressLog({ euOnly: false, locationState: 'via_network' }, 10);
    const call = dbCalls.getAll.at(-1);
    const sql = flatSql(call.sql);
    for (const f of ['AS location_state', 'AS location_basis', 'city', 'lat', 'lon', 'edge_pop', 'network', 'as_org', 'peers']) {
        assert.ok(sql.includes(f), f);
    }
    assert.match(sql, /COALESCE\(location_state, CASE/, 'a pre-rework row reads its state from the legacy flags');
    assert.match(sql, /is_eu = false AND is_local = false AND COALESCE\(location_state[\s\S]*= 'outside'/, '"left Europe" means outside');
    assert.ok(call.params.includes('via_network'));
    // "Not checked" must reach the Shield: it must never read as "nothing found".
    assert.match(sql, /CASE WHEN pii_scan_level = 'none' AND pii_scan_enabled = true THEN 'full' ELSE pii_scan_level END AS pii_scan_level/);
    dbCalls.getAll.length = 0;
    await store.getEgressLog({ locationState: "x' OR 1=1" }, 10);
    assert.ok(!dbCalls.getAll.at(-1).params.includes("x' OR 1=1"), 'an unknown state is ignored, never interpolated');
});

test('logIntegrationActivity writes status/dest_host/pii_scan_level and retires server_ip', async () => {
    await store.logIntegrationActivity({
        tool_name: 'web_search',
        server_endpoint: 'api.serper.dev (Google Search)',
        status: 'error',
        error_message: 'x'.repeat(600),
        duration_ms: 123.7,
        pii_scan_level: 'basic',
    });
    const row = lastInsert();
    assert.strictEqual(row.status, 'error');
    assert.strictEqual(row.error_message.length, 500, 'error_message must truncate to 500');
    assert.strictEqual(row.duration_ms, 124, 'duration is rounded to whole ms');
    assert.strictEqual(row.dest_host, 'api.serper.dev', 'parenthetical label stripped');
    assert.strictEqual(row.pii_scan_level, 'basic');
    assert.strictEqual(row.pii_scan_enabled, true, 'derived for old readers');
    assert.strictEqual(row.server_ip, null, 'server_ip is a retired duplicate of peer_ip');
    // No probe, no hint: nothing was seen, so the location is unknown (and
    // there is no DNS lookup after the call to guess one).
    assert.strictEqual(row.location_state, 'unknown');
    assert.strictEqual(row.location_basis, 'none');
    assert.strictEqual(row.is_eu, false);
    assert.strictEqual(row.is_local, false);
});

test('logIntegrationActivity defaults: unknown status → success, no scan → none', async () => {
    await store.logIntegrationActivity({ tool_name: 't', status: 'weird' });
    const row = lastInsert();
    assert.strictEqual(row.status, 'success');
    assert.strictEqual(row.pii_scan_level, 'none');
    assert.strictEqual(row.pii_scan_enabled, false);
});

test('a private peer (Nextcloud on 172.21.x) is local: not "left Europe", no Art-44 signal', async () => {
    const before = signalClaims().length;
    await store.logIntegrationActivity({
        organization_id: 'org-local', tool_name: 'nextcloud_read_file', server_endpoint: 'http://bee-flow-nc-sandbox',
        probe: { sealed: true, is_local: false, peers: [{ host: 'bee-flow-nc-sandbox', ip: '172.21.0.5', port: 80, family: 4, sentBody: true, basis: 'socket', edge: null }] },
    });
    const row = lastInsert();
    assert.strictEqual(row.location_state, 'local');
    assert.strictEqual(row.is_local, true);
    assert.strictEqual(row.is_eu, false);
    assert.strictEqual(row.peer_ip, '172.21.0.5');
    assert.strictEqual(row.peer_ip_source, 'socket');
    assert.strictEqual(row.tls_servername, 'bee-flow-nc-sandbox');
    await settle();
    assert.strictEqual(signalClaims().length, before, 'a private address is not a transfer');
});

test('no peers: the local hint decides (always passed by the logger)', async () => {
    await store.logIntegrationActivity({ tool_name: 'notification_inapp', server_endpoint: 'local', is_local_hint: true });
    assert.strictEqual(lastInsert().location_state, 'local');
    assert.strictEqual(lastInsert().peer_ip_source, 'local');
    await store.logIntegrationActivity({ tool_name: 'x', probe: { sealed: true, is_local: true, peers: [] } });
    assert.strictEqual(lastInsert().location_state, 'local', 'the probe hint works too');
});

test('Cloudflare with cf-ray: via_network at the Amsterdam edge, no Art-44 signal', async () => {
    const before = signalClaims().length;
    await store.logIntegrationActivity({
        organization_id: 'org-cf', tool_name: 'fireflies_get_transcripts', server_endpoint: 'api.fireflies.ai',
        probe: { sealed: true, peers: [{ host: 'api.fireflies.ai', ip: '104.18.24.82', sentBody: true, basis: 'socket', edge: { 'cf-ray': 'a41859ef1d78ae32-AMS', server: 'cloudflare' } }] },
    });
    const row = lastInsert();
    assert.strictEqual(row.location_state, 'via_network');
    assert.strictEqual(row.location_basis, 'edge_header');
    assert.strictEqual(row.network, 'Cloudflare');
    assert.strictEqual(row.edge_pop, 'AMS');
    assert.strictEqual(row.city, 'Amsterdam');
    assert.strictEqual(row.country_code, 'NL', 'the edge, not the registry country (CA)');
    assert.strictEqual(row.asn, 13335);
    assert.strictEqual(row.operator, 'Cloudflare');
    assert.strictEqual(row.peers, null, 'one peer: no peers column');
    await settle();
    assert.strictEqual(signalClaims().length, before);
});

test('outside Europe: located, operator named, Art-44 signal claimed', async () => {
    await store.logIntegrationActivity({
        organization_id: 'org-us', tool_name: 's3_put', server_endpoint: 's3.amazonaws.com',
        probe: { sealed: true, peers: [
            { host: 'sts.amazonaws.com', ip: '95.216.1.1', sentBody: true, basis: 'socket' },
            { host: 's3.amazonaws.com', ip: '3.5.1.1', sentBody: true, basis: 'socket' },
        ] },
    });
    const row = lastInsert();
    assert.strictEqual(row.location_state, 'outside');
    assert.strictEqual(row.is_eu, false);
    assert.strictEqual(row.country_code, 'US');
    assert.strictEqual(row.city, 'Ashburn');
    assert.strictEqual(row.operator, 'Amazon AWS');
    assert.strictEqual(row.peer_ip, '3.5.1.1', 'primary = the integration host');
    const peers = JSON.parse(row.peers);
    assert.deepStrictEqual(peers.map(p => [p.host, p.state]), [['sts.amazonaws.com', 'eu'], ['s3.amazonaws.com', 'outside']]);
    await settle();
    const claim = signalClaims().at(-1);
    assert.deepStrictEqual(claim.params, ['org-us', 'external_transfer:Amazon AWS']);
});

test('an old-shape probe (one peer_ip, no peers) still locates', async () => {
    await store.logIntegrationActivity({
        tool_name: 'x', server_endpoint: 'api.example.fi',
        probe: { peer_ip: '95.216.1.1', peer_ip_source: 'socket', tls_servername: 'api.example.fi', connect_ms: 12, is_local: false },
    });
    const row = lastInsert();
    assert.strictEqual(row.location_state, 'eu');
    assert.strictEqual(row.is_eu, true);
    assert.strictEqual(row.peer_ip, '95.216.1.1');
    assert.strictEqual(row.peer_ip_source, 'socket');
    assert.strictEqual(row.tls_servername, 'api.example.fi');
    assert.strictEqual(row.connect_ms, 12);
    assert.strictEqual(row.as_org, 'Hetzner Online GmbH');
    assert.strictEqual(row.operator, null, 'an ASN outside the known labels gives no operator');
});

test('a stdio MCP child: unknown via child_process, grouped under its mcp-server:// endpoint', async () => {
    await store.logIntegrationActivity({
        tool_name: 'mcp_filesystem_read', server_endpoint: 'mcp-server://filesystem',
        probe: { sealed: true, peers: [{ host: 'filesystem', ip: null, basis: 'child_process', sentBody: true }] },
    });
    const row = lastInsert();
    assert.strictEqual(row.location_state, 'unknown');
    assert.strictEqual(row.location_basis, 'child_process');
    assert.strictEqual(row.peer_ip, null);
    assert.strictEqual(row.tls_servername, null, 'a label is not a TLS server name');
    assert.strictEqual(row.dest_host, 'mcp-server://filesystem');
});

test('dry runs and cache hits never raise the Art-44 signal', async () => {
    const before = signalClaims().length;
    const probe = { sealed: true, peers: [{ host: 's3.amazonaws.com', ip: '3.5.1.1', sentBody: true }] };
    await store.logIntegrationActivity({ organization_id: 'org-dry', tool_name: 'x', is_dry_run: true, probe });
    await store.logIntegrationActivity({ organization_id: 'org-dry', tool_name: 'x', served_from_cache: true, probe });
    await settle();
    assert.strictEqual(signalClaims().length, before);
});

test('warm boot: the location backfill starts only while its marker is missing', async () => {
    const note = schema.LOCATION_BACKFILL_DONE;
    assert.strictEqual(schema.locationBackfillDone(note), true);
    assert.strictEqual(schema.locationBackfillDone(null), false);
    // The probe reads the marker from the column comment.
    assert.match(dbCalls.getOne[0].sql, /col_description[\s\S]*location_state/);
});

test('location backfill: detached, id ranges up to the max, JS pass then legacy CASE in order', async () => {
    dbCalls.run.length = 0;
    dbCalls.exec.length = 0;
    oneRoutes.push([/MIN\(id\) AS min_id/, () => ({ min_id: 1, max_id: 25 })]);
    allRoutes.push([/AS ip, .* AS host/s, (_sql, [from]) => (from === 0
        ? [{ id: 3, ip: '104.18.24.82', host: 'api.fireflies.ai' }, { id: 4, ip: '95.216.1.1', host: 'x.example.fi' }]
        : [])]);
    const result = await schema.runLocationBackfill({ batch: 10, pauseMs: 0 });
    oneRoutes.length = 0;
    allRoutes.length = 0;
    assert.deepStrictEqual(result, { located: 2, legacy: 3, ranges: 3 });

    const legacy = dbCalls.run.filter(c => /location_basis = 'backfill',\s*is_local = \(s\.state = 'local'\)/.test(c.sql));
    assert.deepStrictEqual(legacy.map(c => c.params), [[0, 10], [10, 20], [20, 25]], 'ranges up to the max id at start');
    const sql = flatSql(legacy[0].sql);
    assert.match(sql, /WHERE id > \$1 AND id <= \$2 AND location_state IS NULL/, 'idempotent by NULL state');
    assert.ok(!/::inet/.test(sql), 'no inet cast: one malformed historical value must not fail the batch');
    const at = (needle) => sql.indexOf(needle);
    assert.ok(at("THEN 'local'") < at("operator IN ('Cloudflare', 'Fastly', 'OpenAI', 'Akamai')"), 'local first');
    assert.ok(at("THEN 'via_network'") < at("COALESCE(is_eu, false) THEN 'eu'"), 'anycast before is_eu (ip-api said NL)');
    assert.ok(at("THEN 'eu'") < at("THEN 'outside'"), 'eu before outside');
    assert.match(sql, /100\\\.\(6\[4-9\]/, 'CGNAT counts as private');

    const located = dbCalls.run.find(c => /FROM unnest\(\$1::int\[\]/.test(c.sql));
    assert.deepStrictEqual(located.params[0], [3, 4]);
    assert.deepStrictEqual(located.params[1], ['via_network', 'eu'], 'Cloudflare is re-located, not left in Canada');
    assert.match(dbCalls.exec.at(-1), /COMMENT ON COLUMN integration_activity_log\.location_state IS 'location backfill: done'/);
});

test('overview: score over located calls only, via_network and unknown counted apart', async () => {
    oneRoutes.push([/AS total_calls/, () => ({
        total_calls: '1000', local_count: '461', eu_count: '0', via_network_count: '39', unknown_count: '500',
        non_eu_count: '0', pii_non_eu_count: '0', located_count: '461',
    })]);
    const data = await store.getIntegrationOverview({}, 'day');
    oneRoutes.length = 0;
    // The old formula over all 1000 calls said 1/100 for exactly this ledger.
    assert.strictEqual(data.summary.sovereignty_score, 100);
    assert.strictEqual(data.summary.via_network_count, 39);
    assert.strictEqual(data.summary.unknown_count, 500);
    assert.strictEqual(data.summary.located_count, 461);
    assert.strictEqual(data.summary.coverage_pct, 46.1);
    assert.deepStrictEqual(data.map.attribution, { text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' });
    assert.deepStrictEqual(data.map.geo_db, { available: true, edition: 'dbip-city-lite', date: '2026-09' });
    assert.strictEqual(data.health.geo_db, true);
});

test('overview: calls per Shield outcome — a blocked call in neither, an unscanned one not "clean"', async () => {
    let summarySql = '';
    oneRoutes.push([/AS total_calls/, (sql) => { summarySql = flatSql(sql); return { total_calls: '10', clean_count: '3', unchecked_count: '5' }; }]);
    const data = await store.getIntegrationOverview({}, 'day');
    oneRoutes.length = 0;
    assert.strictEqual(data.summary.clean_count, '3');
    assert.strictEqual(data.summary.unchecked_count, '5');
    assert.match(summarySql, /status IS DISTINCT FROM 'blocked' AND NOT \(pii_categories_detected IS NOT NULL[^)]*\) AND NOT \(pii_scan_level = 'none' AND pii_scan_enabled IS NOT TRUE\)\) AS clean_count/);
    assert.match(summarySql, /status IS DISTINCT FROM 'blocked' AND NOT \(pii_categories_detected IS NOT NULL[^)]*\) AND pii_scan_level = 'none' AND pii_scan_enabled IS NOT TRUE\) AS unchecked_count/);
});

test('overview: nothing located → score null; outside with PII costs double', async () => {
    oneRoutes.push([/AS total_calls/, () => ({ total_calls: '5', unknown_count: '5', located_count: '0' })]);
    assert.strictEqual((await store.getIntegrationOverview({})).summary.sovereignty_score, null);
    oneRoutes.length = 0;
    oneRoutes.push([/AS total_calls/, () => ({ total_calls: '10', located_count: '10', non_eu_count: '2', pii_non_eu_count: '1' })]);
    // 100 × (1 − (2 + 1) / (10 + 1)) = 72.7 → 73
    assert.strictEqual((await store.getIntegrationOverview({})).summary.sovereignty_score, 73);
    oneRoutes.length = 0;
    const { sovereigntyScore } = require('./integrationOverview');
    assert.strictEqual(sovereigntyScore(0, 0, 0), null);
});

test('overview: one location per host, ≤200 for the map, top 12 for the list, origin from the env', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
        dest_host: `h${i}.example`, operator: i === 0 ? 'Cloudflare' : null, total: String(100 - i), pii_events: '1',
        last_contact: '2026-09-27T08:00:00Z', location_state: i === 0 ? 'via_network' : 'eu', location_basis: i === 0 ? 'edge_header' : 'socket',
        city: i === 0 ? 'Amsterdam' : 'Helsinki', lat: 52.31, lon: 4.76, country_code: i === 0 ? 'NL' : 'FI', country_name: null,
        edge_pop: i === 0 ? 'AMS' : null, network: i === 0 ? 'Cloudflare' : null, as_org: 'X', sample_peer_ip: '104.18.24.82',
    }));
    allRoutes.push([/WITH base AS/, () => rows]);
    process.env.BEEFLOW_SERVER_LOCATION = 'NL';
    dbCalls.getAll.length = 0;
    const data = await store.getIntegrationOverview({ organizationId: 'o1' });
    delete process.env.BEEFLOW_SERVER_LOCATION;
    allRoutes.length = 0;

    const sql = flatSql(dbCalls.getAll.find(c => /WITH base AS/.test(c.sql)).sql);
    assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY dest_host ORDER BY COUNT\(\*\) DESC/, 'most frequent location tuple per host');
    assert.match(sql, /GROUP BY dest_host, location_state, city, lat, lon, country_code, edge_pop/);
    assert.match(sql, /t\.rk = 1/);
    assert.match(sql, /LIMIT 200/);

    assert.strictEqual(data.map.destinations.length, 15);
    assert.strictEqual(data.top.destinations.length, 12);
    const d = data.top.destinations[0];
    for (const f of ['dest_host', 'operator', 'as_org', 'network', 'country_code', 'country_name', 'city', 'lat', 'lon',
        'location_state', 'location_basis', 'edge_pop', 'is_eu', 'is_local', 'total', 'pii_events', 'last_contact',
        'sample_peer_ip', 'country_flag']) {
        assert.ok(f in d, f);
    }
    assert.strictEqual(d.total, 100);
    assert.strictEqual(d.country_name, 'Netherlands');
    assert.strictEqual(d.is_eu, false, 'via_network is not "in Europe"');
    assert.strictEqual(data.top.destinations[1].is_eu, true);
    assert.deepStrictEqual(data.map.origin, { country_code: 'NL', country_name: 'Netherlands', lat: 52.37, lon: 4.9, label: 'Netherlands' });
});

test('overview: the category normaliser is injected by the caller', async () => {
    allRoutes.push([/unnest\(string_to_array\(pii_categories_detected/, () => [
        { category: 'Email Address', count: '2', non_eu_count: '1' }, { category: 'email', count: '3', non_eu_count: '0' },
    ]]);
    const data = await store.getIntegrationOverview({}, 'day', { normalizeCategory: (c) => String(c).toLowerCase().includes('email') ? 'email' : null });
    allRoutes.length = 0;
    assert.deepStrictEqual(data.pii_categories, [{ category: 'email', count: 5, non_eu_count: 1 }]);
});

test('destHostFrom: one stable key per destination', () => {
    const f = store.destHostFrom;
    assert.strictEqual(f('gmail.googleapis.com', 'www.googleapis.com/gmail'), 'gmail.googleapis.com', 'tls_servername wins');
    assert.strictEqual(f(null, 'https://api.openai.com/v1/images'), 'api.openai.com');
    assert.strictEqual(f(null, 'api.serper.dev (Google Search)'), 'api.serper.dev');
    assert.strictEqual(f(null, 'youtrack.example.com:8443/api'), 'youtrack.example.com');
    assert.strictEqual(f(null, 'n8n-server (configured)'), 'n8n-server', 'non-dotted labels still get a key');
    assert.strictEqual(f(null, 'MCP-Server://Filesystem'), 'mcp-server://filesystem', 'MCP URIs kept whole');
    assert.strictEqual(f('', ''), null);
    assert.strictEqual(f(null, null), null);
});

test.after(() => {
    Module._resolveFilename = origResolve;
    geoDb.__resetForTests();
});
