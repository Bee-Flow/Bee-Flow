// @typecheck
/**
 * The world a journey runs in: the REAL server, in this process, minus the
 * listening port of index.js and its background timers.
 *
 *   - Postgres: one PGlite holding the schema the real boot ladder leaves
 *     behind (testUtils/pgliteTemplate.js ladderPglite), behind the real db.js
 *     (testUtils/pglitePool.js). Every store runs its own SQL.
 *   - HTTP: an express app built from the same boot pieces index.js uses
 *     (boot/httpMiddleware body parsers, boot/session's cookie session over the
 *     PostgreSQL session store, the session bridge), the real routers mounted
 *     behind the SAME middleware chain index.js gives them (MOUNTS below names
 *     the index.js line each one copies), then the terminal error handler.
 *   - Sessions: nobody is handed a session. An actor signs in through the real
 *     POST /auth/admin-login and carries the session cookie it got back, the way
 *     a browser does.
 *   - The model: the provider adapters are the real singletons of
 *     core/providers; only their network methods are swapped (stubModel) for
 *     a scripted answer. Everything around the call (model resolution, the
 *     agent turn, pricing, the usage row) is the product's. The KB embedder is
 *     a deterministic stub behind the pipeline's own wire() seam (stubEmbedder),
 *     the price list is testUtils/pricingFeed.js (PRICES), and licences are
 *     RS256 JWTs signed with license/licenseJwt.testkit.js's key, which the
 *     world trusts (activateLicence).
 *   - The network: every TCP connection to anything but the world's own port
 *     (another host, or a model runtime or sidecar on this machine) is refused
 *     at once (net.Socket#connect), recorded in `world.outbound`, and fails the
 *     journey in close(). A helper that would wait for a time-out gets its
 *     refusal in the same tick instead. Environment variables that would point
 *     the product at a sidecar, a provider or Redis are cleared on load.
 *
 * Why a mount table and not index.js itself: requiring index.js binds a port and
 * starts module-scope timers (auth/routeWalk.cli.js explains both), so a
 * `node --test` process that required it would never end. The table mounts the
 * router modules index.js mounts, behind the gates index.js puts in front of
 * them; a journey lists the mounts it needs (`openWorld({ mounts: [...] })`).
 *
 * Determinism: no sleeps, no clocks read by the journey itself, no network.
 * A journey that needs time to pass moves the stored timestamps (as
 * routes/automation/formPublic/formJourney.e2e.test.js does).
 *
 * Not a test file: required by the *.journey.test.js files next to it.
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.OTEL_ENABLED = 'false';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'journey-session-secret-0123456789abcdef0123456789';
process.env.MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || 'journey-master-key-0123456789abcdef0123456789abcd';
// The journeys talk plain http to 127.0.0.1: a Secure cookie would never come back.
process.env.COOKIE_SECURE = 'false';
// What a developer's shell may carry and the product would act on: a sidecar,
// a self-hosted model, a hosted provider key, Redis. The world has none of them.
for (const name of ['REDIS_URL', 'SEARCH_SERVICE_URL', 'GUARD_SERVICE_URL', 'CLASSIFY_SERVICE_URL', 'LOCAL_LLM_URL', 'OLLAMA_URL',
    'VLLM_URL', 'LLAMACPP_URL', 'LMSTUDIO_URL', 'SCALEWAY_API_KEY', 'EUGPT_API_KEY', 'IONOS_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'PASSWORD_BREACH_CHECK', 'LICENSE_JWKS_URL', 'LICENSE_PUBLIC_KEY', 'LICENSE_PUBLIC_KEY_FILE', 'STRIPE_SECRET_KEY', 'SMTP_HOST']) {
    delete process.env[name];
}

const http = require('node:http');
const net = require('node:net');
const express = require('express');

// ── The network guard, before anything opens a socket ───────────────────────

/** @type {Array<{ host: string, port: unknown }>} */
const outbound = [];
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
/**
 * The ports of this machine a journey may reach: its own server's only. A
 * model runtime or sidecar listening on the developer's machine is as far
 * away as any host on the internet.
 * @type {Set<number>}
 */
