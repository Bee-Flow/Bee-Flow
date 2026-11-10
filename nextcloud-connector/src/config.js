/**
 * Connector runtime config.
 *
 * Most values come from env vars Nextcloud injects when AppAPI starts the
 * container — see ExApp lifecycle docs:
 *   https://docs.nextcloud.com/server/32/developer_manual/exapp_development/development_overview/ExAppLifecycle.html
 *
 * BEEFLOW_TENANT_KEY and BEEFLOW_API_BASE_URL are optional install-time values
 * (`occ app_api:app:register bee_flow <daemon> --env NAME=VALUE`, or the
 * advanced deploy options in the Nextcloud UI). Without them an administrator
 * chooses the Bee Flow server after installing; see serverChoice.js.
 */

const { envLock } = require('./serverChoice');
const log = require('./log');

/** @param {string} name */
function required(name) {
    const v = process.env[name];
    if (!v) throw new Error(`Missing required env var: ${name}`);
    return v;
}

// Auto-bootstrap mode: when BEEFLOW_TENANT_KEY is unset or set to literal
// "auto", the connector calls /auth/connector/bootstrap on the server an
// administrator chose, to provision an org + mint a tenant key. The result is
// cached in APP_PERSISTENT_STORAGE (survives container restarts but not disk
// wipe), so the admin doesn't need to mint or paste any keys. Without a chosen
// server there is no bootstrap.
const rawTenantKey = process.env.BEEFLOW_TENANT_KEY || 'auto';

// Rule 1 of serverChoice.js: BEEFLOW_API_BASE_URL fixes the server when it is
// the word `cloud` or the URL of a server. The literal Cloud URL is not a
// lock and by itself not a choice.
const serverLock = envLock(process.env.BEEFLOW_API_BASE_URL);
if (serverLock.invalid) {
    log.warn(`[Config] ignoring BEEFLOW_API_BASE_URL: ${serverLock.invalid}`);
}
// Bee Flow Cloud's frontend, where the embedded SPA shell comes from while the
// connector talks to Cloud. Same value as setupConfig.CLOUD_EMBED_URL. That
// same value in BEEFLOW_EMBED_BASE_URL is no lock.
const CLOUD_EMBED_BASE_URL = 'https://beeflow.nl';
const envEmbedBaseUrl = (process.env.BEEFLOW_EMBED_BASE_URL || '').trim().replace(/\/+$/, '');
const isAutoTenantKey = (rawTenantKey === 'auto' || rawTenantKey === '');

/**
 * @typedef {object} ConnectorConfig
 * @property {string} appId
 * @property {string} appSecret
 * @property {string} appVersion
 * @property {string} appHost
 * @property {number} appPort
 * @property {string} persistentStorage
 * @property {string} nextcloudUrl
 * @property {string | null} nextcloudPublicUrl
 * @property {string | null} tenantKey        filled in at runtime (env, bootstrap cache or the bootstrap call); always null while no server is chosen
 * @property {string | null} envTenantKey     an explicit BEEFLOW_TENANT_KEY (null in auto mode); it becomes tenantKey once a server is known
 * @property {boolean} isAutoTenantKey
 * @property {string | null} organizationId
 * @property {string | null} organizationName
 * @property {string | null} ncInstanceId
 * @property {string | null} apiBaseUrl      the chosen Bee Flow server; null until an administrator chooses one
 * @property {import('./serverChoice').ServerSource} serverSource  where apiBaseUrl came from at boot (serverChoice.js)
 * @property {boolean} apiBaseUrlLocked     BEEFLOW_API_BASE_URL fixes the server (the word `cloud` or a server URL): the admin's lock
 * @property {string} embedBaseUrl
 * @property {boolean} embedBaseUrlLocked   BEEFLOW_EMBED_BASE_URL names a host other than Cloud's frontend: the admin's lock
 * @property {string | null} pairingCode
 * @property {number} jwtTtlSeconds
 * @property {number} sigSkewSeconds
 */

