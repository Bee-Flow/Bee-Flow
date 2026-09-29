/**
 * Host API — the FROZEN capability surface a remote module receives at
 * activation (`createModule(hostApi)` in packageLoader.js).
 *
 * `hostApiVersion` is the compatibility contract: a package manifest declares
 * the host_api_version it was built against; the loader refuses to activate a
 * package that needs a newer surface than this process exposes. Anything a
 * module can touch — db, express, auth middleware, configStore, email, a
 * read-only license view, an SSRF-guarded fetch, a namespaced logger and a
 * private data directory — is handed over HERE and nowhere else. The object is
 * frozen so a module can't monkey-patch the host through it.
 *
 * The two middleware factories are LAZY, per-request wrappers around the host's
 * real gates, and they 404-CONCEAL unknown/inactive capability ids instead of
 * throwing at mount time (a remote module referencing a capability the host
 * doesn't know must fail closed as "not found", never crash the dispatcher).
 */

'use strict';

const express = require('express');
const { exec, run, getOne, getAll, getClient } = require('../db');
const ssrfGuard = require('../utils/ssrfGuard');
const { isPrivateTarget } = require('../utils/isPrivateTarget');
const log = require('../telemetry/log');

// v1 → v2 was purely ADDITIVE (db.getClient/tx, ai, usage, limits, storage,
// webpages, net). v3 introduces the PERMISSION MANIFEST: an mv2 module
// declares `permissions: []` and receives ONLY the surfaces it was granted
// (plus the implicit core set); an mv1 module (permissions === null) receives
// the full legacy surface unchanged. The version bump exists solely because
// permission-gating is the first semantic old loaders can't honour.
const HOST_API_VERSION = 3;

/**
 * The canonical permission taxonomy (M2) — ids map 1:1 onto the frozen
 * sub-objects build() hands over. `consent` is the operator-facing dialog copy
 * key; `implicit` surfaces are always granted and never listed in consent.
 * env:* ids gate nothing here (they are declared-only requirements surfaced to
 * the operator) but MUST still be consented to — a module running with server
 * privileges is exactly what the dialog needs to say.
 */
const PERMISSION_IDS = Object.freeze({
    'db': { consent: 'Full database access, including organisation and user data' },
    'ai': { consent: 'Can invoke this instance\'s AI providers (may incur cost)' },
    'usage:write': { consent: 'Can record usage/cost entries' },
    'limits:read': { consent: 'Can read subscription limits' },
    'storage:read': { consent: 'Can create download links for stored files' },
    'webpages:write': { consent: 'Can publish pages into users\' Webpages' },
    'email:send': { consent: 'Can send email through this instance' },
    'license:read': { consent: 'Can read licence tier and features' },
    'config': { consent: 'Can store its own settings and secrets (namespaced)' },
    // http:<pattern> is validated structurally (exact host, *.domain, or *).
    'env:docker': { consent: 'Server environment access — Docker (runs with server privileges)' },
    'env:files': { consent: 'Server environment access — file system (runs with server privileges)' },
});

