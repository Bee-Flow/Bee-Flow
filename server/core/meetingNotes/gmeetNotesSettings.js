// @typecheck strict
/**
 * Google Meet → Meeting Notes settings (org + user dual scope).
 *
 * Mirrors `talkNotesSettings.js`: an org-level config document and a user-level
 * config document, resolved with the ORG value winning per scalar field, falling
 * back to the user value, then a built-in default. Stored via configStore
 * under:
 *   - org_gmeet_notes_${orgId}
 *   - user_gmeet_notes_${userId}
 *
 * Fields:
 *   - autoImport             background-import recordings of the user's Meet meetings
 *   - autoRecordConfig       pre-set auto-recording on meetings the user organizes
 *                            (spaces.patch: needs the meetings.space.settings scope)
 *   - importScope            'organizer' (only meetings the user organizes) |
 *                            'calendar' (any calendar meeting with a Meet link)
 *   - language               default transcription language for auto-ingest
 *   - lookbackHours          how far back the poller scans for ended meetings
 *   - excludedEventIds[]     LEGACY: moved to `stores/meetingPrefsStore` (M5)
 *   - excludedMeetingCodes[] LEGACY: moved to `stores/meetingPrefsStore` (M5)
 *
 * Scalar toggles use org-overrides-user.
 *
 * ── THE EXCLUSIONS HAVE MOVED (M5) ───────────────────────────────────
 * The same move as in talkNotesSettings.js: the per-meeting import/recording choice now lives in
 * `stores/meetingPrefsStore` (meeting_prefs), with a three-valued `record`, one row per user and the
 * 1-on-1 default. `resolveGmeetNotesSettings` therefore NO LONGER returns the two arrays: a lagging
 * reader would see an empty list and thus import what someone had switched off. The fields remain
 * stored and round-trip untouched through save*Settings, so that a rollback still finds them.
 */

const configStore = require('../../stores/configStore');
const { fallback } = require('../../utils/bestEffort');

/**
 * @type {{ autoImport: boolean, autoRecordConfig: boolean, importScope: string, language: string,
 *   lookbackHours: number, excludedEventIds: string[], excludedMeetingCodes: string[] }}
 */
const DEFAULTS = {
    autoImport: false,
    autoRecordConfig: false,
    importScope: 'organizer',      // 'organizer' | 'calendar'
    language: 'nl',
    lookbackHours: 24,
    excludedEventIds: [],
    excludedMeetingCodes: [],
};

// Google Meet REST API scopes (see server/auth/permissions.js OAUTH_PROVIDERS).
const SCOPE_MEET_READONLY = 'https://www.googleapis.com/auth/meetings.space.readonly';
const SCOPE_MEET_SETTINGS = 'https://www.googleapis.com/auth/meetings.space.settings';

/** @param {string | null | undefined} scopeString */
function scopeSet(scopeString) {
    return new Set(String(scopeString || '').split(/\s+/).filter(Boolean));
}

/**
 * True when the stored OAuth scope string grants Meet read access (exact match).
 * @param {string | null | undefined} scopeString
 */
function hasMeetScopes(scopeString) { return scopeSet(scopeString).has(SCOPE_MEET_READONLY); }

/**
 * True when the stored OAuth scope string grants Meet space settings (spaces.patch).
 * @param {string | null | undefined} scopeString
 */
function hasSettingsScope(scopeString) { return scopeSet(scopeString).has(SCOPE_MEET_SETTINGS); }

/**
 * Derive the connection status block shared by GET /api/gmeet-notes-settings/user/me
 * and GET /api/transcriptions/gmeet-meetings. Connected = live Google session
 * OR an 'active' vault credential; scopes come from the stored credential's
 * scope string — live-session-only users without a vault row have an unknown
 * scope, reported as false so the UI hints a (re)connect.
 *
 * `googleConfigured` is whether the installation has a Google OAuth client at
 * all (auth/googleOAuthConfig.isGoogleConfigured, resolved by the
 * caller): without one, "connect Google" is advice nobody can follow, so the
 * UI stays silent. Not passed reads as false. Only the boolean is returned,
 * never the client id or secret.
 * @param {{ session?: Express.Session | null,
 *   credential?: { status?: string, scope?: string | null } | null,
 *   googleConfigured?: boolean }} [opts]
 */
function deriveConnectionStatus({ session = null, credential = null, googleConfigured = false } = {}) {
    const liveGoogle = !!(session && session.oauthProvider === 'google' && session.accessToken);
    const activeCred = !!(credential && credential.status === 'active');
    return {
        googleConfigured: googleConfigured === true,
        googleConnected: liveGoogle || activeCred,
        meetScopesGranted: hasMeetScopes(credential ? credential.scope : null),
        hasSettingsScope: hasSettingsScope(credential ? credential.scope : null),
        needsReauth: !!(credential && credential.status === 'needs_reauth'),
    };
}

/** @param {string} orgId */
function orgKey(orgId) { return `org_gmeet_notes_${orgId}`; }
/** @param {string} userId */
function userKey(userId) { return `user_gmeet_notes_${userId}`; }

/** @param {unknown} v */
function asImportScope(v) { return v === 'calendar' ? 'calendar' : 'organizer'; }
/** @param {unknown} v */
function asLanguage(v) { return (typeof v === 'string' && v.trim()) ? v.trim() : 'nl'; }
/** @param {unknown} v */
function asLookback(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULTS.lookbackHours;
    return Math.min(Math.max(Math.round(n), 1), 168);
}
// The fields a member may set for themselves (an org value overrides them).
const MEMBER_FIELDS = ['autoImport', 'autoRecordConfig', 'importScope', 'language', 'lookbackHours'];

