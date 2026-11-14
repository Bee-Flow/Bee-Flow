// @typecheck
'use strict';

/**
 * Scaleway connector — what one sweep reads and what it reports: the zones it
 * probes (a 404 zone is skipped, a 403 fails the sweep), the snapshot freshness
 * per server, the admin ports open to the world, the Kubernetes count that
 * degrades to null without read access, and the three-page cap.
 *
 * The API is a path → answer table behind a fake safeFetch, so the requests
 * the connector makes are part of what the tests see.
 *
 * Run: cd server && node --test compliance/connectors/scaleway.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const connector = require('./scaleway');

const DAY = 86400000;
/** An ISO date `days` days and one hour ago (the hour keeps the floor stable). */
const ago = (/** @type {number} */ days) => new Date(Date.now() - days * DAY - 3600000).toISOString();

/**
 * A fake Scaleway API. `routes` maps a path without its query to an answer:
 * `{ status, body }`, or an array of bodies (one per page).
 * @param {Record<string, any>} routes
 */
function api(routes) {
    /** @type {string[]} */
    const calls = [];
    /** @param {string} url */
    const safeFetch = async (url) => {
        calls.push(url.replace('https://api.scaleway.com', ''));
        const u = new URL(url);
        const answer = routes[u.pathname];
        if (answer === undefined) return { ok: false, status: 404, json: async () => ({}) };
        let status = 200;
        let body = answer;
        if (Array.isArray(answer)) body = answer[Number(u.searchParams.get('page') || 1) - 1] || {};
        else if (answer && typeof answer.status === 'number') ({ status, body } = answer);
        return { ok: status >= 200 && status < 300, status, json: async () => body };
    };
    return { safeFetch: /** @type {any} */ (safeFetch), calls };
}

const Z1 = '/instance/v1/zones/nl-ams-1';
const Z3 = '/instance/v1/zones/nl-ams-3';

/** Zone 1 and 3 exist, zone 2 does not; two servers, one without backups. */
function richWorld() {
    return {
        [`${Z1}/servers`]: { servers: [
            { id: 's1', name: 'web', state: 'running', volumes: { 0: { id: 'v1' }, 1: { id: 'v2' } } },
            { id: 's2', state: 'stopped', volumes: { 0: { id: 'v3' } } },
            { name: 'no id' },
            null,
        ] },
        [`${Z1}/snapshots`]: { snapshots: [
            { base_volume: { id: 'v1' }, creation_date: ago(3) },
            { base_volume: { id: 'v1' }, creation_date: ago(9) },
            { base_volume: { id: 'v2' }, creation_date: ago(5) },
            { base_volume: { id: 'v9' }, creation_date: ago(1) },
            { creation_date: ago(2) },
            { base_volume: { id: 'v3' }, creation_date: 'not a date' },
        ] },
        [`${Z1}/security_groups`]: { security_groups: [
            { id: 'g1', name: 'open', inbound_default_policy: 'ACCEPT' },
            { id: 'g2', inbound_default_policy: 'drop' },
            { name: 'no id' },
        ] },
        [`${Z1}/security_groups/g1/rules`]: { rules: [
            { direction: 'inbound', action: 'accept', protocol: 'TCP', ip_range: '0.0.0.0/0', dest_port_from: 22 },
            { direction: 'INBOUND', action: 'ACCEPT', protocol: 'tcp', ip_range: '::/0', dest_port_from: 3000, dest_port_to: 6000 },
            { direction: 'inbound', action: 'accept', ip_range: '', dest_port_from: null },
            { direction: 'inbound', action: 'accept', protocol: 'UDP', ip_range: '0.0.0.0/0', dest_port_from: 22 },
            { direction: 'outbound', action: 'accept', protocol: 'TCP', ip_range: '0.0.0.0/0', dest_port_from: 22 },
            { direction: 'inbound', action: 'drop', protocol: 'TCP', ip_range: '0.0.0.0/0', dest_port_from: 22 },
            { direction: 'inbound', action: 'accept', protocol: 'TCP', ip_range: '10.0.0.0/8', dest_port_from: 22 },
            { direction: 'inbound', action: 'accept', protocol: 'TCP', ip_range: '0.0.0.0', dest_port_from: 80, dest_port_to: 443 },
        ] },
        [`${Z1}/security_groups/g2/rules`]: { status: 403, body: null },
        [`${Z3}/servers`]: { servers: [{ id: 's3', name: 'db', state: 'running' }] },
        [`${Z3}/snapshots`]: { snapshots: [] },
        [`${Z3}/security_groups`]: { security_groups: [{ id: 'g3', name: 'x' }] },
        [`${Z3}/security_groups/g3/rules`]: { rules: 'not a list' },
        '/k8s/v1/regions/nl-ams/clusters': { total_count: 7, clusters: [
            { id: 'k1', name: 'prod', status: 'ready', version: '1.30' },
            { name: 'no id' },
            { id: 'k2' },
        ] },
    };
}