const HTTP_PERMISSION_RE = /^http:(\*|(\*\.)?[a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/i;

/** True when `id` is a known permission id (fixed taxonomy or an http:<pattern> grant). */
function isValidPermissionId(id) {
    if (typeof id !== 'string' || !id) return false;
    return Object.prototype.hasOwnProperty.call(PERMISSION_IDS, id) || HTTP_PERMISSION_RE.test(id);
}

/** Does `url`'s host match any granted http:<pattern>? (exact, *.suffix, or *) */
function hostAllowed(url, patterns) {
    let host;
    try { host = new URL(String(url)).hostname.toLowerCase(); } catch (_) { return false; }
    return (patterns || []).some((p) => {
        const pat = String(p || '').toLowerCase();
        if (pat === '*') return true;
        if (pat.startsWith('*.')) return host === pat.slice(2) || host.endsWith(pat.slice(1));
        return host === pat;
    });
}

// Lazy requires — cycle-safety + test require.cache overrides + keeping heavy
// modules (LLM SDKs, AWS S3, the webpage store) out of boot: each is required
// only on first CALL of the method that needs it, never at build() time.
let _configStore, _email, _license, _entitlements, _permissions, _modules;
let _modelResolver, _aiAgent, _providers, _usageStore, _limits, _storageStore, _webpageStore;
function configStore() { return _configStore || (_configStore = require('../stores/configStore')); }
function emailService() { return _email || (_email = require('../utils/emailService')); }
function license() { return _license || (_license = require('../license')); }
function entitlements() { return _entitlements || (_entitlements = require('../core/entitlements/entitlements')); }
function permissions() { return _permissions || (_permissions = require('../auth/permissions')); }
function modulesRuntime() { return _modules || (_modules = require('./index')); }
function modelResolver() { return _modelResolver || (_modelResolver = require('../core/llm/modelResolver')); }
function aiAgent() { return _aiAgent || (_aiAgent = require('../core/aiAgent')); }
function providers() { return _providers || (_providers = require('../core/providers')); }
function usageStore() { return _usageStore || (_usageStore = require('../stores/usageStore')); }
function limitsModule() { return _limits || (_limits = require('../core/entitlements/limits')); }
function storageStore() { return _storageStore || (_storageStore = require('../stores/storageStore')); }
function webpageStore() { return _webpageStore || (_webpageStore = require('../stores/webpageStore')); }

/**
 * Per-request capability gate for a remote module. Unknown capability id (a
 * module referencing something the host never registered) or an inactive-module
 * capability ⇒ 404 conceal. Otherwise delegate to the host's real
 * requireCapability so entitlement math stays identical to every other gate.
 */
function requireCapability(capId) {
    return async function moduleCapabilityGate(req, res, next) {
        let ent;
        try {
            ent = entitlements();
            if (!ent.registry.getCapability(capId)) {
                return res.status(404).json({ error: 'not_found' });
            }
        } catch (_) {
            return res.status(404).json({ error: 'not_found' });
        }
        try {
            return ent.requireCapability(capId)(req, res, next);
        } catch (_) {
            return res.status(404).json({ error: 'not_found' });
        }
    };
}

/** Per-request permission gate (thin lazy wrapper over auth/permissions). */
function requirePermission(permission) {
    return function modulePermissionGate(req, res, next) {
        let gate;
        try {
            gate = permissions().requirePermission(permission);
        } catch (_) {
            return res.status(403).json({ error: 'forbidden' });
        }
        return gate(req, res, next);
    };
}

let _logBuffer;
function logBuffer() { return _logBuffer || (_logBuffer = require('./moduleLogBuffer')); }

function makeLogger(moduleId) {
    const tag = `[module:${moduleId}]`;
    const buffer = (level, a) => { try { logBuffer().append(moduleId, level, a); } catch (_) { /* never throw into module code */ } };
    return {
        info: (...a) => { buffer('info', a); log.info(tag, ...a); },
        warn: (...a) => { buffer('warn', a); log.warn(tag, ...a); },
        error: (...a) => { buffer('error', a); log.error(tag, ...a); },
        // Debug is BUFFERED always (the logs dialog wants it) but only hits the
        // console when MODULE_DEBUG is on.
        debug: (...a) => { buffer('debug', a); if (process.env.MODULE_DEBUG === 'true') log.info(tag, ...a); },
    };
}

// Read-only license view — modules may branch on tier/feature but can never
// mutate licensing.
const licenseView = Object.freeze({
    getLicenseStatus: (ctx) => license().getLicenseStatus(ctx),
    hasFeature: (feature, ctx) => license().hasFeature(feature, ctx),
    resolveTier: (ctx) => license().resolveTier(ctx),
    getServerLicenseTier: () => license().getServerLicenseTier(),
    serverLicenseGovernsOrgs: () => license().serverLicenseGovernsOrgs(),
});

/**
 * BEGIN/COMMIT/ROLLBACK/release wrapper over a pooled pg client — so a module
 * can run a `FOR UPDATE SKIP LOCKED` outbox transaction without touching the
 * pool directly. The client is always released; a throw rolls back.
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function dbTx(fn) {
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
        throw e;
    } finally {
        client.release();
    }
}

/**
 * Persist a rendered page as a Webpage so it lands in the user's Webpages list
 * and can be viewed/shared like any other page. Encapsulates the exact 3-call
 * webpageStore sequence a module needs to publish a report page
 * (createWebpage → writeSlot(html)+writeSlot(css) → updateWebpageMetadata with
 * the returned sha/size) so a module never touches webpageStore internals.
 * @returns {Promise<string>} the new webpage id.
 */
async function persistWebpage({ userId, name, description, html, css, icon, accentColor, tagline } = {}) {
    const wps = webpageStore();
    const webpage = await wps.createWebpage({ userId, name, description });
    const webpageId = webpage.id;
    const { sha: htmlSha, size: htmlSize } = await wps.writeSlot(userId, webpageId, 'html', html || '');
    const { sha: cssSha, size: cssSize } = await wps.writeSlot(userId, webpageId, 'css', css || '');
    const meta = { htmlSha, htmlSize, cssSha, cssSize };
    // Only stamp presentation fields the caller actually supplied so we don't
    // clobber a store default with null.
    if (icon !== undefined) meta.icon = icon;
    if (accentColor !== undefined) meta.accentColor = accentColor;
    if (tagline !== undefined) meta.tagline = tagline;
    await wps.updateWebpageMetadata(webpageId, userId, meta);
    // Ook een door een module neergezette rapportpagina hoort in de
    // dependents-index: hij draagt gewone html en kan dus `bf-*`-elementen
    // bevatten. Gedebouncet en detached — een module wacht er niet op.
    require('../core/webpages/webpageUsageSync').reconcileWebpageUsageDetached(webpageId);
    return webpageId;
}

/**
 * Namespaced configStore view — every key is forced through a
 * `module_<id>_` prefix, closing v1's instance-wide getSecret over-grant
 * (a module could read ANY install secret through stores.configStore).
 */
function namespacedConfig(moduleId) {
    const prefix = `module_${moduleId}_`;
    const k = (key) => `${prefix}${String(key)}`;
    return Object.freeze({
        getConfig: (key) => configStore().getConfig(k(key)),
        setConfig: (key, value) => configStore().setConfig(k(key), value),
        getSecret: (key) => configStore().getSecret(k(key)),
        setSecret: (key, value) => configStore().setSecret(k(key), value),
    });
}

/**
 * Build the frozen host API object for one module.
 *
 * `permissions` semantics:
 *   - null (mv1 package)  → the FULL legacy surface, unchanged — mv1 modules
 *     behave byte-identically (pinned by hostApi.test.js);
 *   - []                  → core-only: express, middleware, log, dataDir,
 *     isModuleActive, net.isPrivateTarget — safe and strictly tighter;
 *   - ['db','http:api.x.com',…] → core + exactly the granted sub-objects.
 *     http:<pattern> grants wrap fetch with a host allowlist BEFORE the SSRF
 *     guard (private-target blocking is always retained).
 *
 * @param {string} moduleId
 * @param {{ dataDir?: string, permissions?: (string[]|null) }} opts
 */
function build(moduleId, { dataDir = null, permissions = null } = {}) {
    const legacy = permissions == null;
    const granted = legacy ? null : new Set(permissions);
    const has = (id) => legacy || granted.has(id);
    const httpPatterns = legacy ? null : [...granted]
        .filter(p => typeof p === 'string' && p.startsWith('http:'))
        .map(p => p.slice(5));

    const api = {
        hostApiVersion: HOST_API_VERSION,
        moduleId,

        // ── Core (implicit — never consent-listed) ─────────────────────────
        express,
        middleware: Object.freeze({ requireCapability, requirePermission }),
        // Network helpers — the shared sync SSRF literal-host predicate.
        net: Object.freeze({ isPrivateTarget: (url) => isPrivateTarget(url) }),
        // Is a module active? Defaults to THIS module when no id is passed.
        isModuleActive: (id) => modulesRuntime().isModuleActive(id || moduleId),
        log: makeLogger(moduleId),
        // Absolute per-module data directory (created by the loader).
        dataDir,
        // Introspection: what THIS instance was built with (null = legacy mv1).
        permissions: legacy ? null : Object.freeze([...granted]),
    };

    // ── Permission-gated surfaces ──────────────────────────────────────────
    // Each method lazy-requires its heavy backing module on first CALL, so a
    // module that never touches AI/storage/webpages doesn't drag those (LLM
    // SDKs, AWS S3, the webpage store) into boot.

    if (has('db')) {
        // Same primitives every host store uses; getClient/tx for
        // FOR UPDATE SKIP LOCKED outbox work.
        api.db = Object.freeze({ exec, run, getOne, getAll, getClient, tx: dbTx });
    }
    if (has('ai')) {
        api.ai = Object.freeze({
            resolveModelForTier: (ref, opts) => modelResolver().resolveModelForTier(ref, opts),
            getProviderForModel: (modelId) => aiAgent().getProviderForModel(modelId),
            getAdapter: (type, url) => providers().getAdapter(type, url),
        });
    }
    if (has('usage:write')) {
        api.usage = Object.freeze({ logUsage: (entry) => usageStore().logUsage(entry) });
    }
    if (has('limits:read')) {
        api.limits = Object.freeze({
            checkSubscription: (orgId, agentType, userId) => limitsModule().checkSubscriptionLimits(orgId, agentType, userId),
        });
    }
    if (has('storage:read')) {
        // Presigned GET url only (no raw put/delete surface).
        api.storage = Object.freeze({ getPresignedUrl: (key, expiresIn) => storageStore().getPresignedUrl(key, expiresIn) });
    }
    if (has('webpages:write')) {
        api.webpages = Object.freeze({ persist: (opts) => persistWebpage(opts) });
    }
    if (has('email:send')) {
        api.services = Object.freeze({ get email() { return emailService(); } });
    }
    if (has('license:read')) {
        api.license = licenseView;
    }
    if (legacy) {
        // mv1's instance-WIDE configStore (the over-grant mv2's `config`
        // permission closes) — legacy modules keep it for compatibility.
        api.stores = Object.freeze({ get configStore() { return configStore(); } });
    } else if (granted.has('config')) {
        api.config = namespacedConfig(moduleId);
    }

    if (legacy) {
        // SSRF-guarded fetch (blocks private-network targets) plus the raw
        // guard for modules building their own validating dispatcher.
        api.fetch = (url, options) => ssrfGuard.safeFetch(url, options);
        api.ssrfGuard = ssrfGuard;
    } else if (httpPatterns.length) {
        api.fetch = (url, options) => {
            if (!hostAllowed(url, httpPatterns)) {
                return Promise.reject(new Error(`host not in this module's http allowlist: ${url}`));
            }
            return ssrfGuard.safeFetch(url, options); // private targets still blocked
        };
        api.ssrfGuard = ssrfGuard;
    }

    return Object.freeze(api);
}

module.exports = {
    build,
    HOST_API_VERSION,
    PERMISSION_IDS,
    isValidPermissionId,
    hostAllowed,
    requireCapability,
    requirePermission,
};