/** @param {unknown} v */
function asStrArray(v) { return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []; }

/**
 * Resolve effective settings. Org value wins per scalar field, else user, else
 * default. Exclusion arrays are the union of org + user.
 * @param {{ orgId?: string | null, userId?: string | null }} [opts]
 */
async function resolveGmeetNotesSettings({ orgId = null, userId = null } = {}) {
    const org = orgId ? await configStore.getConfig(orgKey(orgId)).catch((e) => fallback('core/meetingNotes/gmeetNotesSettings:resolveGmeetNotesSettings', e, null)) : null;
    const user = userId ? await configStore.getConfig(userKey(userId)).catch((e) => fallback('core/meetingNotes/gmeetNotesSettings:resolveGmeetNotesSettings#2', e, null)) : null;
    // `null` = "no opinion — inherit". Without it the documented user fallback
    // was dead code: sanitizePatch coerces every field, so an org doc always
    // carried every key and `k in org` was always true. An admin who merely
    // opened the org settings page silently overrode every member's own choice
    // with the form defaults, with no way to hand a setting back.
    const has = (/** @type {Record<string, unknown> | null} */ doc, /** @type {string} */ k) => doc && k in doc && doc[k] !== null && doc[k] !== undefined;
    const pick = (/** @type {keyof typeof DEFAULTS} */ k) => has(org, k) ? org[k]
        : has(user, k) ? user[k]
        : DEFAULTS[k];
    return {
        autoImport: !!pick('autoImport'),
        autoRecordConfig: !!pick('autoRecordConfig'),
        importScope: asImportScope(pick('importScope')),
        language: asLanguage(pick('language')),
        lookbackHours: asLookback(pick('lookbackHours')),
        // GEEN excludedEventIds/excludedMeetingCodes meer — zie de kop. De
        // per-vergadering keuze komt uit meetingPrefsStore.
    };
}

/**
 * The org document as stored, for the admin screen: a member-overridable field
 * the org never set is `null` ("no opinion, each member decides"), NOT the
 * default. Merging the defaults in made every field look set, the admin form
 * posted them all back, and one Save pinned every member's own choice to the
 * defaults.
 * @param {string} orgId
 */
async function getOrgSettings(orgId) {
    const stored = orgId ? await configStore.getConfig(orgKey(orgId)) : null;
    const doc = stored || {};
    /** @type {Record<string, unknown>} */
    const out = { ...DEFAULTS, ...doc };
    for (const k of MEMBER_FIELDS) out[k] = doc[k] ?? null;
    return out;
}

/** @param {string} userId */
async function getUserSettings(userId) {
    const stored = userId ? await configStore.getConfig(userKey(userId)) : null;
    return { ...DEFAULTS, ...(stored || {}) };
}

/**
 * An explicit `null` stores `null` — the "inherit" state resolve reads. A field
 * that is simply ABSENT keeps the coercion on the USER document; on the ORG
 * document it is `null` too (`absentIsNull`), so an admin save that leaves a
 * field out hands it back to the members instead of pinning the default.
 * @template T, R
 * @param {T | null} value
 * @param {(v: T) => R} coerce
 */
function orNull(value, coerce) {
    return value === null ? null : coerce(value);
}

/**
 * @param {Record<string, unknown>} patch
 * @param {{ absentIsNull?: boolean }} [opts]
 */
function sanitizePatch(patch, { absentIsNull = false } = {}) {
    const field = (/** @type {unknown} */ v) => (absentIsNull && v === undefined ? null : v);
    return {
        autoImport: orNull(field(patch.autoImport), (/** @type {unknown} */ v) => !!v),
        autoRecordConfig: orNull(field(patch.autoRecordConfig), (/** @type {unknown} */ v) => !!v),
        importScope: orNull(field(patch.importScope), asImportScope),
        language: orNull(field(patch.language), asLanguage),
        lookbackHours: orNull(field(patch.lookbackHours), asLookback),
        excludedEventIds: asStrArray(patch.excludedEventIds),
        excludedMeetingCodes: asStrArray(patch.excludedMeetingCodes),
    };
}

/**
 * @param {string} orgId
 * @param {Record<string, unknown>} patch
 * @param {string | null} [updatedBy]
 */
async function saveOrgSettings(orgId, patch, updatedBy) {
    const config = {
        ...sanitizePatch(patch, { absentIsNull: true }),
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy || null,
    };
    await configStore.setConfig(orgKey(orgId), config);
    return config;
}

/**
 * @param {string} userId
 * @param {Record<string, unknown>} patch
 */
async function saveUserSettings(userId, patch) {
    const config = {
        ...sanitizePatch(patch),
        updatedAt: new Date().toISOString(),
        updatedBy: userId,
    };
    await configStore.setConfig(userKey(userId), config);
    return config;
}

module.exports = {
    DEFAULTS,
    SCOPE_MEET_READONLY,
    SCOPE_MEET_SETTINGS,
    hasMeetScopes,
    hasSettingsScope,
    deriveConnectionStatus,
    resolveGmeetNotesSettings,
    getOrgSettings,
    getUserSettings,
    saveOrgSettings,
    saveUserSettings,
};