test('a full sweep: rows per server and cluster, then the summary', async () => {
    const { safeFetch, calls } = api(richWorld());
    const rows = await connector.collect({ secret: { token: 't' }, settings: {}, safeFetch });
    assert.deepEqual(rows, [
        { subject_id: 's1', payload: { type: 'server', zone: 'nl-ams-1', name: 'web', state: 'running', snapshot_count: 3, newest_backup_age_days: 3 } },
        { subject_id: 's2', payload: { type: 'server', zone: 'nl-ams-1', name: null, state: 'stopped', snapshot_count: 1, newest_backup_age_days: null } },
        { subject_id: 's3', payload: { type: 'server', zone: 'nl-ams-3', name: 'db', state: 'running', snapshot_count: 0, newest_backup_age_days: null } },
        { subject_id: 'k1', payload: { type: 'k8s_cluster', region: 'nl-ams', name: 'prod', status: 'ready', version: '1.30' } },
        { subject_id: 'k2', payload: { type: 'k8s_cluster', region: 'nl-ams', name: null, status: null, version: null } },
        { subject_id: 'summary', payload: {
            region: 'nl-ams',
            eu_region: true,
            zones_probed: ['nl-ams-1', 'nl-ams-3'],
            servers: 3,
            clusters: 7,
            snapshots: 6,
            unassigned_snapshots: 2,
            servers_with_backup: 1,
            newest_backup_age_days: 3,
            security_groups: 3,
            inbound_default_accept_groups: 1,
            open_admin_ports: 7,
            open_admin_port_samples: [
                { security_group_id: 'g1', zone: 'nl-ams-1', port: 22, ip_range: '0.0.0.0/0' },
                { security_group_id: 'g1', zone: 'nl-ams-1', port: 5432, ip_range: '::/0' },
                { security_group_id: 'g1', zone: 'nl-ams-1', port: 3306, ip_range: '::/0' },
                { security_group_id: 'g1', zone: 'nl-ams-1', port: 22, ip_range: '0.0.0.0/0' },
                { security_group_id: 'g1', zone: 'nl-ams-1', port: 5432, ip_range: '0.0.0.0/0' },
                { security_group_id: 'g1', zone: 'nl-ams-1', port: 6379, ip_range: '0.0.0.0/0' },
                { security_group_id: 'g1', zone: 'nl-ams-1', port: 3306, ip_range: '0.0.0.0/0' },
            ],
            truncated: false,
        } },
    ]);
    assert.deepEqual(calls, [
        `${Z1}/servers?page=1&per_page=100`,
        `${Z1}/snapshots?page=1&per_page=100`,
        `${Z1}/security_groups?page=1&per_page=100`,
        `${Z1}/security_groups/g1/rules?per_page=100`,
        `${Z1}/security_groups/g2/rules?per_page=100`,
        '/instance/v1/zones/nl-ams-2/servers?page=1&per_page=100',
        `${Z3}/servers?page=1&per_page=100`,
        `${Z3}/snapshots?page=1&per_page=100`,
        `${Z3}/security_groups?page=1&per_page=100`,
        `${Z3}/security_groups/g3/rules?per_page=100`,
        '/k8s/v1/regions/nl-ams/clusters?page_size=100',
    ]);
});

