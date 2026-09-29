/**
 * Browser-state schema: one version, one migration pass, run at app start.
 *
 * localStorage on an existing install is a mix of eras — pre-scoping bare
 * keys, keys whose writer no longer exists, and caches written by an older
 * build. Until now nothing carried a version, so every reader had to guess
 * what it was looking at. This module gives the browser state a single
 * integer schema version and a pass that runs:
 *
 *   - once per DEVICE (marker `beeflow:storageSchema`) — prunes dead
 *     device-level keys and, on every start, sweeps build-stamped caches
 *     left behind by other builds;
 *   - once per USER (marker `beeflow:<userId>:storageSchema`, inside the
 *     user's scoped namespace so logout's clearUser drops it along with the
 *     preferences it describes) — moves known pre-scoping bare keys into the
 *     user's scoped slots (reading AND deleting the bare key) and prunes
 *     retired scoped keys.
 *
 * Both passes are idempotent and never throw: a corrupt or unknown version
 * marker counts as "unversioned" and simply re-runs the (idempotent) ladder;
 * storage being unavailable altogether is a silent no-op. AuthedApp calls
 * them from the same effect that pins scopedStorage to the whoami user.
 *
 * This REPLACES the old lazy per-read migration in scopedStorage.getItem,
 * which copied a bare key into whichever user happened to read it first and
 * never deleted the original — so the same pre-scoping value could later be
 * claimed by a second account on a shared browser.
 *
 * BUILD-STAMPED CACHES vs DEPLOY-SPANNING KEYS
 * Suffixing a key with APP_BUILD_SHA (`buildStampedCacheKey`) makes it cold
 * after every deploy. That is correct ONLY for caches of server state — the
 * i18n catalogue (`beeflow_i18n_<loc>_<sha>`) and icon packs
 * (`beeflow_iconpack_<packId>_<sha>`) — where serving last release's copy is
 * the bug being fixed. Everything below deliberately stays UNstamped and
 * must never be renamed per build:
 *   - `bf_session_token`, `bf_auth_reload_at` (sessionStorage, helpers.js):
 *     embed auth plumbing and the 401→reload loop-breaker; losing them
 *     mid-session breaks Nextcloud embeds.
 *   - `cookie_consent` (+ legacy `bf_cookie_consent`): a consent record —
 *     resetting it re-asks a question the visitor already answered.
 *   - `beeflow_locale`: the user's CHOICE of language. The catalogue cache
 *     is stamped; the choice survives deploys.
 *   - `beeflow_i18n_available_locales`: guarded by its own 24h TTL, and the
 *     gate that avoids 404s on the login page — left alone here.
 *   - `beeflow:theme:bootstrap`: read PRE-REACT by the inline script in
 *     index.html for first-paint theming; renaming it breaks that handoff.
 *   - `cms.*` device keys (themeOverride, announcementDismissed,
 *     activeSiteId, fontHrefs): marketing-surface preferences.
 *   - every `beeflow:<userId>:*` scoped preference (defaults, last-used,
 *     sidebar/panel state, tier choices, recents, onboarding progress):
 *     preferences describe the user, not the build.
 */

import { APP_BUILD_SHA } from './appVersion';
import { scopedKey } from './scopedStorage';

export const STORAGE_SCHEMA_VERSION = 1;
export const DEVICE_SCHEMA_KEY = 'beeflow:storageSchema';
// Stored under the user's scoped namespace: `beeflow:<userId>:storageSchema`.
const USER_SCHEMA_KEY = 'storageSchema';

// Cache-key prefixes shared with useTranslation / useIconPack so the sweep
// below and the writers can never drift apart.
export const I18N_CACHE_PREFIX = 'beeflow_i18n_';
export const I18N_LOCALES_CACHE_KEY = 'beeflow_i18n_available_locales';
export const ICONPACK_CACHE_PREFIX = 'beeflow_iconpack_';

/* ─── Safe raw access — every localStorage touch in this module goes through
   these. Private mode, a blocked third-party context or a full quota must
   degrade to "no stored value", never to a crash. */

export function readDeviceItem(key) {
    try { return localStorage.getItem(key); } catch { return null; }
}

export function writeDeviceItem(key, value) {
    try { localStorage.setItem(key, value); } catch { /* quota / blocked */ }
}

export function removeDeviceItem(key) {
    try { localStorage.removeItem(key); } catch { /* blocked */ }
}

