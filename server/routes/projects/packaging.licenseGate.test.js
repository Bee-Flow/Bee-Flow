/**
 * De licentiepoort van packaging.js mag alleen ZIJN EIGEN routes raken.
 *
 * `router.use(requireFeature('blueprint_packaging'))` — padloos — draaide voor
 * ELK verzoek dat dit router-object bereikte, ook een verzoek waarvan geen
 * enkele route in dit bestand matchte. En omdat `routes/projects.js` deze
 * router monteert met `router.use('/', require('./projects/packaging'))`
 * VÓÓR routes als `PUT /:id/conversations`, kwam zo'n verzoek daar ook echt
 * binnen: de poort weigerde het voordat Express de kans kreeg om door te
 * geven aan de route die er eigenlijk bij hoort. Een org met `projects` maar
 * zonder `blueprint_packaging` kreeg zo 403 op werk dat niets met Blueprints
 * te maken heeft.
 *
 * Dit bestand monteert de ECHTE `../projects`-router (niet een hand-gebouwde
 * analogie ervan) met hetzelfde mock-recept als projects.routetable.test.js
 * hiernaast, plus dezelfde licentie-/rolstubs als packaging.installs.test.js.
 * Zo pint de test niet alleen "packaging + een route erna" maar de echte
 * mount-volgorde in routes/projects.js zelf: een latere herordening daar, of
 * een nieuwe route tussen de mount en /:id/conversations, loopt automatisch
 * door dezelfde router mee. Er komt geen database aan te pas.
 *
 * Run: cd server && node --test routes/projects/packaging.licenseGate.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', '..');

function mock(rel, exports) {
    const p = require.resolve(rel);
    const m = { id: p, filename: p, loaded: true, exports };
    require.cache[p] = m;
}

// ── Same recipe as projects.routetable.test.js: everything routes/projects.js
// needs just to load and to answer PUT /:id/conversations with an empty body.
mock(path.join(SERVER, 'stores/userStore'), {});
mock(path.join(SERVER, 'stores/knowledgeBases'), {});
mock(path.join(SERVER, 'support/kbAccess'), { partitionAccessibleKBIds: async () => ({ allowed: [], denied: [] }) });
mock(path.join(SERVER, 'auth'), { resolveUserGroups: async () => [] });
mock(path.join(SERVER, 'utils/perUserRateLimit'), {
    perUserRateLimit: () => function rateLimiter(req, res, next) { next(); },
});

// ── Controleerbaar, en met hetzelfde contract als de echte requireFeature:
// weigeren eindigt het verzoek (403), toestaan roept next().
const licence = { allowed: true };
mock(path.join(SERVER, 'license/middleware'), {
    requireFeature: (feature) => (req, res, next) => (licence.allowed
        ? next()
        : res.status(403).json({ error: 'feature_locked', feature })),
    featureAllowedForRequest: async () => ({ allowed: licence.allowed }),
});

const gate = { role: 'owner' };
mock(path.join(SERVER, 'auth/projectAccess'), {
    requireProjectRole: (minRole) => function requireProjectRoleMw(req, res, next) {
        if (!req.session?.user?.id) return res.status(401).json({ error: 'Not authenticated' });
        if (!gate.role) return res.status(404).json({ error: 'Not found' });
        if (gate.role !== minRole) return res.status(403).json({ error: 'Insufficient permissions' });
        next();
    },
});

mock(path.join(SERVER, 'stores/projectStore'), { getProject: async () => ({ id: 'p1', organizationId: 'org1' }) });
mock(path.join(SERVER, 'stores/blueprintStore'), { listReleases: async () => [] });
mock(path.join(SERVER, 'projects/packaging/capture'), { captureSolution: async () => ({ ok: false, errors: ['n.v.t.'] }) });

// The real router — packaging mounted inside it exactly as routes/projects.js
// mounts it, PUT /:id/conversations exactly as it is defined there.
const router = require('../projects');

let server;
let base;
let session = { id: 'alice', organizationId: 'org1' };

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = session ? { user: session } : {}; next(); });
    app.use('/api/projects', router);
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { if (server) server.close(); });

function request(method, urlPath, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request(`${base}${urlPath}`, {
            method,
            headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
        }, (r) => {
            let respBody = '';
            r.on('data', (c) => { respBody += c; });
            r.on('end', () => {
                let json = null;
                try { json = JSON.parse(respBody); } catch { /* niet-JSON is zelf het antwoord */ }
                resolve({ status: r.statusCode, json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

test.beforeEach(() => { licence.allowed = true; gate.role = 'owner'; });

test('zonder blueprint_packaging bereikt PUT /:id/conversations zijn eigen handler nog steeds', async () => {
    licence.allowed = false;
    gate.role = 'editor'; // PUT /:id/conversations is editor+, niet owner
    const res = await request('PUT', '/api/projects/p1/conversations', {});
    assert.strictEqual(res.status, 200, `PUT /:id/conversations -> ${JSON.stringify(res.json)}`);
    assert.deepStrictEqual(res.json, { success: true, assigned: 0, unassigned: 0 });
});

test('mét blueprint_packaging bereikte die route hem toch al — de poort test alleen het ONTBREKEN ervan', async () => {
    licence.allowed = true;
    gate.role = 'editor';
    const res = await request('PUT', '/api/projects/p1/conversations', {});
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { success: true, assigned: 0, unassigned: 0 });
});

test('packaging weigert zijn eigen routes nog steeds zonder de licentie', async () => {
    licence.allowed = false;
    const res = await request('POST', '/api/projects/p1/package/export');
    assert.strictEqual(res.status, 403, JSON.stringify(res.json));
    assert.strictEqual(res.json.feature, 'blueprint_packaging');
});

test('packaging laat zijn eigen routes nog steeds door mét de licentie (op de rolgate na)', async () => {
    licence.allowed = true;
    gate.role = 'editor'; // eigenaar-gate, niet de licentie — bewijst dat de licentiepoort passeerde
    const res = await request('POST', '/api/projects/p1/package/export');
    assert.strictEqual(res.status, 403, JSON.stringify(res.json));
    assert.strictEqual(res.json.error, 'Insufficient permissions');
});