const ownPorts = new Set();
const realConnect = net.Socket.prototype.connect;
/** @param {unknown[]} args */
function connectTarget(args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (first && typeof first === 'object') {
        const o = /** @type {{ host?: string, port?: unknown, path?: string }} */ (first);
        return { host: o.path ? null : (o.host || 'localhost'), port: o.port };
    }
    if (typeof first === 'string' && !/^\d+$/.test(first)) return { host: null, port: null }; // a unix socket path
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
}
net.Socket.prototype.connect = /** @type {typeof realConnect} */ (function guardedConnect(/** @type {unknown[]} */ ...args) {
    const { host, port } = connectTarget(args);
    if (host === null || (LOOPBACK.has(host) && ownPorts.has(Number(port)))) return realConnect.apply(this, /** @type {Parameters<typeof realConnect>} */ (args));
    outbound.push({ host, port });
    const err = Object.assign(new Error(`journey: no network (${host}:${port})`), { code: 'ECONNREFUSED' });
    process.nextTick(() => this.destroy(err));
    return this;
});

// ── The database ────────────────────────────────────────────────────────────

const { ladderPglite } = require('../testUtils/pgliteTemplate');
const { usePglitePool } = require('../testUtils/pglitePool');
const { makeSwaps } = require('../testUtils/swaps');
const { loadPricing } = require('../testUtils/pricingFeed');
const { stubModel, stubEmbedder, parseSse, STUB_MODEL, PRICES } = require('./stubs.testkit');


/** @typedef {import('express').RequestHandler} Handler */

/**
 * The mounts a journey can ask for: each is the path and the middleware chain
 * of one `app.use(...)` line of server/index.js (named in the comment), built
 * lazily so a journey loads only the routers it uses.
 *
 * @type {Record<string, () => Array<[string, ...Handler[]]>>}
 */