/**
 * Guarded JSON read for DEVICE-level keys (user-scoped ones go through
 * scopedStorage.getJSON). `validate` receives the parsed value and returns
 * the cleaned value to use, or undefined to reject it — the allow-list hook:
 * JSON.parse only proves the text was JSON, not that it has the shape the
 * caller is about to index into.
 */
export function readDeviceJSON(key, fallback = null, validate = null) {
    const raw = readDeviceItem(key);
    if (raw === null) return fallback;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return fallback; }
    if (typeof validate === 'function') {
        let cleaned;
        try { cleaned = validate(parsed); } catch { return fallback; }
        return cleaned === undefined ? fallback : cleaned;
    }
    return parsed;
}

function allDeviceKeys() {
    const keys = [];
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k) keys.push(k);
        }
    } catch { /* storage unavailable */ }
    return keys;
}

/** Build-stamped cache key: `<prefix><id>_<sha>` — cold after every deploy. */
export function buildStampedCacheKey(prefix, id, sha = APP_BUILD_SHA) {
    return `${prefix}${id}_${sha}`;
}

/**
 * Remove build-stamped caches written by OTHER builds (and the unstamped
 * pre-U8 forms, which by definition don't end in `_<sha>`). Runs on every
 * start — the schema version doesn't bump per deploy, so this can't live in
 * the version-gated ladder. `beeflow_i18n_available_locales` is exempt: it
 * has its own 24h TTL and is not a per-build catalogue.
 */
export function sweepStaleBuildCaches(sha = APP_BUILD_SHA) {
    // 'headless' is the pinned sha of the App-Studio runtime-library build
    // (vite.runtime.config.js). If that bundle ever runs on the main app's
    // origin it must not treat the host app's current caches as stale.
    if (!sha || sha === 'headless') return;
    const suffix = `_${sha}`;
    for (const k of allDeviceKeys()) {
        const isI18nCache = k.startsWith(I18N_CACHE_PREFIX) && k !== I18N_LOCALES_CACHE_KEY;
        const isIconPackCache = k.startsWith(ICONPACK_CACHE_PREFIX);
        if ((isI18nCache || isIconPackCache) && !k.endsWith(suffix)) {
            removeDeviceItem(k);
        }
    }
}

/**
 * Parse a version marker. Missing, corrupt or non-positive → 0 ("unversioned"):
 * re-running the idempotent ladder is always safe, crashing never is. A marker
 * NEWER than this build (rollback scenario) skips the ladder — those steps ran
 * before the version could ever have been raised — and is normalised back so
 * the newer build re-runs its own steps when it returns.
 */
