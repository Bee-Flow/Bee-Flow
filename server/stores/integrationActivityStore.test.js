// @typecheck
/**
 * Store-level tests — integration activity ledger, against a real Postgres
 * (PGlite behind db.js's pool, testUtils/pglitePool.js) with the store's own
 * schema. The location database is a fake reader installed through
 * geoDb.__setReadersForTests (no file, no network).
 *
 * Pins the contracts the monitoring rework introduced:
 *  1. initDB is single-flight; the boot backfills (dest_host, pii_scan_level,
 *     location) correct the rows a ledger from before them holds;
 *  2. the filters honour userId and excludeDryRun, and match PII categories
 *     EXACTLY (not a substring);
 *  3. getRecentIntegrationActivity scopes by userId (attachOrgFilter scopes
 *     org-less accounts by userId ONLY);
 *  4. destHostFrom produces one stable grouping key per destination.
 * And the location rework:
 *  5. every call is located from its probe peers: a private address is local
 *     (not "left Europe"), Cloudflare is via_network at its edge, an old
 *     single-address probe still works, and only 'outside' raises Art-44;
 *  6. the location backfill runs in id ranges and applies its cases in order;
 *  7. the overview scores located calls only and gives one location per host.
 *
 * Run: node --test server/stores/integrationActivityStore.test.js
 */

'use strict';

const assert = require('node:assert');
const { test, before, beforeEach, after } = require('node:test');

const { newPglite } = require('../testUtils/pgliteTemplate');
const { insertRow } = require('../testUtils/pgliteSeed');
const { recordDb } = require('../testUtils/routeHarness');

const pg = newPglite();
// Every statement is recorded, then run on the PGlite.
const rec = recordDb(undefined, { pg });

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

const settle = () => new Promise((r) => setImmediate(r));
const T = 'integration_activity_log';

/** The newest ledger row, as the database holds it. */
const lastInsert = async () => (await pg.query(`SELECT * FROM ${T} ORDER BY id DESC LIMIT 1`)).rows[0];
const claims = async () => (await pg.query('SELECT org_id, signal_key FROM compliance_signal_debounce ORDER BY org_id, signal_key')).rows;
/** A ledger row as another writer left it; `timestamp` defaults to now. */
const put = (over = {}) => insertRow(pg, T, { tool_name: 'x', ...over });

// ── a ledger from before the column ladder, booted ───────────────────────
//
// The table exists in its first shape with rows that predate every backfill;
// the first initDB then runs the ladder, the batched backfills and the
// detached location backfill over them.