const MOUNTS = {
    // index.js: app.use('/auth', authRouter)
    auth: () => [['/auth', require('../auth/router')]],
    // index.js: app.use('/agents/memory', memoryRouter); app.use('/agents', requireTraining('agents'), agentsRouter)
    agents: () => {
        const { requireTraining } = require('../learning/requireTraining');
        return [
            ['/agents/memory', require('../routes/memory')],
            ['/agents', requireTraining('agents'), require('../routes/agents').router],
        ];
    },
    // index.js: app.use('/api/usage', _advUsagePrefixGate, require('./routes/usage'))
    usage: () => [['/api/usage', require('../routes/usage')]],
    // index.js: app.use('/api/kb', requireTraining('knowledge'), require('./routes/knowledgeBases'))
    kb: () => {
        const { requireTraining } = require('../learning/requireTraining');
        return [['/api/kb', requireTraining('knowledge'), require('../routes/knowledgeBases')]];
    },
    // index.js: app.use('/api/automation', requireModule('automation'), requireLicenseFeature('automations'), requireTraining('automations'), require('./routes/automation'))
    automation: () => {
        const { requireModule } = require('../modules');
        const { requireFeature } = require('../license/middleware');
        const { requireTraining } = require('../learning/requireTraining');
        return [['/api/automation', requireModule('automation'), requireFeature('automations'), requireTraining('automations'), require('../routes/automation')]];
    },
    // index.js: app.use('/api/datatables', requireModule('automation'), requireAuthedUser, requireLicenseFeature('automations'), requireTraining('datatables'), require('./routes/datatables'))
    datatables: () => {
        const { requireModule } = require('../modules');
        const { requireAuth } = require('../auth');
        const { requireFeature } = require('../license/middleware');
        const { requireTraining } = require('../learning/requireTraining');
        return [['/api/datatables', requireModule('automation'), requireAuth, requireFeature('automations'), requireTraining('datatables'), require('../routes/datatables')]];
    },
    // index.js: the five app.use('/api/studio-apps', requireModule('apps'), requireCapability('app_studio'), ...) lines
    studioApps: () => {
        const { requireModule } = require('../modules');
        const { requireCapability } = require('../core/entitlements/entitlements');
        const { requireTraining } = require('../learning/requireTraining');
        const gate = () => [requireModule('apps'), requireCapability('app_studio')];
        return [
            ['/api/studio-apps', ...gate(), require('../routes/studioAppUsage')],
            ['/api/studio-apps', ...gate(), requireTraining('apps'), require('../routes/studioApps')],
            ['/api/studio-apps', ...gate(), require('../routes/studioAppsRun')],
            ['/api/studio-apps', ...gate(), require('../routes/studioAppData')],
        ];
    },
    // index.js: app.use('/api/projects', requireModule('projects'), requireAuthedUser, requireCapability('projects'), projectFeatureGate, require('./routes/projects'))
    projects: () => {
        const { requireModule } = require('../modules');
        const { requireAuth } = require('../auth');
        const { requireCapability } = require('../core/entitlements/entitlements');
        const { featureGate } = require('../boot/featureGate');
        return [['/api/projects', requireModule('projects'), requireAuth, requireCapability('projects'), featureGate('projects', 'Projects'), require('../routes/projects')]];
    },
    // index.js: app.use('/api/dsr', requireModule('compliance'), require('./routes/dsr'))
    dsr: () => {
        const { requireModule } = require('../modules');
        return [['/api/dsr', requireModule('compliance'), require('../routes/dsr')]];
    },
    // index.js: app.use('/api/license', require('./routes/license'))
    license: () => [['/api/license', require('../routes/license')]],
    // index.js: app.use('/api/documents', require('./routes/documents'))
    documents: () => [['/api/documents', require('../routes/documents')]],
    // index.js: app.use('/api/webpages', requireModule('webpages'), requireCapability('webpages'), requireTraining('webpages'), require('./routes/webpages'))
    webpages: () => {
        const { requireModule } = require('../modules');
        const { requireCapability } = require('../core/entitlements/entitlements');
        const { requireTraining } = require('../learning/requireTraining');
        return [['/api/webpages', requireModule('webpages'), requireCapability('webpages'), requireTraining('webpages'), require('../routes/webpages')]];
    },
    // index.js: app.use('/api/notifications', require('./routes/notifications'))
    notifications: () => [['/api/notifications', require('../routes/notifications')]],
};

/** Every feature a journey's organisation plan grants unless it says otherwise. */
const ALL_FEATURES = ['automations', 'datatables', 'webpages', 'agents', 'knowledge', 'app_studio', 'projects', 'notebooks', 'compliance_hub_gdpr'];

/**
 * @typedef {{ status: number, body: any, text: string, headers: import('node:http').IncomingHttpHeaders }} Reply
 * @typedef {{ body?: unknown, headers?: Record<string, string> }} CallOpts
 * @typedef {{
 *   id: string,
 *   call: (method: string, url: string, opts?: CallOpts) => Promise<Reply>,
 *   stream: (url: string, body: unknown) => Promise<{ status: number, events: Array<{ event: string, data: any }>, text: string }>,
 *   cookie: () => string | null,
 * }} Actor
 */

/**
 * Open the world: the ladder schema, the app with the asked-for mounts, a port.
 *
 * @param {{ mounts: string[] }} opts
 */
