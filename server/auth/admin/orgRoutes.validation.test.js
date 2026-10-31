/**
 * What POST /organizations accepts, and what it says when it refuses
 * (auth/admin/orgRoutes.js).
 *
 * The UPDATE route beside it has refused unknown keys since a pentest sent
 * {"isAdmin":true} and got a 200; CREATE is the same handler shape and never
 * grew the guard, so the identical body created an organisation and answered
 * 200 with the field silently dropped. And `allowSignup` was stored as
 * `!!allowSignup`, so the string "false" — what an HTML form sends — opened the
 * organisation to self-service signup while the caller had asked for the
 * opposite. What this file pins:
 *
 *   - the 400 NAMES the field (`body.name`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused create makes no organisation.
 *
 * Run: cd server && node --test --test-force-exit auth/admin/orgRoutes.validation.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store and side-effect call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
const pass = (req, res, next) => next();
/** The logo the stubbed organisation carries (the logo-delete test sets it). */
let orgLogo;

const MOCKS = {
    '../permissions': {
        requireAuth: pass, requireSuperAdmin: pass, requireAdmin: pass,
        requirePermission: () => pass, resolveUserOrgIds: async () => new Set(['orgA']),
        invalidatePermissionCache: async () => {}, isOrgAdminRole: () => true,
    },
    './orgAdminGuards': { requireOrgAdmin: () => pass, isOrgAdminForOrg: async () => true, wouldOrphanOrg: async () => false },
    '../../stores/userStore': {
        getAllOrganizations: async () => [],
        getOrganization: async (id) => ({ id, name: 'Acme', logo: orgLogo }),
        createOrganization: async (org) => { touched.push({ what: 'createOrganization', args: [org] }); return true; },
        updateOrganization: async (id, u) => { touched.push({ what: 'updateOrganization', args: [id, u] }); return true; },
        logAccessAudit: async () => {},
    },
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => {} },
    '../accountProvisioning': { slugifyOrgId: (n) => String(n).toLowerCase().replace(/\s+/g, '-') },
    '../../utils/htmlSanitizer': { sanitizePlainTextFields: (o) => o },
    '../../utils/freeEmailDomains': { isFreeEmailDomain: () => false, getEffectiveFreeEmailDomains: async () => new Set() },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:org-routes-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /admin[\\/]orgRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./orgRoutes');
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../testUtils/routeHarness');

const dispatch = dispatcher(router, { session: () => ({ user: { id: 'root' }, isAdmin: true }) });

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

test('an organisation with no name is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/organizations', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Organization name required');
    assert.ok(res.body.details.some((d) => d.path === 'body.name'));
    assert.deepStrictEqual(touched, []);
});

test('{"isAdmin":true} is refused here too, not answered 200 and dropped', async () => {
    await refuses({ method: 'POST', url: '/organizations', body: { name: 'Acme', isAdmin: true } }, 'body');
});

test('allowSignup: "false" is refused instead of opening the organisation', async () => {
    // `!!"false"` is true — the string an HTML form sends used to do the
    // opposite of what the caller asked for.
    await refuses({ method: 'POST', url: '/organizations', body: { name: 'Acme', allowSignup: 'false' } }, 'body.allowSignup');
});

test('a real boolean still decides, and reaches the store as one', async () => {
    const res = await dispatch({ method: 'POST', url: '/organizations', body: { name: 'Acme', allowSignup: false } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'createOrganization').args[0].allowSignup, false);
});

test('DELETE /organizations/:id/logo removes the file and clears the field', async () => {
    // It used to call `.find` on the promise getAllOrganizations() returns,
    // so every call threw: the file stayed on disk and the field stayed set.
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'data', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const name = `org-logo-test-${process.pid}-${Date.now()}.png`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'png');
    orgLogo = `/uploads/${name}`;
    try {
        const res = await dispatch({ method: 'DELETE', url: '/organizations/orgA/logo' });
        assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
        assert.strictEqual(fs.existsSync(file), false, 'the logo file is deleted');
        assert.deepStrictEqual(touched.find((t) => t.what === 'updateOrganization').args, ['orgA', { logo: '' }]);
    } finally {
        orgLogo = undefined;
        fs.rmSync(file, { force: true });
    }
});

// ── The logo upload, through a real multipart request ───────────────
// An SVG is stored sanitised (middleware/uploadedImage.js runs it through
// uploadGuard), under the type's extension, with the response shape the Hub
// reads: { success, logo }.

test('POST /organizations/:id/logo stores an SVG without its script element', async () => {
    const http = require('node:http');
    const fs = require('node:fs');
    const path = require('node:path');
    const express = require('express');
    const app = express();
    app.use('/auth', router);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>alert(1)</script><rect width="8" height="8"/></svg>';
    let storedFile = null;
    try {
        const form = new FormData();
        form.append('logo', new Blob([svg], { type: 'image/svg+xml' }), 'logo.html');
        const res = await fetch(`http://127.0.0.1:${server.address().port}/auth/organizations/orgA/logo`, { method: 'POST', body: form });
        const body = await res.json();
        assert.strictEqual(res.status, 200, JSON.stringify(body));
        assert.match(body.logo, /^\/uploads\/org-logo-orgA-\d+\.svg$/);
        assert.deepStrictEqual(body, { success: true, logo: body.logo });
        storedFile = path.join(__dirname, '..', '..', 'data', 'uploads', path.basename(body.logo));
        assert.ok(!fs.readFileSync(storedFile, 'utf8').toLowerCase().includes('<script'));
        assert.ok(fs.readFileSync(storedFile, 'utf8').toLowerCase().includes('<svg'));
        assert.deepStrictEqual(touched.find((t) => t.what === 'updateOrganization').args, ['orgA', { logo: body.logo }]);
    } finally {
        if (storedFile) fs.rmSync(storedFile, { force: true });
        await new Promise((resolve) => server.close(resolve));
    }
});