/** What the first boot sent, and the seeded rows as it left them. */
const boot = { sql: /** @type {string[]} */ ([]), rows: /** @type {Record<string, any>} */ ({}), note: null };
before(async () => {
    await pg.exec(`
        CREATE TABLE ${T} (
            id SERIAL PRIMARY KEY, timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            organization_id TEXT, user_id TEXT, agent_id TEXT, agent_name TEXT, conversation_id TEXT,
            tool_name TEXT NOT NULL, integration_type TEXT, server_endpoint TEXT, data_direction TEXT DEFAULT 'sent',
            data_categories TEXT, pii_categories_detected TEXT, pii_scan_enabled BOOLEAN DEFAULT false,
            data_summary TEXT, source TEXT DEFAULT 'unknown', model TEXT, server_ip TEXT,
            country_code TEXT, country_name TEXT, is_eu BOOLEAN DEFAULT false
        )`);
    const legacy = {
        scheme: await put({ server_endpoint: 'HTTPS://API.Example.com:8443/v1 (Example)', pii_scan_enabled: true }),
        mcp: await put({ server_endpoint: 'MCP-Server://Filesystem' }),
        privateNc: await put({ server_endpoint: 'http://nc', server_ip: '172.21.0.5', country_code: 'US' }),
        cgnat: await put({ server_endpoint: 'pod', server_ip: '100.64.3.4' }),
        cloudflare: await put({ server_endpoint: 'api.fireflies.ai', server_ip: '104.18.24.82', country_code: 'CA' }),
        hetzner: await put({ server_endpoint: 'api.example.fi', server_ip: '95.216.1.1' }),
        usNoIp: await put({ server_endpoint: 'api.us.example', country_code: 'US' }),
        euNoIp: await put({ server_endpoint: 'api.eu.example', is_eu: true, country_code: 'DE' }),
        nothing: await put({ server_endpoint: 'mystery' }),
    };
    rec.reset();
    await Promise.all([store.initDB(), store.initDB(), store.getIntegrationSummary({}), store.getEgressLog({}, 5)]);
    await schema.startLocationBackfill();
    boot.sql = [...rec.all];
    for (const [name, row] of Object.entries(legacy)) boot.rows[name] = (await pg.query(`SELECT * FROM ${T} WHERE id = $1`, [row.id])).rows[0];
    boot.note = (await pg.query(`SELECT col_description('${T}'::regclass, attnum) AS n FROM pg_attribute
        WHERE attrelid = '${T}'::regclass AND attname = 'location_state'`)).rows[0].n;
});
after(async () => {
    geoDb.__resetForTests();
    await pg.close();
});
beforeEach(async () => {
    await pg.exec(`TRUNCATE ${T}, compliance_signal_debounce`);
});

test('initDB runs the schema once under concurrent first calls', async () => {
    const count = (re) => boot.sql.filter((s) => re.test(s)).length;
    assert.strictEqual(count(/CREATE TABLE IF NOT EXISTS integration_activity_log/), 1, 'initDB is single-flight');
    assert.strictEqual(count(/CREATE TABLE IF NOT EXISTS compliance_signal_debounce/), 1, 'the cross-replica debounce table is created by the same init');
    assert.strictEqual(count(/ALTER TABLE integration_activity_log/), 1, 'one consolidated ALTER');
    rec.reset();
    await Promise.all([store.getIntegrationSummary({}), store.getIntegrationSummary({}), store.getEgressLog({}, 5)]);
    assert.deepStrictEqual(rec.all.filter((s) => /CREATE|ALTER/.test(s)), [], 'a warm store sends no DDL');
    assert.strictEqual(rec.all.length, 3, 'one read per call');
});

