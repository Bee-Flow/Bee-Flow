// @typecheck
/**
 * Google Meet → Meeting Notes settings (org + user dual scope).
 *
 * Mirrors `talkNotesSettings.js`: an org-level config doc and a user-level
 * config doc, resolved with the ORG value winning per scalar field, falling
 * back to the user value, then a built-in default. Stored via configStore
 * under:
 *   - org_gmeet_notes_${orgId}
 *   - user_gmeet_notes_${userId}
 *
 * Fields:
 *   - autoImport             background-import recordings of the user's Meet meetings
 *   - autoRecordConfig       pre-set auto-recording on meetings the user organizes
 *                            (spaces.patch — needs the meetings.space.settings scope)
 *   - importScope            'organizer' (only meetings the user organizes) |
 *                            'calendar' (any calendar meeting with a Meet link)
 *   - language               default transcription language for auto-ingest
 *   - lookbackHours          how far back the poller scans for ended meetings
 *   - excludedEventIds[]     LEGACY — moved to `stores/meetingPrefsStore` (M5)
 *   - excludedMeetingCodes[] LEGACY — moved to `stores/meetingPrefsStore` (M5)
 *
 * Scalar toggles use org-overrides-user.
 *
 * ── DE UITSLUITINGEN ZIJN VERHUISD (M5) ───────────────────────────────
 * Zelfde verhuizing als in talkNotesSettings.js: de per-vergadering
 * import-/opnamekeuze woont nu in `stores/meetingPrefsStore` (meeting_prefs),
 * met een driewaardige `record`, een rij per gebruiker en de 1-op-1-standaard.
 * `resolveGmeetNotesSettings` geeft de twee arrays daarom NIET meer terug — een
 * achtergebleven lezer zou een lege lijst zien en dus importeren wat iemand had
 * uitgezet. De velden blijven bewaard en round-trippen ongemoeid door
 * save*Settings, zodat een rollback ze nog vindt.
 */

const configStore = require('../../stores/configStore');

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

function scopeSet(scopeString) {
    return new Set(String(scopeString || '').split(/\s+/).filter(Boolean));
}

/** True when the stored OAuth scope string grants Meet read access (exact match). */
function hasMeetScopes(scopeString) { return scopeSet(scopeString).has(SCOPE_MEET_READONLY); }

/** True when the stored OAuth scope string grants Meet space settings (spaces.patch). */
function hasSettingsScope(scopeString) { return scopeSet(scopeString).has(SCOPE_MEET_SETTINGS); }

/**
 * Derive the connection status block shared by GET /api/gmeet-notes-settings/user/me
 * and GET /api/transcriptions/gmeet-meetings. Connected = live Google session
 * OR an 'active' vault credential; scopes come from the stored credential's
 * scope string — live-session-only users without a vault row have an unknown
 * scope, reported as false so the UI hints a (re)connect.
 */
function deriveConnectionStatus({ session = null, credential = null } = {}) {
    const liveGoogle = !!(session && session.oauthProvider === 'google' && session.accessToken);
    const activeCred = !!(credential && credential.status === 'active');
    return {
        googleConnected: liveGoogle || activeCred,
        meetScopesGranted: hasMeetScopes(credential ? credential.scope : null),
        hasSettingsScope: hasSettingsScope(credential ? credential.scope : null),
        needsReauth: !!(credential && credential.status === 'needs_reauth'),
    };
}

function orgKey(orgId) { return `org_gmeet_notes_${orgId}`; }
function userKey(userId) { return `user_gmeet_notes_${userId}`; }

function asImportScope(v) { return v === 'calendar' ? 'calendar' : 'organizer'; }
function asLanguage(v) { return (typeof v === 'string' && v.trim()) ? v.trim() : 'nl'; }
function asLookback(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULTS.lookbackHours;
    return Math.min(Math.max(Math.round(n), 1), 168);
}
function asStrArray(v) { return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []; }

/**
 * Resolve effective settings. Org value wins per scalar field, else user, else
 * default. Exclusion arrays are the union of org + user.
 */
async function resolveGmeetNotesSettings({ orgId = null, userId = null } = {}) {
    const org = orgId ? await configStore.getConfig(orgKey(orgId)).catch(() => null) : null;
    const user = userId ? await configStore.getConfig(userKey(userId)).catch(() => null) : null;
    // `null` = "no opinion — inherit". Without it the documented user fallback
    // was dead code: sanitizePatch coerces every field, so an org doc always
    // carried every key and `k in org` was always true. An admin who merely
    // opened the org settings page silently overrode every member's own choice
    // with the form defaults, with no way to hand a setting back.
    const has = (doc, k) => doc && k in doc && doc[k] !== null && doc[k] !== undefined;
    const pick = (k) => has(org, k) ? org[k]
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

async function getOrgSettings(orgId) {
    const stored = orgId ? await configStore.getConfig(orgKey(orgId)) : null;
    return { ...DEFAULTS, ...(stored || {}) };
}

async function getUserSettings(userId) {
    const stored = userId ? await configStore.getConfig(userKey(userId)) : null;
    return { ...DEFAULTS, ...(stored || {}) };
}

/**
 * An explicit `null` stores `null` — the "inherit" state resolve reads. A field
 * that is simply ABSENT keeps the old coercion, so an existing client posting a
 * partial body behaves exactly as before and only a caller that deliberately
 * sends null opts in.
 */
function orNull(value, coerce) {
    return value === null ? null : coerce(value);
}

function sanitizePatch(patch) {
    return {
        autoImport: orNull(patch.autoImport, v => !!v),
        autoRecordConfig: orNull(patch.autoRecordConfig, v => !!v),
        importScope: orNull(patch.importScope, asImportScope),
        language: orNull(patch.language, asLanguage),
        lookbackHours: orNull(patch.lookbackHours, asLookback),
        excludedEventIds: asStrArray(patch.excludedEventIds),
        excludedMeetingCodes: asStrArray(patch.excludedMeetingCodes),
    };
}

async function saveOrgSettings(orgId, patch, updatedBy) {
    const config = {
        ...sanitizePatch(patch),
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy || null,
    };
    await configStore.setConfig(orgKey(orgId), config);
    return config;
}

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