/** @type {ConnectorConfig} */
const config = {
    // ── AppAPI-injected ────────────────────────────────────────
    appId: process.env.APP_ID || 'bee_flow',
    appSecret: required('APP_SECRET'),
    appVersion: process.env.APP_VERSION || '0.0.0',
    // Always bind 0.0.0.0. AppAPI's manual-install daemon sets APP_HOST=127.0.0.1
    // assuming the container's docker-proxy maps it; HaRP's docker-install
    // daemon (harp_exapp_direct mode) needs to reach the container directly via
    // the docker network, which requires binding all interfaces. Either way,
    // the only inbound traffic is from the deploy-daemon (NC's signed-secret
    // gate enforced upstream).
    appHost: '0.0.0.0',
    appPort: parseInt(process.env.APP_PORT || '8080', 10),
    persistentStorage: process.env.APP_PERSISTENT_STORAGE || '/data',
    nextcloudUrl: required('NEXTCLOUD_URL').replace(/\/+$/, ''),
    // Public URL the SaaS uses to call NC back during bootstrap (anti-spoofing
    // capabilities check). Distinct from nextcloudUrl so that internal connector
    // → NC traffic can keep using the fast Docker-internal hostname while only
    // the bootstrap claim sent to the SaaS uses the publicly-reachable URL
    // (e.g. an ngrok / cloudflared tunnel). Falls back to nextcloudUrl when
    // unset, which is correct for production (NC is publicly addressable).
    nextcloudPublicUrl: (process.env.BEEFLOW_NC_PUBLIC_URL || '').replace(/\/+$/, '') || null,

    // ── Customer-configured / auto-provisioned ─────────────────
    // tenantKey is filled in at runtime: either from env, or from the bootstrap
    // cache file, or by calling the bootstrap endpoint of the chosen server.
    // See bootstrap.js. No server means no key in memory: an explicit
    // BEEFLOW_TENANT_KEY is applied here only when the env also fixes the
    // server, and otherwise by serverChoice.applyAtBoot once a server is known.
    tenantKey: (!isAutoTenantKey && serverLock.url) ? rawTenantKey : null,
    envTenantKey: isAutoTenantKey ? null : rawTenantKey,
    isAutoTenantKey,
    // Cache for auto-provisioned tenant key + org id. Written by bootstrap.js.
    organizationId: null,
    // Display name of that org, from the same bootstrap response; shown back to
    // the admin by /setup/clear-cache. Null until a binding is applied.
    organizationName: null,
    ncInstanceId: null,
    // The Bee Flow server. Null until one is known: at load only the env lock
    // counts; serverChoice.applyAtBoot (server.js) then resolves what the
    // install already holds (an existing binding, a saved choice), and the
    // setup page or the settings form set it when an administrator chooses.
    // Never an empty string or a placeholder.
    apiBaseUrl: serverLock.url,
    serverSource: serverLock.url ? 'env-lock' : 'none',
    // Whether BEEFLOW_API_BASE_URL is a deliberate admin lock that the /setup
    // picker, the admin settings form and the bound-server pin must not
    // override: the word `cloud`, or the URL of a server. AppAPI replays the
    // value it stored at install time on every update, so the literal Cloud
    // URL can be present without anybody having typed it; that value is not a
    // lock.
    apiBaseUrlLocked: !!serverLock.url,

    // Upstream for the embedded SPA SHELL (index.html + hashed assets). The
    // connector proxies the shell from a frontend host's `/embed/` build
    // instead of baking it into the image, so a frontend deploy reaches the
    // embedded view without a connector release. Distinct from apiBaseUrl:
    // the API lives on the server (server.beeflow.nl) while the static shell
    // is served by the frontend (beeflow.nl). This is only the Cloud default
    // or the admin's env lock: which host a request really goes to follows
    // the live server choice, see embedTarget.js (#401). The baked /public
    // bundle remains the fallback.
    embedBaseUrl: envEmbedBaseUrl || CLOUD_EMBED_BASE_URL,
    embedBaseUrlLocked: !!envEmbedBaseUrl && envEmbedBaseUrl !== CLOUD_EMBED_BASE_URL,

    // One-shot pairing code for binding this NC to an existing Bee Flow org
    // (instead of creating a new one). An install-time value, or entered on
    // the setup page after generating the code in the existing org's
    // Settings → Organisation → Nextcloud Sync panel. Consumed once at
    // bootstrap; clear after.
    pairingCode: (process.env.BEEFLOW_PAIRING_CODE || '').trim().toUpperCase() || null,

    // ── Operational knobs ──────────────────────────────────────
    // JWT TTL — short on purpose. The SaaS treats every request as a new
    // bearer; we don't want a leaked token to be useful for long.
    jwtTtlSeconds: parseInt(process.env.BEEFLOW_JWT_TTL_SECONDS || '300', 10),
    // Skew tolerance for AppAPI signed-request timestamp.
    sigSkewSeconds: parseInt(process.env.BEEFLOW_SIG_SKEW_SECONDS || '300', 10),
};

module.exports = config;
