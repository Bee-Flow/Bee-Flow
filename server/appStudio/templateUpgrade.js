/**
 * App Studio — template-upgrade support (pristine detection + availability).
 *
 * Apps are created FROM templates by cloning the template's definition
 * (studioApps.js create path). When a registered template later ships a newer
 * `version`, an app may be upgraded in place — but ONLY when its definition
 * was never hand-edited since install. That "pristine" question is answered by
 * a content hash:
 *
 *   • at create-from-template time the route stamps the app row with
 *     { templateId, templateVersion, templateInstallHash } where the hash is
 *     sha256(stableStringify(definition AS SAVED)) — the exact canonicalized
 *     object handed to the store;
 *   • an app is pristine iff sha256(stableStringify(current definition))
 *     equals that stored install hash.
 *
 * stableStringify (recursive, key-sorted) rather than JSON.stringify because
 * the definition lives in a Postgres JSONB column, and jsonb does NOT preserve
 * object key order — a plain stringify of the read-back object would hash
 * differently even for byte-identical content.
 *
 * Everything here is dependency-light on purpose: no store require at module
 * load (the store opens a DB pool eagerly), callers inject loadApp/getTemplate
 * where needed. The unit tests exercise these functions with plain objects.
 */

'use strict';

const crypto = require('crypto');
const registry = require('./templates');
const log = require('../telemetry/log');

/** Deterministic JSON: recursively sorted object keys, JSON value semantics. */
function stableStringify(value) {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') {
        const out = JSON.stringify(value);
        // Non-JSON leaves (functions/symbols) stringify to undefined — treat
        // them as null so the serialization is always total.
        return out === undefined ? 'null' : out;
    }
    if (Array.isArray(value)) {
        return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(',')}]`;
    }
    const keys = Object.keys(value)
        .filter((k) => value[k] !== undefined && typeof value[k] !== 'function')
        .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** sha256 hex of the canonical JSON of a definition object. */
function hashDefinition(definition) {
    return crypto.createHash('sha256').update(stableStringify(definition ?? {}), 'utf8').digest('hex');
}

/** The version an app row was installed at — missing/invalid counts as 1. */
function installedTemplateVersion(app) {
    const v = app && app.templateVersion;
    return (Number.isInteger(v) && v > 0) ? v : 1;
}

/**
 * Registry-side pre-check WITHOUT touching the definition (cheap — safe on
 * meta-only list rows). Returns null when there is nothing to upgrade to:
 * the app was not created from a template, carries no install stamp, the
 * template is no longer registered, or the registry version is not newer.
 * Otherwise { template, fromVersion, toVersion }.
 *
 * `template` may be passed explicitly (tests / callers with a mocked
 * registry); leave it undefined to look the id up in the real registry.
 */
function upgradeCandidate(app, template = undefined) {
    if (!app || !app.templateId || !app.templateInstallHash) return null;
    const tpl = template === undefined ? registry.getTemplate(app.templateId) : template;
    if (!tpl) return null;
    const fromVersion = installedTemplateVersion(app);
    const toVersion = registry.templateVersion(tpl);
    if (toVersion <= fromVersion) return null;
    return { template: tpl, fromVersion, toVersion };
}

/**
 * Pristine = the CURRENT saved definition hashes to the stored install hash.
 * Needs a FULL app row (meta rows carry no definition). Apps without an
 * install stamp are never pristine — there is nothing to compare against.
 */
function isPristine(app) {
    if (!app || !app.templateInstallHash) return false;
    return hashDefinition(app.definition) === app.templateInstallHash;
}

/**
 * Attach { templateUpgrade } to every app row of a meta list:
 *   { available:false }                                — nothing upgradable
 *   { available, fromVersion, toVersion }              — a newer version exists
 * available is true only when the app is ALSO pristine. The definition is
 * loaded (via opts.loadApp) and hashed only for apps whose registry version is
 * actually newer — the common case stays a pure in-memory check. Best-effort:
 * a load/hash hiccup reports available:false, never breaks the list.
 *
 * opts:
 *   loadApp(id) → full app row (REQUIRED for availability; without it every
 *                 candidate reports available:false)
 *   getTemplate(id) → registry lookup override (defaults to the real registry)
 */
async function annotateTemplateUpgrades(apps, { loadApp, getTemplate } = {}) {
    const out = [];
    for (const a of (Array.isArray(apps) ? apps : [])) {
        // Awaited: a CAPTURED template (studio_app_templates) is a database
        // row, so the injected resolver may be async. `await` on the plain
        // object a synchronous resolver returns is a no-op, so the built-in
        // path is unchanged.
        const cand = upgradeCandidate(a, getTemplate ? await getTemplate(a && a.templateId) : undefined);
        if (!cand) {
            out.push({ ...a, templateUpgrade: { available: false } });
            continue;
        }
        let available = false;
        try {
            const full = loadApp ? await loadApp(a.id) : null;
            available = !!full && isPristine(full);
        } catch (e) {
            log.warn(`[templateUpgrade] pristine check failed for ${a && a.id}: ${e && e.message ? e.message : e}`);
        }
        out.push({ ...a, templateUpgrade: { available, fromVersion: cand.fromVersion, toVersion: cand.toVersion } });
    }
    return out;
}

module.exports = {
    stableStringify,
    hashDefinition,
    installedTemplateVersion,
    upgradeCandidate,
    isPristine,
    annotateTemplateUpgrades,
};
