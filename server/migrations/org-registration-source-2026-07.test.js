/**
 * Unit tests for the org registration-source backfill (BFSF-286) — the
 * connector-fingerprint heuristic (auto-provisioned description OR nc- id
 * prefix + bound instance) followed by the 'direct' catch-all, idempotency,
 * and — crucially — the misclassification guard: a direct-signup org that was
 * LATER paired to a Nextcloud (authMethod rewritten to 'nextcloud_connector',
 * nc_instance_id set) must still backfill as 'direct'. The pg layer is mocked
 * via require.cache (mirrors default-org-plan-2026-06.test.js), so no DB.
 *
 * Run: node --test server/migrations/org-registration-source-2026-07.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// ── In-memory fake of server/db.js ───────────────────────────────────────
const state = { orgs: [], writes: [] };
const reset = () => { state.orgs = []; state.writes = []; };
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();

const fakeDb = {
    async run(sql) {
        const q = norm(sql);
        state.writes.push(q);
        if (q.startsWith('ALTER TABLE organizations')) {
            return { rowCount: 0 };
        }
        if (q.includes("SET \"registration_source\" = 'nextcloud_connector'")) {
            let n = 0;
            for (const o of state.orgs) {
                const isNull = o.registration_source == null;
                const byDescription = typeof o.description === 'string'
                    && o.description.startsWith('Auto-provisioned from Nextcloud');
                const byIdAndBinding = typeof o.id === 'string'
                    && o.id.startsWith('nc-') && o.nc_instance_id != null;
                if (isNull && (byDescription || byIdAndBinding)) {
                    o.registration_source = 'nextcloud_connector';
                    n++;
                }
            }
            return { rowCount: n };
        }
        if (q.includes("SET \"registration_source\" = 'direct'")) {
            let n = 0;
            for (const o of state.orgs) {
                if (o.registration_source == null) {
                    o.registration_source = 'direct';
                    n++;
                }
            }
            return { rowCount: n };
        }
        throw new Error('unexpected run: ' + q);
    },
};

const dbPath = path.join(__dirname, '..', 'db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const { up } = require('./org-registration-source-2026-07');

const byId = (id) => state.orgs.find(o => o.id === id);

test.beforeEach(reset);

test('fresh-connector org (auto-provisioned description) → nextcloud_connector', async () => {
    state.orgs.push({
        id: 'nc-mycloud-abc123',
        description: 'Auto-provisioned from Nextcloud (https://nc.example.com)',
        authMethod: 'nextcloud_connector',
        nc_instance_id: 'inst-1',
        registration_source: null,
    });
    const res = await up();
    assert.equal(byId('nc-mycloud-abc123').registration_source, 'nextcloud_connector');
    assert.deepEqual(res, { nc: 1, direct: 0 });
});

test('nc- id prefix + bound instance catches an admin-edited description', async () => {
    state.orgs.push({
        id: 'nc-firma-9f2c1b',
        description: 'Our company workspace', // admin rewrote the fingerprint
        authMethod: 'nextcloud_connector',
        nc_instance_id: 'inst-2',
        registration_source: null,
    });
    await up();
    assert.equal(byId('nc-firma-9f2c1b').registration_source, 'nextcloud_connector');
});

test('misclassification guard: direct org paired LATER stays direct', async () => {
    // Pairing rewrote authMethod and set nc_instance_id, but the org was a
    // normal signup: no fingerprint description, no nc- id prefix.
    state.orgs.push({
        id: 'acme',
        description: 'Acme B.V.',
        authMethod: 'nextcloud_connector',
        nc_instance_id: 'inst-3',
        registration_source: null,
    });
    const res = await up();
    assert.equal(byId('acme').registration_source, 'direct');
    assert.deepEqual(res, { nc: 0, direct: 1 });
});

test('unbound ex-connector-era org without fingerprints → direct catch-all', async () => {
    state.orgs.push({
        id: 'legacy-co',
        description: '',
        authMethod: null,
        nc_instance_id: null,
        registration_source: null,
    });
    await up();
    assert.equal(byId('legacy-co').registration_source, 'direct');
});

test('rows that already carry a source are never touched', async () => {
    state.orgs.push({
        id: 'nc-set-already',
        description: 'Auto-provisioned from Nextcloud (https://x)',
        nc_instance_id: 'inst-4',
        registration_source: 'admin', // deliberately "wrong" — must survive
    });
    const res = await up();
    assert.equal(byId('nc-set-already').registration_source, 'admin');
    assert.deepEqual(res, { nc: 0, direct: 0 });
});

test('re-run is a no-op', async () => {
    state.orgs.push(
        { id: 'nc-a-1', description: 'Auto-provisioned from Nextcloud (https://a)', nc_instance_id: 'i1', registration_source: null },
        { id: 'plain', description: 'Plain org', nc_instance_id: null, registration_source: null },
    );
    const first = await up();
    assert.deepEqual(first, { nc: 1, direct: 1 });
    const second = await up();
    assert.deepEqual(second, { nc: 0, direct: 0 });
    assert.equal(byId('nc-a-1').registration_source, 'nextcloud_connector');
    assert.equal(byId('plain').registration_source, 'direct');
});
