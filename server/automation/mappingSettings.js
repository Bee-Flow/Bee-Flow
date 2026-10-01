// @typecheck
/**
 * The organisation setting "Update mappings automatically when an automation
 * is opened" (M8b of the data-mapping work).
 *
 * Stored in configStore under `org_automation_mappings_<orgId>` as
 * `{ autoUpgradeOnOpen: boolean }`. Default OFF: rewriting a stored
 * definition, even only where the value provably stays the same, is a choice
 * an organisation makes, and leaves a config row saying it made it. An
 * organisation-less (personal) automation reads the default.
 *
 * What ON does: when someone who may edit an automation opens it in the
 * builder, the same rewrite as "Update mappings" (routes/automation/
 * upgradeMappings.js, `auto: true`) is applied, as a new version the builder
 * offers to undo. Never the AI fix: an AI suggestion is only ever applied by
 * a person who looked at it.
 *
 * Read on every such open, so the answer is memoised for CACHE_TTL_MS; the
 * settings route calls `invalidateMappingSettings` on save. Never throws on a
 * read: a config read that fails answers the default (off), and logs.
 */

'use strict';

const log = require('../telemetry/log');

const CONFIG_KEY_PREFIX = 'org_automation_mappings_';
const CACHE_TTL_MS = 30_000;
const DEFAULTS = Object.freeze({ autoUpgradeOnOpen: false });

/** @type {Map<string, { at: number, settings: { autoUpgradeOnOpen: boolean } }>} */
const _cache = new Map();

/**
 * A stored row as a complete setting. Only a literal true switches it on: a
 * corrupt or hand-written row must not be what starts rewriting definitions.
 * @param {unknown} stored
 */
function normalizeMappingSettings(stored) {
    const src = stored && typeof stored === 'object' ? /** @type {Record<string, unknown>} */ (stored) : {};
    return { autoUpgradeOnOpen: src.autoUpgradeOnOpen === true };
}

/**
 * @param {{ configStore?: { getConfig: (key: string) => Promise<unknown>, setConfig?: (key: string, value: unknown) => Promise<unknown> } }} [deps]
 */
function makeMappingSettings(deps = {}) {
    const configStore = () => deps.configStore || require('../stores/configStore');

    /** The setting for an organisation, defaults filled in. @param {string|null|undefined} orgId */
    async function readMappingSettings(orgId) {
        if (!orgId) return { ...DEFAULTS };
        const hit = _cache.get(orgId);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.settings;
        let stored = null;
        try {
            stored = await configStore().getConfig(`${CONFIG_KEY_PREFIX}${orgId}`);
        } catch (err) {
            log.warn(`[MappingSettings] could not read the setting for org ${orgId}: ${/** @type {Error} */ (err).message}`);
            return { ...DEFAULTS };
        }
        const settings = normalizeMappingSettings(stored);
        _cache.set(orgId, { at: Date.now(), settings });
        return settings;
    }

    /**
     * Store the organisation setting (the admin screen). Unknown keys are
     * dropped; the stored shape is always complete.
     * @param {string} orgId @param {{ autoUpgradeOnOpen?: boolean }} patch @param {string|null} [updatedBy]
     */
    async function saveMappingSettings(orgId, patch, updatedBy = null) {
        if (!orgId) throw new Error('[MappingSettings] orgId is required');
        const next = normalizeMappingSettings({ ...(await readMappingSettings(orgId)), ...(patch || {}) });
        const store = configStore();
        if (typeof store.setConfig !== 'function') throw new Error('[MappingSettings] config store cannot write');
        await store.setConfig(`${CONFIG_KEY_PREFIX}${orgId}`, { ...next, updatedAt: new Date().toISOString(), updatedBy });
        invalidateMappingSettings(orgId);
        return next;
    }

    return { readMappingSettings, saveMappingSettings };
}

/** Drop the memoised setting for an organisation (or all). @param {string|null} [orgId] */
function invalidateMappingSettings(orgId) {
    if (orgId === undefined || orgId === null) { _cache.clear(); return; }
    _cache.delete(orgId);
}

const defaults = makeMappingSettings();

module.exports = {
    CONFIG_KEY_PREFIX,
    DEFAULTS,
    normalizeMappingSettings,
    makeMappingSettings,
    invalidateMappingSettings,
    readMappingSettings: defaults.readMappingSettings,
    saveMappingSettings: defaults.saveMappingSettings,
};