test('the worst per-server freshness is the summary age; the project id scopes every listing', async () => {
    const { safeFetch, calls } = api({
        [`${Z1}/servers`]: { servers: [
            { id: 'a', volumes: { 0: { id: 'va' } } },
            { id: 'b', volumes: { 0: { id: 'vb' } } },
        ] },
        [`${Z1}/snapshots`]: { snapshots: [
            { base_volume: { id: 'va' }, creation_date: ago(2) },
            { base_volume: { id: 'vb' }, creation_date: ago(12) },
            { base_volume: { id: 'vb' }, creation_date: ago(20) },
        ] },
        [`${Z1}/security_groups`]: { security_groups: [] },
        '/k8s/v1/regions/fr-par/clusters': { clusters: [{ id: 'k' }] },
    });
    const rows = await connector.collect({ secret: { apiKey: 't' }, settings: { region: ' FR-PAR ', project_id: ' p 1 ' }, safeFetch });
    // fr-par zones are not in the table: only nl-ams-1 paths answer, so fr-par
    // has no zones and the k8s count falls back to the row count.
    const summary = rows.at(-1)?.payload;
    assert.equal(summary.region, 'fr-par');
    assert.equal(summary.eu_region, true);
    assert.deepEqual(summary.zones_probed, []);
    assert.equal(summary.clusters, 1);
    assert.ok(calls.includes('/instance/v1/zones/fr-par-1/servers?project=p%201&page=1&per_page=100'));
    assert.equal(calls.at(-1), '/k8s/v1/regions/fr-par/clusters?page_size=100&project_id=p%201');

    const world = api({
        [`${Z1}/servers`]: { servers: [{ id: 'a', volumes: { 0: { id: 'va' } } }, { id: 'b', volumes: { 0: { id: 'vb' } } }] },
        [`${Z1}/snapshots`]: { snapshots: [
            { base_volume: { id: 'va' }, creation_date: ago(2) },
            { base_volume: { id: 'vb' }, creation_date: ago(20) },
            { base_volume: { id: 'vb' }, creation_date: ago(12) },
        ] },
        [`${Z1}/security_groups`]: {},
    });
    const out = await connector.collect({ secret: { api_key: 't' }, settings: { region: 'nl-ams' }, safeFetch: world.safeFetch });
    assert.deepEqual(out.map(r => r.payload.newest_backup_age_days), [2, 12, 12]);
    assert.equal(out.at(-1)?.payload.servers_with_backup, 2);
    assert.equal(out.at(-1)?.payload.clusters, null);
    assert.equal(out.at(-1)?.payload.eu_region, true);
});

test('three full pages are read and the summary says truncated; a short page ends the listing', async () => {
    const page = (/** @type {number} */ p) => ({ servers: Array.from({ length: 100 }, (_, i) => ({ id: `s${p}-${i}` })) });
    const { safeFetch, calls } = api({
        [`${Z1}/servers`]: [page(1), page(2), page(3), page(4)],
        [`${Z1}/snapshots`]: [{ snapshots: [] }],
        [`${Z1}/security_groups`]: [{ security_groups: [] }],
    });
    const rows = await connector.collect({ secret: { token: 't' }, settings: {}, safeFetch });
    const summary = rows.at(-1)?.payload;
    assert.equal(summary.servers, 300);
    assert.equal(summary.truncated, true);
    assert.equal(calls.filter(c => c.startsWith(`${Z1}/servers`)).length, 3);
    assert.equal(calls.filter(c => c.startsWith(`${Z1}/snapshots`)).length, 1);
});

test('a truncated snapshot or group listing also marks the summary truncated', async () => {
    for (const key of ['snapshots', 'security_groups']) {
        const full = { [key]: Array.from({ length: 100 }, () => ({})) };
        const { safeFetch } = api({
            [`${Z1}/servers`]: { servers: [] },
            [`${Z1}/snapshots`]: key === 'snapshots' ? [full, full, full] : { snapshots: [] },
            [`${Z1}/security_groups`]: key === 'security_groups' ? [full, full, full] : { security_groups: [] },
        });
        const rows = await connector.collect({ secret: { token: 't' }, settings: {}, safeFetch });
        assert.equal(rows.at(-1)?.payload.truncated, true, key);
    }
});