async function openWorld({ mounts }) {
    // int8 (OID 20) as text, as node-postgres hands it over: PGlite's BigInt
    // would reach res.json() and throw where production never does.
    const { pg, close: closePg } = usePglitePool(ladderPglite({ parsers: { 20: (/** @type {string} */ v) => v } }));
    const swaps = makeSwaps();

    // The model price list the real pricingService reads, filled before
    // anything asks for it: its load-time refresh then finds a fresh cache
    // instead of fetching the community file.
    await loadPricing(PRICES);
    // The installation has no models to download: the KB search's CPU
    // cross-encoder is switched off the way an admin does it (core/kb/localRerank.js),
    // or the first search would fetch its weights from the model hub.
    await require('../stores/configStore').setConfig('cpu_reranker_enabled', false);

    // Ports the server fills at boot (boot/featureRegistrations.js), which
    // routers reach through core: the same registrations index.js runs.
    require('../boot/featureRegistrations');

    const httpMiddleware = require('../boot/httpMiddleware');
    const sessionLayers = require('../boot/session');
    const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

    const app = express();
    app.set('trust proxy', 1);
    httpMiddleware.applyRequestIdAndSecurityHeaders(app);
    httpMiddleware.applyBodyParsers(app);
    sessionLayers.applyCookieSession(app);
    sessionLayers.applySessionBridge(app);
    for (const name of mounts) {
        const build = MOUNTS[name];
        if (!build) throw new Error(`journeyWorld: no mount named ${name}`);
        for (const [path, ...chain] of build()) app.use(path, ...chain);
    }
    app.use(terminalErrorHandler);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const address = /** @type {import('node:net').AddressInfo} */ (server.address());
    ownPorts.add(address.port);
    const base = `http://127.0.0.1:${address.port}`;

    const model = stubModel(swaps);
    stubEmbedder();
    const licenceJwt = require('../license/licenseJwt.testkit');
    require('../license/verify')._setPublicKeyForTesting(licenceJwt.publicKey);

    const userStore = require('../stores/userStore');
    const passwords = require('../auth/passwordHash');

    /**
     * An organisation on an active plan. The plan is the fixture: buying one
     * is the billing provider's journey, not this product's.
     * `tier` is the plan's tier ('pro' counts as Enterprise, license/tiers.js;
     * null is Free, where only a licence or `features` unlock more).
     * @param {{ id: string, name: string, features?: string[], tier?: string | null }} org
     */
    async function seedOrg({ id, name, features = ALL_FEATURES, tier = 'pro' }) {
        const plan = await userStore.createPlan({ name: `${name} plan`, tier, allowed_features: features });
        await userStore.createOrganization({ id, name }, { autoGrantTrial: false });
        await userStore.setOrgSubscription(id, { plan_id: plan.id, status: 'active' });
        return { id, planId: plan.id };
    }

    /**
     * A person with a password, as the installation's first admin or an
     * invitation would leave them; everyone after them is created through the API.
     * @param {{ id: string, password: string, organizationId?: string, orgRole?: string, role?: string, email?: string }} u
     */
    async function seedUser({ id, password, organizationId = '', orgRole = '', role = 'user', email = `${id}@journey.test` }) {
        await userStore.createUser({
            id, username: id, displayName: id, email, role, orgRole, organizationId, groups: [],
            passwordHash: await passwords.hash(password), status: 'active',
        });
    }

    /**
     * @param {string} id
     * @param {string | null} cookieIn
     * @returns {Actor}
     */
    function actor(id, cookieIn) {
        let cookie = cookieIn;
        /**
         * One request to the world's own port over node:http (the product's
         * fetch guards are not the subject here), the session cookie carried
         * like a browser carries it.
         * @param {string} method @param {string} url @param {CallOpts} [opts]
         * @returns {Promise<{ status: number, text: string, headers: import('node:http').IncomingHttpHeaders }>}
         */
        function raw(method, url, { body, headers = {} } = {}) {
            /** @type {Record<string, string>} */
            const h = { ...headers };
            if (cookie) h.cookie = cookie;
            const payload = body === undefined ? undefined : JSON.stringify(body);
            if (payload !== undefined) {
                h['content-type'] = 'application/json';
                h['content-length'] = String(Buffer.byteLength(payload));
            }
            return new Promise((resolve, reject) => {
                const req = http.request(`${base}${url}`, { method, headers: h }, (res) => {
                    /** @type {Buffer[]} */
                    const parts = [];
                    res.on('data', (c) => parts.push(c));
                    res.on('error', reject);
                    res.on('end', () => {
                        const set = (res.headers['set-cookie'] || []).find((c) => c.startsWith('connect.sid='));
                        if (set) cookie = set.split(';')[0];
                        resolve({ status: res.statusCode || 0, text: Buffer.concat(parts).toString('utf8'), headers: res.headers });
                    });
                });
                req.on('error', reject);
                req.end(payload);
            });
        }
        return {
            id,
            cookie: () => cookie,
            async call(method, url, opts) {
                const { status, text, headers } = await raw(method, url, opts);
                let json = null;
                try { json = JSON.parse(text); } catch { json = null; }
                return { status, body: json, text, headers };
            },
            async stream(url, body) {
                const { status, text } = await raw('POST', url, { body, headers: { accept: 'text/event-stream' } });
                return { status, events: parseSse(text), text };
            },
        };
    }

    /**
     * Sign in through POST /auth/admin-login; the actor carries the cookie.
     * @param {string} username
     * @param {string} password
     */
    async function login(username, password) {
        const a = actor(username, null);
        const res = await a.call('POST', '/auth/admin-login', { body: { username, password } });
        if (res.status !== 200 || !res.body?.success) throw new Error(`login ${username}: ${res.status} ${res.text.slice(0, 300)}`);
        return a;
    }

    /** Somebody without a session. */
    const anonymous = () => actor('anonymous', null);

    /**
     * The installation's model provider, as an admin would save it in the AI
     * settings: an OpenAI provider whose model list holds STUB_MODEL. Its
     * adapter answers from the script (stubModel), never from the network.
     */
    async function configureModelProvider() {
        const configStore = require('../stores/configStore');
        await configStore.setConfig('ai', {
            providers: [{ id: 'journey-openai', name: 'Journey OpenAI', type: 'openai', url: 'https://api.openai.com/v1', model: STUB_MODEL, apiKey: 'journey-not-a-key' }],
            defaultProviderId: 'journey-openai',
            model: STUB_MODEL,
        });
        require('../core/llm/modelCache').invalidateModelCache();
    }

    /**
     * A licence for `orgId`, signed the way the licence server signs one (an
     * RS256 JWT, license/licenseJwt.testkit.js; the world trusts that key
     * instead of the bundled one), activated by `admin` through the real
     * POST /api/license/activate. Needs the `license` mount.
     * @param {Actor} admin
     * @param {{ orgId: string, tier?: string, expiresIn?: number }} lic
     */
    async function activateLicence(admin, { orgId, tier = 'enterprise', expiresIn = 3600 }) {
        const now = Math.floor(Date.now() / 1000);
        const token = licenceJwt.sign(licenceJwt.claims({ sub: orgId, tier, license_id: `lic_${orgId}_${tier}`, iat: now - 10, exp: now + expiresIn }));
        return admin.call('POST', '/api/license/activate', { body: { token, scope: 'organization' } });
    }

    async function close() {
        swaps.restore();
        require('../license/verify')._setPublicKeyForTesting(null);
        ownPorts.delete(address.port);
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(() => resolve(undefined)));
        await closePg();
        if (outbound.length) {
            throw new Error(`journey reached for the network: ${outbound.map((o) => `${o.host}:${o.port}`).join(', ')}`);
        }
    }

    return { pg, app, base, swaps, outbound, model, seedOrg, seedUser, login, anonymous, actor, configureModelProvider, activateLicence, close };
}


module.exports = { openWorld, parseSse, ALL_FEATURES, MOUNTS, STUB_MODEL, PRICES };
