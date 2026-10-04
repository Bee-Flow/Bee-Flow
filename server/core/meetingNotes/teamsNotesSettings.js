// @typecheck
/**
 * Microsoft Teams → Meeting Notes settings (org + user dual scope).
 *
 * Same model as `gmeetNotesSettings.js`: an org document and a user document in
 * configStore, the org value winning per field when it has one (`null` = no
 * opinion, inherit), then the user value, then the default.
 *   - org_teams_notes_${orgId}
 *   - user_teams_notes_${userId}
 *
 * Fields:
 *   - autoImport        background-import recordings of Teams meetings the user organizes
 *   - autoRecordConfig  switch on Teams' own "record automatically" for a meeting
 *                       when the user turns recording on for it
 *   - language          transcription language for auto-ingest
 *   - lookbackHours     how far back the poller scans for ended meetings
 *
 * There is no import scope: Graph only hands recordings and transcripts to
 * the organizer under delegated permissions, so every Teams import is the
 * organizer's.
 */

const { lazyDeps } = require('./lazyDeps');

/** Collaborators; tests swap them through init(). */
const { deps, init } = lazyDeps({
    configStore: () => require('../../stores/configStore'),
});

const DEFAULTS = Object.freeze({
    autoImport: false,
    autoRecordConfig: false,
    language: 'nl',
    lookbackHours: 24,
});

// Graph permissions Teams import needs (see MICROSOFT_SCOPES in auth/permissions.js).
const SCOPE_RECORDINGS = 'OnlineMeetingRecording.Read.All';
const SCOPE_TRANSCRIPTS = 'OnlineMeetingTranscript.Read.All';
const SCOPE_MEETINGS_WRITE = 'OnlineMeetings.ReadWrite';
const SCOPE_CALENDAR = 'Calendars.ReadWrite';

// Microsoft returns scopes either bare (`Calendars.ReadWrite`) or as full
// resource URIs (`https://graph.microsoft.com/Calendars.ReadWrite`); compare
// on the last path segment, case-insensitively.
function scopeSet(scopeString) {
    return new Set(String(scopeString || '').split(/\s+/).filter(Boolean)
        .map(s => s.slice(s.lastIndexOf('/') + 1).toLowerCase()));
}

/** True when the granted scopes allow reading calendar + recordings. */
function hasTeamsScopes(scopeString) {
    const set = scopeSet(scopeString);
    return set.has(SCOPE_RECORDINGS.toLowerCase()) && set.has(SCOPE_CALENDAR.toLowerCase());
}

/** True when the granted scopes allow PATCHing recordAutomatically. */
function hasMeetingWriteScope(scopeString) {
    return scopeSet(scopeString).has(SCOPE_MEETINGS_WRITE.toLowerCase());
}

/** True when the granted scopes allow the transcript fallback. */
function hasTranscriptScope(scopeString) {
    return scopeSet(scopeString).has(SCOPE_TRANSCRIPTS.toLowerCase());
}

/**
 * Connection status block shared by the settings GET and /teams-meetings.
 * Connected = live Microsoft session OR an 'active' vault credential. The
 * scope flags come from the stored credential; a live SSO session without a
 * vault row reports its own `oauthScope` when the session carries one.
 */
function deriveConnectionStatus({ session = null, credential = null } = {}) {
    const liveMicrosoft = !!(session && session.oauthProvider === 'microsoft' && session.accessToken);
    const activeCred = !!(credential && credential.status === 'active');
    const scope = credential?.scope || (liveMicrosoft ? session.oauthScope : null) || null;
    return {
        microsoftConnected: liveMicrosoft || activeCred,
        teamsScopesGranted: hasTeamsScopes(scope),
        hasMeetingWriteScope: hasMeetingWriteScope(scope),
        hasTranscriptScope: hasTranscriptScope(scope),
        needsReauth: !!(credential && credential.status === 'needs_reauth'),
    };
}

function orgKey(orgId) { return `org_teams_notes_${orgId}`; }
function userKey(userId) { return `user_teams_notes_${userId}`; }

function asLanguage(v) { return (typeof v === 'string' && v.trim()) ? v.trim() : DEFAULTS.language; }
function asLookback(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULTS.lookbackHours;
    return Math.min(Math.max(Math.round(n), 1), 168);
}

/** Effective settings: org value per field, else user, else default. */
async function resolveTeamsNotesSettings({ orgId = null, userId = null } = {}) {
    const org = orgId ? await deps.configStore.getConfig(orgKey(orgId)).catch(() => null) : null;
    const user = userId ? await deps.configStore.getConfig(userKey(userId)).catch(() => null) : null;
    const has = (doc, k) => doc && k in doc && doc[k] !== null && doc[k] !== undefined;
    const pick = (k) => has(org, k) ? org[k] : has(user, k) ? user[k] : DEFAULTS[k];
    return {
        autoImport: !!pick('autoImport'),
        autoRecordConfig: !!pick('autoRecordConfig'),
        language: asLanguage(pick('language')),
        lookbackHours: asLookback(pick('lookbackHours')),
    };
}

async function getOrgSettings(orgId) {
    const stored = orgId ? await deps.configStore.getConfig(orgKey(orgId)) : null;
    return { ...DEFAULTS, ...(stored || {}) };
}

async function getUserSettings(userId) {
    const stored = userId ? await deps.configStore.getConfig(userKey(userId)) : null;
    return { ...DEFAULTS, ...(stored || {}) };
}

// An explicit null stores null (inherit); an absent field takes the coercion.
function orNull(value, coerce) { return value === null ? null : coerce(value); }

function sanitizePatch(patch) {
    return {
        autoImport: orNull(patch.autoImport, v => !!v),
        autoRecordConfig: orNull(patch.autoRecordConfig, v => !!v),
        language: orNull(patch.language, asLanguage),
        lookbackHours: orNull(patch.lookbackHours, asLookback),
    };
}

async function saveOrgSettings(orgId, patch, updatedBy) {
    const config = { ...sanitizePatch(patch), updatedAt: new Date().toISOString(), updatedBy: updatedBy || null };
    await deps.configStore.setConfig(orgKey(orgId), config);
    return config;
}

async function saveUserSettings(userId, patch) {
    const config = { ...sanitizePatch(patch), updatedAt: new Date().toISOString(), updatedBy: userId };
    await deps.configStore.setConfig(userKey(userId), config);
    return config;
}

module.exports = {
    init,
    DEFAULTS,
    hasTeamsScopes,
    hasMeetingWriteScope,
    hasTranscriptScope,
    deriveConnectionStatus,
    resolveTeamsNotesSettings,
    getOrgSettings,
    getUserSettings,
    saveOrgSettings,
    saveUserSettings,
};