function readSchemaVersion(markerKey) {
    const raw = readDeviceItem(markerKey);
    if (raw === null) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/* ─── Device-level ladder ─── */

// Keys with no writer left anywhere in src/ — trapped state nobody can edit
// or remove through the UI. `modelAliases` / `hiddenModels` were raw
// unguarded JSON.parse targets (a corrupt value crashed every model picker);
// `reasoningEffort` (bare pre-scoping form) silently overrode the tier
// effort in useChatEngine. NOTE: only list a key here once its writer is
// actually gone from src/ — pruning a live key wipes a choice the user can
// still make (and Sidebar still writes all three sidebar_*_expanded keys).
const DEAD_DEVICE_KEYS = [
    'modelAliases',
    'hiddenModels',
    'reasoningEffort',
];

function applyDeviceMigrations(fromVersion) {
    if (fromVersion < 1) {
        for (const key of DEAD_DEVICE_KEYS) removeDeviceItem(key);
    }
    // v2, v3, … append here — each step must stay idempotent and must never
    // undo what a later step does.
}

/**
 * Device pass. Call once at app start (AuthedApp's identity effect calls it —
 * re-entry is cheap and harmless). Always sweeps stale build caches; runs the
 * version-gated ladder only when the marker is behind.
 */
export function runStorageMigrations() {
    try {
        sweepStaleBuildCaches();
        const from = readSchemaVersion(DEVICE_SCHEMA_KEY);
        if (from !== STORAGE_SCHEMA_VERSION) {
            applyDeviceMigrations(from);
            writeDeviceItem(DEVICE_SCHEMA_KEY, String(STORAGE_SCHEMA_VERSION));
        }
    } catch { /* never take the app down over storage */ }
}

/* ─── Per-user ladder ─── */

// Pre-scoping bare keys that move into the user's scoped namespace. The move
// reads AND deletes the bare key: the first account to sign in after the
// upgrade claims the value, and a second account on the same browser starts
// clean instead of inheriting it (the cross-account bleed the old lazy
// migration allowed). Absent keys are no-ops, so listing a key that never
// existed bare costs nothing.
const LEGACY_USER_KEYS = [
    // Chat & agent preferences
    'defaultAgentMode', 'defaultAgentId', 'lastUsedAgentId', 'lastUsedMode',
    'chatHistoryMode', 'activeSkillIds', 'webSearchEnabled', 'memoryWriteEnabled',
    'imageGenSettings', 'nanoBananaSettings', 'disabledMedia',
    // Favourites migrate onwards to the server (useAgentHubData); moving the
    // bare keys keeps that server migration able to find them.
    'agentFavorites', 'kb_favorites',
    // Onboarding / learning
    'hasSeenIntroTour', 'learningPath', 'learningProgress', 'learnPlayerLayout',
    // Recents — beeflow.search.recent was a device key holding per-user data
    // (search terms); its reader now goes through scopedStorage.
    'formRecents', 'studioRecents', 'agent_marketplace_recents', 'kb_marketplace_recents',
    'beeflow.search.recent',
    // Sidebar collapse state (sidebarTokens.js) — all three sections are live
    // and keep their historic keys, so a saved "collapsed" survives the move.
    // Retiring one later (a redesign that renames its group) goes through a
    // NEW version step, never by editing this v1 list: v1 is already stamped
    // on existing installs and would silently skip them.
    'sidebar_agents_expanded', 'sidebar_chats_expanded', 'sidebar_projects_expanded',
    // Tier choices
    'coworkTier', 'appStudioAiTier', 'appBuilderTier', 'cmsBuilderTier', 'automationBuilderTier',
    // Executions filters (validated on read by useExecutions either way)
    'runsFilters.global', 'runsFilters.automation', 'runsFilters.step',
];

// Scoped keys removed outright. `reasoningEffort` has had no writer since the
// tier slider took over but still overrode the tier effort on every send
// (useChatEngine) — the only cleanup was TierSlider's removeItem, which runs
// only if that component mounts. Same caution as DEAD_DEVICE_KEYS: a key may
// only land here once nothing in src/ reads or writes it any more.
const RETIRED_USER_KEYS = ['reasoningEffort'];

function applyUserMigrations(userId, fromVersion) {
    if (fromVersion < 1) {
        for (const key of LEGACY_USER_KEYS) {
            const bare = readDeviceItem(key);
            if (bare !== null) {
                const scoped = scopedKey(userId, key);
                // Copy only into an EMPTY slot — a value the user set since
                // scoping landed always wins over the pre-scoping leftover.
                if (readDeviceItem(scoped) === null) writeDeviceItem(scoped, bare);
                // Drop the bare key only once the scoped slot really holds a
                // value: writeDeviceItem swallows a throwing setItem (full
                // quota, read-only private mode), and deleting first would
                // destroy the only copy of the preference. In that state the
                // version marker can't persist either, so the pass simply
                // retries the move on the next start.
                if (readDeviceItem(scoped) !== null) removeDeviceItem(key);
            }
        }
        for (const key of RETIRED_USER_KEYS) removeDeviceItem(scopedKey(userId, key));
    }
    // v2, v3, … append here.
}

/**
 * Per-user pass. Call right after scopedStorage.setCurrentUser(userId) once
 * whoami has resolved. Once per user per schema version: the marker lives in
 * the user's scoped namespace, so logout's clearUser removes it and a later
 * login simply re-runs the (by then no-op) ladder.
 */
export function runUserStorageMigrations(userId) {
    if (!userId) return;
    try {
        const markerKey = scopedKey(userId, USER_SCHEMA_KEY);
        const from = readSchemaVersion(markerKey);
        if (from !== STORAGE_SCHEMA_VERSION) {
            applyUserMigrations(userId, from);
            writeDeviceItem(markerKey, String(STORAGE_SCHEMA_VERSION));
        }
    } catch { /* never take the app down over storage */ }
}

export default {
    STORAGE_SCHEMA_VERSION,
    DEVICE_SCHEMA_KEY,
    I18N_CACHE_PREFIX,
    I18N_LOCALES_CACHE_KEY,
    ICONPACK_CACHE_PREFIX,
    readDeviceItem,
    writeDeviceItem,
    removeDeviceItem,
    readDeviceJSON,
    buildStampedCacheKey,
    sweepStaleBuildCaches,
    runStorageMigrations,
    runUserStorageMigrations,
};
