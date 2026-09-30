// @typecheck
/**
 * Whether real-time co-editing is on for an organisation.
 *
 * Two switches, checked in this order, first "off" wins:
 *
 *   1. `COLLAB_ENABLED=0` in the server environment: the operator's kill
 *      switch, for every organisation at once, no database read.
 *   2. The organisation setting `collab_enabled`, stored in configStore under
 *      `org_collab_<orgId>` as `{ collab_enabled: boolean }`. Default ON: a
 *      member opening a project page gets co-editing unless an admin turned it
 *      off. An organisation-less install reads the default.
 *
 * When off, `POST /api/projects/:id/docs` answers 503 COLLAB_DISABLED and the
 * editors fall back to single-writer saves. Switching it off through
 * `saveCollabSettings` folds every co-edited document of the organisation back
 * into its notebook or page (core/collab detachOrganisation, every page of
 * them); a document that could not be folded back is retried when the setting
 * is saved off again, and the next time anything asks about it.
 *
 * Read on every co-editing request, so the answer is memoised for
 * CACHE_TTL_MS; the settings route calls `invalidateCollabSettings` on save.
 * Never throws: a config read that fails answers the default, and logs.
 */

'use strict';

const log = require('../../telemetry/log');
// The key is declared with the co-editing store, so the organisation teardown
// can delete it without depending on core.
const { COLLAB_SETTINGS_KEY_PREFIX: CONFIG_KEY_PREFIX } = require('../../stores/collabDocStore');
const CACHE_TTL_MS = 30_000;
const DEFAULTS = Object.freeze({ collab_enabled: true });

/** @type {Map<string, { at: number, settings: { collab_enabled: boolean } }>} */
const _cache = new Map();

/** True when the operator switched co-editing off for the whole server. */
function killSwitchOn(env = process.env) {
    const raw = String(env.COLLAB_ENABLED ?? '').trim().toLowerCase();
    return raw === '0' || raw === 'false' || raw === 'off' || raw === 'no';
}

/** @param {unknown} stored */
function normalizeSettings(stored) {
    const src = stored && typeof stored === 'object' ? /** @type {Record<string, unknown>} */ (stored) : {};
    return { collab_enabled: typeof src.collab_enabled === 'boolean' ? src.collab_enabled : DEFAULTS.collab_enabled };
}

/**
 * @param {{ configStore?: { getConfig: (key: string) => Promise<unknown>, setConfig?: (key: string, value: unknown) => Promise<unknown> },
 *           env?: NodeJS.ProcessEnv, detachOrganisation?: (orgId: string) => Promise<any> }} [deps]
 */
function makeCollabSettings(deps = {}) {
    const configStore = () => deps.configStore || require('../../stores/configStore');
    const env = () => deps.env || process.env;

    /** The stored settings for an organisation, defaults filled in. @param {string|null|undefined} orgId */
    async function readCollabSettings(orgId) {
        const key = orgId || '';
        const hit = _cache.get(key);
        if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.settings;
        let stored = null;
        if (orgId) {
            try {
                stored = await configStore().getConfig(`${CONFIG_KEY_PREFIX}${orgId}`);
            } catch (err) {
                log.warn(`[CollabSettings] could not read the setting for org ${orgId}: ${/** @type {Error} */ (err).message}`);
            }
        }
        const settings = normalizeSettings(stored);
        _cache.set(key, { at: Date.now(), settings });
        return settings;
    }

    /** Co-editing on for this organisation, all switches considered. @param {string|null|undefined} orgId */
    async function isCollabEnabled(orgId) {
        if (killSwitchOn(env())) return false;
        return (await readCollabSettings(orgId)).collab_enabled;
    }

    /**
     * Store the organisation setting (the admin settings screen). Unknown keys
     * are dropped; the stored shape is always complete.
     * @param {string} orgId @param {{ collab_enabled?: boolean }} patch
     */
    async function saveCollabSettings(orgId, patch) {
        if (!orgId) throw new Error('[CollabSettings] orgId is required');
        const current = await readCollabSettings(orgId);
        const next = normalizeSettings({ ...current, ...(patch || {}) });
        const store = configStore();
        if (typeof store.setConfig !== 'function') throw new Error('[CollabSettings] config store cannot write');
        await store.setConfig(`${CONFIG_KEY_PREFIX}${orgId}`, next);
        invalidateCollabSettings(orgId);
        // Switched off — or saved off again, which gives a document that
        // could not be folded back the first time another pass (the org
        // root key rotation waits for none to be left).
        if (!next.collab_enabled && (current.collab_enabled || (patch && patch.collab_enabled === false))) {
            // Fold every co-edited document back into its notebook or page,
            // in the background: the admin's save does not wait for it, and
            // anything missed is folded back on its next use anyway.
            const detachAll = deps.detachOrganisation || ((id) => require('./index').detachOrganisation(id));
            setImmediate(() => {
                Promise.resolve(detachAll(orgId))
                    .then((r) => { if (r && r.failed) log.warn(`[CollabSettings] ${r.failed} document(s) of org ${orgId} could not be folded back yet`); })
                    .catch((err) => log.warn(`[CollabSettings] folding back the documents of org ${orgId} failed: ${err.message}`));
            });
        }
        return next;
    }

    return { readCollabSettings, isCollabEnabled, saveCollabSettings };
}

/** Drop the memoised setting for an organisation (or all). @param {string|null} [orgId] */
function invalidateCollabSettings(orgId) {
    if (orgId === undefined) { _cache.clear(); return; }
    _cache.delete(orgId || '');
}

const defaultSettings = makeCollabSettings();

module.exports = {
    CONFIG_KEY_PREFIX,
    DEFAULTS,
    killSwitchOn,
    normalizeSettings,
    makeCollabSettings,
    invalidateCollabSettings,
    ...defaultSettings,
};