test('more than ten open admin ports: all are counted, ten are sampled', async () => {
    const groups = Array.from({ length: 4 }, (_, i) => ({ id: `g${i}` }));
    /** @type {Record<string, any>} */
    const routes = {
        [`${Z1}/servers`]: { servers: [] },
        [`${Z1}/snapshots`]: { snapshots: [] },
        [`${Z1}/security_groups`]: { security_groups: groups },
    };
    for (const g of groups) routes[`${Z1}/security_groups/${g.id}/rules`] = { rules: [{ direction: 'inbound', action: 'accept' }] };
    const { safeFetch } = api(routes);
    const summary = (await connector.collect({ secret: { token: 't' }, settings: {}, safeFetch })).at(-1)?.payload;
    assert.equal(summary.open_admin_ports, 16);
    assert.equal(summary.open_admin_port_samples.length, 10);
    assert.deepEqual(summary.open_admin_port_samples[9], { security_group_id: 'g2', zone: 'nl-ams-1', port: 5432, ip_range: '0.0.0.0/0' });
    assert.equal(summary.inbound_default_accept_groups, 0);
});

test('a non-EU region is reported as such', async () => {
    const { safeFetch } = api({});
    const summary = (await connector.collect({ secret: { token: 't' }, settings: { region: 'us-abc' }, safeFetch })).at(-1)?.payload;
    assert.equal(summary.eu_region, false);
    assert.equal(summary.servers, 0);
});

test('missing secret and a malformed region are refused before any request', async () => {
    const { safeFetch, calls } = api({});
    await assert.rejects(connector.collect({ secret: {}, settings: {}, safeFetch }), /no API secret key/);
    await assert.rejects(connector.collect({ secret: null, settings: {}, safeFetch }), /no API secret key/);
    await assert.rejects(connector.collect({ secret: { token: 't' }, settings: { region: 'amsterdam' }, safeFetch }), /Invalid Scaleway region "amsterdam"/);
    assert.deepEqual(calls, []);
});

test('denied listings fail the sweep with the listing named; a bad key and a server error too', async () => {
    const base = () => ({ [`${Z1}/servers`]: { servers: [] }, [`${Z1}/snapshots`]: { snapshots: [] }, [`${Z1}/security_groups`]: { security_groups: [] } });
    /** @type {[string, any, RegExp][]} */
    const cases = [
        [`${Z1}/servers`, { status: 403, body: null }, /servers list denied \(403\) in nl-ams-1 — the key needs InstancesReadOnly/],
        [`${Z1}/snapshots`, { status: 403, body: null }, /snapshots list denied \(403\) in nl-ams-1$/],
        [`${Z1}/snapshots`, { status: 404, body: null }, /snapshots list denied \(404\) in nl-ams-1$/],
        [`${Z1}/security_groups`, { status: 404, body: null }, /security groups list denied \(404\) in nl-ams-1$/],
        [`${Z1}/servers`, { status: 401, body: null }, /API key invalid or expired/],
        [`${Z1}/snapshots`, { status: 500, body: null }, /^Error: Scaleway API error 500 on \/instance\/v1\/zones\/nl-ams-1\/snapshots$/],
    ];
    for (const [path, answer, message] of cases) {
        const { safeFetch } = api({ ...base(), [path]: answer });
        await assert.rejects(connector.collect({ secret: { token: 't' }, settings: {}, safeFetch }), (/** @type {Error} */ err) => {
            assert.match(String(err), message);
            return true;
        }, path);
    }
    // A server error on the Kubernetes listing is not degraded to null.
    const { safeFetch } = api({ ...base(), '/k8s/v1/regions/nl-ams/clusters': { status: 502, body: null } });
    await assert.rejects(connector.collect({ secret: { token: 't' }, settings: {}, safeFetch }), /API error 502 on \/k8s\/v1\/regions\/nl-ams\/clusters$/);
});