test('the ladder adds the location columns, nullable and without a default, and the partial live indexes', async () => {
    const { rows } = await pg.query(`SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name = $1`, [T]);
    const col = Object.fromEntries(rows.map((r) => [r.column_name, r]));
    for (const [c, type] of [['location_state', 'text'], ['location_basis', 'text'], ['city', 'text'], ['region', 'text'],
        ['lat', 'double precision'], ['lon', 'double precision'], ['asn', 'bigint'], ['as_org', 'text'], ['network', 'text'],
        ['edge_pop', 'text'], ['peers', 'jsonb']]) {
        assert.strictEqual(col[c]?.data_type, type, c);
        assert.strictEqual(col[c].is_nullable, 'YES', c);
    }
    assert.strictEqual(col.location_state.column_default, null, 'no default: adding it must not rewrite the table');
    const idx = Object.fromEntries((await pg.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`, [T])).rows.map((r) => [r.indexname, r.indexdef]));
    assert.match(idx.idx_integ_org_ts_live, /WHERE \(is_dry_run = false\)/);
    assert.match(idx.idx_integ_org_ts_noneu, /WHERE \(\(is_eu = false\) AND \(is_local = false\) AND \(is_dry_run = false\)\)/);
    assert.ok(!('idx_integ_org' in idx), 'the covered index is dropped');
    assert.ok(!Object.values(idx).some((d) => /\((location_state|asn|lat)\b/.test(d)), 'volume table: no index on the location columns');
});

test('boot backfills: dest_host (case-insensitive scheme, label and port stripped, MCP URI whole) and the scan level', async () => {
    const snap = boot.rows;
    assert.strictEqual(snap.scheme.dest_host, 'api.example.com');
    assert.strictEqual(snap.scheme.pii_scan_level, 'full', 'a scanned legacy row reads as fully scanned');
    assert.strictEqual(snap.mcp.dest_host, 'mcp-server://filesystem');
    assert.strictEqual(snap.mcp.pii_scan_level, 'none');
});

test('boot location backfill: private (CGNAT too) is local, an anycast prefix is via_network, geo first, legacy flags after', async () => {
    const snap = boot.rows;
    assert.strictEqual(snap.privateNc.location_state, 'local', 'a private Nextcloud address never "left Europe"');
    assert.strictEqual(snap.privateNc.is_local, true);
    assert.strictEqual(snap.cgnat.location_state, 'local');
    assert.strictEqual(snap.cloudflare.location_state, 'via_network', 'Cloudflare is re-located, not left in Canada');
    assert.strictEqual(snap.hetzner.location_state, 'eu');
    assert.strictEqual(snap.hetzner.city, 'Helsinki');
    assert.strictEqual(snap.hetzner.is_eu, true);
    assert.strictEqual(snap.usNoIp.location_state, 'outside');
    assert.strictEqual(snap.euNoIp.location_state, 'eu');
    assert.strictEqual(snap.nothing.location_state, 'unknown');
    for (const r of Object.values(snap)) assert.strictEqual(r.location_basis, 'backfill');
    assert.strictEqual(boot.note, schema.LOCATION_BACKFILL_DONE, 'it marks itself done');
    assert.strictEqual(schema.locationBackfillDone(boot.note), true);
    assert.strictEqual(schema.locationBackfillDone(null), false);
});

// ── filters ──────────────────────────────────────────────────────────────

test('filters: excludeDryRun, userId, and an EXACT, trimmed, case-insensitive pii-category match', async () => {
    const hit = await put({ organization_id: 'org1', user_id: 'u1', pii_categories_detected: 'Phone, email' });
    await put({ organization_id: 'org1', user_id: 'u1', pii_categories_detected: 'Email Address' });
    await put({ organization_id: 'org1', user_id: 'u1', pii_categories_detected: 'email', is_dry_run: true });
    await put({ organization_id: 'org1', user_id: 'u2', pii_categories_detected: 'email' });
    await put({ organization_id: 'org2', user_id: 'u1', pii_categories_detected: 'email' });
    const f = { organizationId: 'org1', userId: 'u1', piiCategory: ' Email ', excludeDryRun: true };
    assert.deepStrictEqual((await store.getRecentIntegrationActivity(50, f)).map((r) => r.id), [hit.id], 'buildFilters');
    assert.deepStrictEqual((await store.getEgressLog(f, 50)).map((r) => r.id), [hit.id], 'the egress log\'s own filter');
});

test('filters: manualOnly keeps the chat sources only, never automations or pattern_scan reads', async () => {
    const chat = await put({ user_id: 'u1', source: 'agent_chat' });
    const direct = await put({ user_id: 'u1', source: 'direct_chat' });
    await put({ user_id: 'u1', source: 'agent_chat', automation_id: 'a1' });
    await put({ user_id: 'u1', source: 'pattern_scan' });
    await put({ user_id: 'u1', source: 'automation' });
    const manual = await store.getRecentIntegrationActivity(50, { userId: 'u1', manualOnly: true });
    assert.deepStrictEqual(manual.map((r) => r.id).sort(), [chat.id, direct.id].sort());
    assert.strictEqual((await store.getRecentIntegrationActivity(50, { userId: 'u1' })).length, 5, 'without the flag nothing changes');
});

test('getRecentIntegrationActivity scopes by userId, keeps 90 days, and never carries error_message', async () => {
    const mine = await put({ user_id: 'consumer-1', error_message: 'https://upstream/secret-path 500' });
    await put({ user_id: 'consumer-2' });
    await put({ user_id: 'consumer-1', timestamp: new Date(Date.now() - 91 * 864e5) });
    const rows = await store.getRecentIntegrationActivity(25, { userId: 'consumer-1' });
    assert.deepStrictEqual(rows.map((r) => r.id), [mine.id]);
    // Deprecated endpoint, frozen shape: no raw upstream error text.
    assert.ok(!('error_message' in rows[0]));
    assert.ok('dest_host' in rows[0] && 'status' in rows[0]);
});

test('getEgressLog: excludeDryRun, keyset cursor, clamped limit, error_message carried', async () => {
    const ids = [];
    for (let i = 0; i < 205; i++) ids.push((await put({ is_dry_run: i === 204, error_message: i === 0 ? 'boom' : null })).id);
    const all = await store.getEgressLog({}, 99999);
    assert.strictEqual(all.length, 200, 'limit clamps to 200');
    assert.strictEqual(all[0].id, ids[204], 'newest first');
    const live = await store.getEgressLog({ excludeDryRun: true }, 5);
    assert.strictEqual(live[0].id, ids[203]);
    const older = await store.getEgressLog({ beforeId: ids[3] }, 10);
    assert.deepStrictEqual(older.map((r) => r.id), [ids[2], ids[1], ids[0]], 'strictly older than the cursor');
    // The authoritative admin view DOES carry the failure reason.
    assert.strictEqual(older[2].error_message, 'boom');
});

test('getEgressLog: location fields, the legacy fallback, and the state filters', async () => {
    const outside = await put({ server_endpoint: 'a', location_state: 'outside', is_eu: false, is_local: false, city: 'Ashburn', lat: 1, lon: 2 });
    const via = await put({ server_endpoint: 'b', location_state: 'via_network', edge_pop: 'AMS', network: 'Cloudflare', as_org: 'C' });
    const legacyUs = await put({ server_endpoint: 'c', country_code: 'US', is_eu: false, is_local: false });
    const legacyScanned = await put({ server_endpoint: 'd', pii_scan_enabled: true, pii_scan_level: 'none', is_eu: true });
    const rows = Object.fromEntries((await store.getEgressLog({}, 10)).map((r) => [r.id, r]));
    for (const f of ['location_state', 'location_basis', 'city', 'lat', 'lon', 'edge_pop', 'network', 'as_org', 'peers']) assert.ok(f in rows[via.id], f);
    assert.strictEqual(rows[legacyUs.id].location_state, 'outside', 'a pre-rework row reads its state from the legacy flags');
    assert.strictEqual(rows[legacyUs.id].location_basis, 'backfill');
    // "Not checked" must reach the Shield and never read as "nothing found".
    assert.strictEqual(rows[legacyScanned.id].pii_scan_level, 'full');
    assert.strictEqual(rows[outside.id].pii_scan_level, 'none');

    assert.deepStrictEqual((await store.getEgressLog({ euOnly: false }, 10)).map((r) => r.id), [legacyUs.id, outside.id], '"left Europe" means outside');
    assert.deepStrictEqual((await store.getEgressLog({ locationState: 'via_network' }, 10)).map((r) => r.id), [via.id]);
    assert.strictEqual((await store.getEgressLog({ locationState: "x' OR 1=1" }, 10)).length, 4, 'an unknown state is ignored, never interpolated');
});

// ── logIntegrationActivity ───────────────────────────────────────────────

test('logIntegrationActivity writes status/dest_host/pii_scan_level and retires server_ip', async () => {
    await store.logIntegrationActivity({
        tool_name: 'web_search',
        server_endpoint: 'api.serper.dev (Google Search)',
        status: 'error',
        error_message: 'x'.repeat(600),
        duration_ms: 123.7,
        pii_scan_level: 'basic',
    });
    const row = await lastInsert();
    assert.strictEqual(row.status, 'error');
    assert.strictEqual(row.error_message.length, 500, 'error_message truncates to 500');
    assert.strictEqual(row.duration_ms, 124, 'duration is rounded to whole ms');
    assert.strictEqual(row.dest_host, 'api.serper.dev', 'parenthetical label stripped');
    assert.strictEqual(row.pii_scan_level, 'basic');
    assert.strictEqual(row.pii_scan_enabled, true, 'derived for old readers');
    assert.strictEqual(row.server_ip, null, 'server_ip is a retired duplicate of peer_ip');
    // No probe, no hint: nothing was seen, so the location is unknown.
    assert.strictEqual(row.location_state, 'unknown');
    assert.strictEqual(row.location_basis, 'none');
    assert.strictEqual(row.is_eu, false);
    assert.strictEqual(row.is_local, false);
});

test('logIntegrationActivity defaults: unknown status → success, no scan → none', async () => {
    await store.logIntegrationActivity({ tool_name: 't', status: 'weird' });
    const row = await lastInsert();
    assert.strictEqual(row.status, 'success');
    assert.strictEqual(row.pii_scan_level, 'none');
    assert.strictEqual(row.pii_scan_enabled, false);
});

test('a private peer (Nextcloud on 172.21.x) is local: not "left Europe", no Art-44 signal', async () => {
    await store.logIntegrationActivity({
        organization_id: 'org-local', tool_name: 'nextcloud_read_file', server_endpoint: 'http://bee-flow-nc-sandbox',
        probe: { sealed: true, is_local: false, peers: [{ host: 'bee-flow-nc-sandbox', ip: '172.21.0.5', port: 80, family: 4, sentBody: true, basis: 'socket', edge: null }] },
    });
    const row = await lastInsert();
    assert.strictEqual(row.location_state, 'local');
    assert.strictEqual(row.is_local, true);
    assert.strictEqual(row.is_eu, false);
    assert.strictEqual(row.peer_ip, '172.21.0.5');
    assert.strictEqual(row.peer_ip_source, 'socket');
    assert.strictEqual(row.tls_servername, 'bee-flow-nc-sandbox');
    await settle();
    assert.deepStrictEqual(await claims(), [], 'a private address is not a transfer');
});

test('no peers: the local hint decides (always passed by the logger)', async () => {
    await store.logIntegrationActivity({ tool_name: 'notification_inapp', server_endpoint: 'local', is_local_hint: true });
    const row = await lastInsert();
    assert.strictEqual(row.location_state, 'local');
    assert.strictEqual(row.peer_ip_source, 'local');
    await store.logIntegrationActivity({ tool_name: 'x', probe: { sealed: true, is_local: true, peers: [] } });
    assert.strictEqual((await lastInsert()).location_state, 'local', 'the probe hint works too');
});

test('Cloudflare with cf-ray: via_network at the Amsterdam edge, no Art-44 signal', async () => {
    await store.logIntegrationActivity({
        organization_id: 'org-cf', tool_name: 'fireflies_get_transcripts', server_endpoint: 'api.fireflies.ai',
        probe: { sealed: true, peers: [{ host: 'api.fireflies.ai', ip: '104.18.24.82', sentBody: true, basis: 'socket', edge: { 'cf-ray': 'a41859ef1d78ae32-AMS', server: 'cloudflare' } }] },
    });
    const row = await lastInsert();
    assert.strictEqual(row.location_state, 'via_network');
    assert.strictEqual(row.location_basis, 'edge_header');
    assert.strictEqual(row.network, 'Cloudflare');
    assert.strictEqual(row.edge_pop, 'AMS');
    assert.strictEqual(row.city, 'Amsterdam');
    assert.strictEqual(row.country_code, 'NL', 'the edge, not the registry country (CA)');
    assert.strictEqual(Number(row.asn), 13335);
    assert.strictEqual(row.operator, 'Cloudflare');
    assert.strictEqual(row.peers, null, 'one peer: no peers column');
    await settle();
    assert.deepStrictEqual(await claims(), []);
});

test('outside Europe: located, operator named, Art-44 signal claimed once per org and operator', async () => {
    const event = {
        organization_id: 'org-us', tool_name: 's3_put', server_endpoint: 's3.amazonaws.com',
        probe: { sealed: true, peers: [
            { host: 'sts.amazonaws.com', ip: '95.216.1.1', sentBody: true, basis: 'socket' },
            { host: 's3.amazonaws.com', ip: '3.5.1.1', sentBody: true, basis: 'socket' },
        ] },
    };
    await store.logIntegrationActivity(event);
    const row = await lastInsert();
    assert.strictEqual(row.location_state, 'outside');
    assert.strictEqual(row.is_eu, false);
    assert.strictEqual(row.country_code, 'US');
    assert.strictEqual(row.city, 'Ashburn');
    assert.strictEqual(row.operator, 'Amazon AWS');
    assert.strictEqual(row.peer_ip, '3.5.1.1', 'primary = the integration host');
    assert.deepStrictEqual(row.peers.map((p) => [p.host, p.state]), [['sts.amazonaws.com', 'eu'], ['s3.amazonaws.com', 'outside']]);
    await settle();
    await settle();
    assert.deepStrictEqual(await claims(), [{ org_id: 'org-us', signal_key: 'external_transfer:Amazon AWS' }]);
});

test('an old-shape probe (one peer_ip, no peers) still locates', async () => {
    await store.logIntegrationActivity({
        tool_name: 'x', server_endpoint: 'api.example.fi',
        probe: { peer_ip: '95.216.1.1', peer_ip_source: 'socket', tls_servername: 'api.example.fi', connect_ms: 12, is_local: false },
    });
    const row = await lastInsert();
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
    const row = await lastInsert();
    assert.strictEqual(row.location_state, 'unknown');
    assert.strictEqual(row.location_basis, 'child_process');
    assert.strictEqual(row.peer_ip, null);
    assert.strictEqual(row.tls_servername, null, 'a label is not a TLS server name');
    assert.strictEqual(row.dest_host, 'mcp-server://filesystem');
});

test('dry runs and cache hits never raise the Art-44 signal', async () => {
    const probe = { sealed: true, peers: [{ host: 's3.amazonaws.com', ip: '3.5.1.1', sentBody: true }] };
    await store.logIntegrationActivity({ organization_id: 'org-dry', tool_name: 'x', is_dry_run: true, probe });
    await store.logIntegrationActivity({ organization_id: 'org-dry', tool_name: 'x', served_from_cache: true, probe });
    await settle();
    await settle();
    assert.deepStrictEqual(await claims(), []);
    const rows = (await pg.query(`SELECT is_dry_run, served_from_cache FROM ${T} ORDER BY id`)).rows;
    assert.deepStrictEqual(rows, [{ is_dry_run: true, served_from_cache: false }, { is_dry_run: false, served_from_cache: true }], 'both are still in the ledger');
});

// ── the location backfill ────────────────────────────────────────────────

test('location backfill: id ranges up to the max, geo pass then the legacy cases in order, idempotent', async () => {
    // Ids 1..25 without a state; the interesting ones are spread over the ranges.
    for (let i = 1; i <= 25; i++) await put({ id: i, server_endpoint: `h${i}` });
    const set = (id, over) => pg.query(`UPDATE ${T} SET ${Object.keys(over).map((k, j) => `${k} = $${j + 2}`).join(', ')} WHERE id = $1`, [id, ...Object.values(over)]);
    await set(3, { server_ip: '104.18.24.82', country_code: 'CA', server_endpoint: 'api.fireflies.ai' });
    await set(4, { server_ip: '95.216.1.1', server_endpoint: 'x.example.fi' });
    await set(12, { server_ip: '172.16.0.9', operator: 'Cloudflare', is_eu: true });   // private beats anycast
    await set(13, { operator: 'Cloudflare', is_eu: true, country_code: 'NL' });         // anycast beats is_eu
    await set(14, { is_eu: true, country_code: 'DE' });                                  // eu beats outside
    await set(22, { country_code: 'US' });
    await set(23, { server_ip: 'not-an-ip', country_code: 'US' });                       // a malformed value must not fail the batch
    await set(24, { server_endpoint: 'localhost' });

    const result = await schema.runLocationBackfill({ batch: 10, pauseMs: 0 });
    assert.deepStrictEqual(result, { located: 2, legacy: 23, ranges: 3 });
    const state = Object.fromEntries((await pg.query(`SELECT id, location_state FROM ${T}`)).rows.map((r) => [r.id, r.location_state]));
    assert.strictEqual(state[3], 'via_network', 'Cloudflare is re-located from its edge, not left in Canada');
    assert.strictEqual(state[4], 'eu');
    assert.strictEqual(state[12], 'local', 'local first');
    assert.strictEqual(state[13], 'via_network', 'anycast before is_eu');
    assert.strictEqual(state[14], 'eu', 'eu before outside');
    assert.strictEqual(state[22], 'outside');
    assert.strictEqual(state[23], 'outside');
    assert.strictEqual(state[24], 'local');
    assert.strictEqual(state[1], 'unknown');
    assert.strictEqual(Object.values(state).filter((s) => s === null).length, 0, 'every row has a state');

    assert.deepStrictEqual(await schema.runLocationBackfill({ batch: 10, pauseMs: 0 }), { located: 0, legacy: 0, ranges: 3 }, 'a second run finds nothing to do');
});

// ── the overview ─────────────────────────────────────────────────────────

/** `n` copies of a row. */
async function rowsOf(n, over) { for (let i = 0; i < n; i++) await put(over); }

test('overview: score over located calls only, via_network and unknown counted apart', async () => {
    await rowsOf(4, { location_state: 'local', is_local: true });
    await rowsOf(1, { location_state: 'via_network' });
    await rowsOf(5, { location_state: 'unknown' });
    const data = await store.getIntegrationOverview({}, 'day');
    // Over all 10 calls the old formula said far less for exactly this ledger.
    assert.strictEqual(data.summary.sovereignty_score, 100);
    assert.strictEqual(Number(data.summary.via_network_count), 1);
    assert.strictEqual(Number(data.summary.unknown_count), 5);
    assert.strictEqual(Number(data.summary.located_count), 4);
    assert.strictEqual(data.summary.coverage_pct, 40);
    assert.deepStrictEqual(data.map.attribution, { text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' });
    assert.deepStrictEqual(data.map.geo_db, { available: true, edition: 'dbip-city-lite', date: '2026-09' });
    assert.strictEqual(data.health.geo_db, true);
});

test('overview: calls per Shield outcome — a blocked call in neither, an unscanned one not "clean"', async () => {
    await rowsOf(2, { pii_scan_level: 'full' });                                   // clean
    await rowsOf(1, { pii_scan_level: 'none', pii_scan_enabled: true });           // legacy scanned: clean
    await rowsOf(3, { pii_scan_level: 'none' });                                   // unchecked
    await rowsOf(1, { pii_scan_level: 'full', status: 'blocked' });                // the shield's stop
    await rowsOf(1, { pii_scan_level: 'none', status: 'blocked' });
    await rowsOf(2, { pii_scan_level: 'full', pii_categories_detected: 'email' }); // a find left with it
    const { summary } = await store.getIntegrationOverview({}, 'day');
    assert.strictEqual(Number(summary.clean_count), 3);
    assert.strictEqual(Number(summary.unchecked_count), 3);
});

test('overview: nothing located → score null; outside with PII costs double', async () => {
    await rowsOf(5, { location_state: 'unknown' });
    assert.strictEqual((await store.getIntegrationOverview({})).summary.sovereignty_score, null);
    await pg.exec(`TRUNCATE ${T}`);
    await rowsOf(8, { location_state: 'eu', is_eu: true });
    await rowsOf(1, { location_state: 'outside' });
    await rowsOf(1, { location_state: 'outside', pii_categories_detected: 'email' });
    // 100 × (1 − (2 + 1) / (10 + 1)) = 72.7 → 73
    assert.strictEqual((await store.getIntegrationOverview({})).summary.sovereignty_score, 73);
    const { sovereigntyScore } = require('./integrationOverview');
    assert.strictEqual(sovereigntyScore(0, 0, 0), null);
});

test('overview: one location per host (its most frequent), ≤200 for the map, top 12 for the list, origin from the env', async () => {
    for (let i = 0; i < 15; i++) {
        const host = { organization_id: 'o1', dest_host: `h${i}.example`, location_state: 'eu', location_basis: 'socket', city: 'Helsinki', lat: 60.17, lon: 24.94, country_code: 'FI', server_ip: '95.216.1.1' };
        await rowsOf(20 - i, host);
    }
    // h0 is mostly behind Cloudflare, once seen elsewhere: its most frequent tuple wins.
    await pg.query(`UPDATE ${T} SET location_state = 'via_network', location_basis = 'edge_header', city = 'Amsterdam', lat = 52.31, lon = 4.76,
        country_code = 'NL', edge_pop = 'AMS', network = 'Cloudflare', operator = 'Cloudflare'
        WHERE id IN (SELECT id FROM ${T} WHERE dest_host = 'h0.example' ORDER BY id LIMIT 19)`);
    await put({ organization_id: 'o2', dest_host: 'other-org.example' });
    process.env.BEEFLOW_SERVER_LOCATION = 'NL';
    let data;
    try {
        data = await store.getIntegrationOverview({ organizationId: 'o1' });
    } finally {
        delete process.env.BEEFLOW_SERVER_LOCATION;
    }
    assert.strictEqual(data.map.destinations.length, 15, 'one entry per host, the other organisation left out');
    assert.strictEqual(data.top.destinations.length, 12);
    const d = data.top.destinations[0];
    for (const f of ['dest_host', 'operator', 'as_org', 'network', 'country_code', 'country_name', 'city', 'lat', 'lon',
        'location_state', 'location_basis', 'edge_pop', 'is_eu', 'is_local', 'total', 'pii_events', 'last_contact',
        'sample_peer_ip', 'country_flag']) {
        assert.ok(f in d, f);
    }
    assert.strictEqual(d.dest_host, 'h0.example');
    assert.strictEqual(d.total, 20);
    assert.strictEqual(d.location_state, 'via_network');
    assert.strictEqual(d.city, 'Amsterdam');
    assert.strictEqual(d.country_name, 'Netherlands');
    assert.strictEqual(d.is_eu, false, 'via_network is not "in Europe"');
    assert.strictEqual(data.top.destinations[1].is_eu, true);
    assert.deepStrictEqual(data.map.origin, { country_code: 'NL', country_name: 'Netherlands', lat: 52.37, lon: 4.9, label: 'Netherlands' });
});

test('overview: the category normaliser is injected by the caller', async () => {
    await rowsOf(2, { pii_categories_detected: 'Email Address', location_state: 'outside' });
    await rowsOf(3, { pii_categories_detected: 'email', location_state: 'eu', is_eu: true });
    const data = await store.getIntegrationOverview({}, 'day', { normalizeCategory: (c) => (String(c).toLowerCase().includes('email') ? 'email' : null) });
    assert.deepStrictEqual(data.pii_categories, [{ category: 'email', count: 5, non_eu_count: 2 }]);
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

