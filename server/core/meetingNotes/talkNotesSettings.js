// @typecheck
/**
 * Nextcloud Talk → Meeting Notes settings (org + user dual scope).
 *
 * Mirrors the privacy-shield pattern (`server/core/orgShield.js`): an org-level
 * config doc and a user-level config doc, resolved with the ORG value winning
 * per scalar field, falling back to the user value, then a built-in default.
 * Stored via configStore under:
 *   - org_talk_notes_${orgId}
 *   - user_talk_notes_${userId}
 *
 * Fields:
 *   - autoTranscribe       when a new Talk recording appears, auto-create a note
 *   - postSummaryBack      post the summary + action items back into the Talk room
 *   - recordingFolder      the Nextcloud Files folder Talk saves recordings to
 *   - language             default transcription language for auto-ingest
 *   - autoRecord           automatically START recording the user's active Talk calls
 *   - autoRecordScope      'calendar' (only scheduled meetings) | 'all' (any moderated call)
 *   - recordingMode        'audio' | 'video' — what auto-record captures
 *   - excludedEventUids[]  LEGACY — moved to `stores/meetingPrefsStore` (M5)
 *   - excludedRoomTokens[] LEGACY — moved to `stores/meetingPrefsStore` (M5)
 *   - defaultOwnerUserId   (org only) fallback note owner when the recording's
 *                          actor can't be mapped to a Bee Flow user (bot actor)
 *   - insightsPerPersonStats (org only) whether the meeting Insights panel may
 *                          show per-person statistics (talk time, longest
 *                          monologue). Off → viewers see only meeting-level
 *                          metrics. Org policy, not a user preference: it
 *                          governs what OTHERS see about you.
 *
 * Scalar toggles use org-overrides-user.
 *
 * ── EXCLUSIONS HAVE MOVED (M5) ───────────────────────────────────────
 * `excludedEventUids` and `excludedRoomTokens` were the per-meeting recording
 * choice: presence meant "do not record". That choice now lives in
 * `stores/meetingPrefsStore` (table meeting_prefs), with a three-valued
 * `record`, its own row per user and the 1-on-1 default. Therefore
 * `resolveTalkNotesSettings` NO LONGER returns those two arrays: a reader that
 * was still hanging on here would see an empty list and so record what someone
 * had switched off.
 *
 * The fields themselves are still kept, and round-trip untouched through
 * save*Settings, so a rollback to the previous image still finds the exclusions.
 * `meetingPrefsStore.backfillFromExclusions()` has taken them over once.
 */

const configStore = require('../../stores/configStore');
const { DEFAULT_RECORDING_FOLDER } = require('./talkRecordingPaths');
const { fallback } = require('../../utils/bestEffort');

const DEFAULTS = {
    autoTranscribe: false,
    postSummaryBack: false,
    // Talk writes to `<attachmentFolder>/Recording/<token>/`, so the default is
    // /Talk/Recording — NOT /Talk. See talkRecordingPaths.js for the upstream
    // sources. Tenants whose stored setting is still `/Talk` keep working:
    // `talkRecordingRoots()` probes the `Recording` subfolder either way.
    recordingFolder: DEFAULT_RECORDING_FOLDER,
    language: 'nl',
    autoRecord: false,
    autoRecordScope: 'calendar',   // 'calendar' | 'all'
    recordingMode: 'audio',        // 'audio' | 'video'
    excludedEventUids: [],
    excludedRoomTokens: [],
    defaultOwnerUserId: null,
    insightsPerPersonStats: true,
};

function orgKey(orgId) { return `org_talk_notes_${orgId}`; }
function userKey(userId) { return `user_talk_notes_${userId}`; }

function asScope(v) { return v === 'all' ? 'all' : 'calendar'; }
function asMode(v) { return v === 'video' ? 'video' : 'audio'; }
function asStrArray(v) { return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : []; }

/**
 * Resolve effective settings. Org value wins per scalar field, else user, else
 * default. Exclusion arrays are the union of org + user.
 *
 * `null` means "no opinion — inherit". Without that third state the documented
 * user fallback was dead code: `saveOrgSettings` coerced every field
 * (`!!patch.x`, `patch.language || 'nl'`), so an org doc always carried every
 * key and `k in org` was always true. An admin who merely opened the org
 * settings page silently overrode every member's own choice with the form
 * defaults — and there was no way to hand a setting back.
 */
async function resolveTalkNotesSettings(/** @type {{ orgId?: string | null, userId?: string | null }} */ { orgId = null, userId = null } = {}) {
    const org = orgId ? await configStore.getConfig(orgKey(orgId)).catch((e) => fallback('core/meetingNotes/talkNotesSettings:resolveTalkNotesSettings', e, null)) : null;
    const user = userId ? await configStore.getConfig(userKey(userId)).catch((e) => fallback('core/meetingNotes/talkNotesSettings:resolveTalkNotesSettings#2', e, null)) : null;
    const has = (doc, k) => doc && k in doc && doc[k] !== null && doc[k] !== undefined;
    const pick = (k) => has(org, k) ? org[k]
        : has(user, k) ? user[k]
        : DEFAULTS[k];
    return {
        autoTranscribe: !!pick('autoTranscribe'),
        postSummaryBack: !!pick('postSummaryBack'),
        recordingFolder: (pick('recordingFolder') || DEFAULT_RECORDING_FOLDER).trim() || DEFAULT_RECORDING_FOLDER,
        language: pick('language') || 'nl',
        autoRecord: !!pick('autoRecord'),
        autoRecordScope: asScope(pick('autoRecordScope')),
        recordingMode: asMode(pick('recordingMode')),
        // GEEN excludedEventUids/excludedRoomTokens meer — zie de kop. De
        // per-vergadering keuze komt uit meetingPrefsStore.
        // defaultOwnerUserId and insightsPerPersonStats are org-only concepts.
        defaultOwnerUserId: (org && org.defaultOwnerUserId) || null,
        insightsPerPersonStats: org ? org.insightsPerPersonStats !== false : true,
    };
}

async function getOrgSettings(orgId) {
    const stored = orgId ? await configStore.getConfig(orgKey(orgId)) : null;
    return { ...DEFAULTS, ...(stored || {}) };
}

async function getUserSettings(userId) {
    const stored = userId ? await configStore.getConfig(userKey(userId)) : null;
    // defaultOwnerUserId / insightsPerPersonStats are org-only; don't surface
    // them on the user doc.
    const { defaultOwnerUserId, insightsPerPersonStats, ...userDefaults } = DEFAULTS;
    return { ...userDefaults, ...(stored || {}) };
}

function sanitizeFolder(folder) {
    const cleaned = '/' + String(folder || DEFAULT_RECORDING_FOLDER).split('/').filter(Boolean).join('/');
    return cleaned === '/' ? DEFAULT_RECORDING_FOLDER : cleaned;
}

/**
 * An explicit `null` in the patch stores `null` — "inherit", the third state
 * resolveTalkNotesSettings reads. A field that is simply ABSENT keeps the old
 * coercion, so an existing client that posts a partial body behaves exactly as
 * before and only a caller that deliberately sends null opts in.
 */
function orNull(value, coerce) {
    return value === null ? null : coerce(value);
}

async function saveOrgSettings(orgId, patch, updatedBy) {
    const config = {
        autoTranscribe: orNull(patch.autoTranscribe, v => !!v),
        postSummaryBack: orNull(patch.postSummaryBack, v => !!v),
        recordingFolder: orNull(patch.recordingFolder, sanitizeFolder),
        language: orNull(patch.language, v => v || 'nl'),
        autoRecord: orNull(patch.autoRecord, v => !!v),
        autoRecordScope: orNull(patch.autoRecordScope, asScope),
        recordingMode: orNull(patch.recordingMode, asMode),
        excludedEventUids: asStrArray(patch.excludedEventUids),
        excludedRoomTokens: asStrArray(patch.excludedRoomTokens),
        defaultOwnerUserId: patch.defaultOwnerUserId || null,
        insightsPerPersonStats: patch.insightsPerPersonStats !== false,
        updatedAt: new Date().toISOString(),
        updatedBy: updatedBy || null,
    };
    await configStore.setConfig(orgKey(orgId), config);
    return config;
}

async function saveUserSettings(userId, patch) {
    const config = {
        autoTranscribe: !!patch.autoTranscribe,
        postSummaryBack: !!patch.postSummaryBack,
        recordingFolder: sanitizeFolder(patch.recordingFolder),
        language: patch.language || 'nl',
        autoRecord: !!patch.autoRecord,
        autoRecordScope: asScope(patch.autoRecordScope),
        recordingMode: asMode(patch.recordingMode),
        excludedEventUids: asStrArray(patch.excludedEventUids),
        excludedRoomTokens: asStrArray(patch.excludedRoomTokens),
        updatedAt: new Date().toISOString(),
        updatedBy: userId,
    };
    await configStore.setConfig(userKey(userId), config);
    return config;
}

module.exports = {
    DEFAULTS,
    resolveTalkNotesSettings,
    getOrgSettings,
    getUserSettings,
    saveOrgSettings,
    saveUserSettings,
};

/**
 * @typedef {{ autoTranscribe: boolean, postSummaryBack: boolean, recordingFolder: string, language: string,
 *   autoRecord: boolean, autoRecordScope: string, recordingMode: string, excludedEventUids: string[],
 *   excludedRoomTokens: string[], defaultOwnerUserId: string | null, insightsPerPersonStats: boolean }} TalkNotesDefaults
 */

/**
 * A settings patch from the API body; every field may be absent or an explicit null ("inherit").
 * @typedef {{ autoTranscribe?: boolean | null, postSummaryBack?: boolean | null, recordingFolder?: string | null,
 *   language?: string | null, autoRecord?: boolean | null, autoRecordScope?: string | null, recordingMode?: string | null,
 *   excludedEventUids?: unknown, excludedRoomTokens?: unknown, defaultOwnerUserId?: string | null,
 *   insightsPerPersonStats?: boolean | null }} TalkNotesPatch
 */

/**
 * @typedef {Object} ResolveTalkNotesSettingsArgs
 * @property {string | null} [orgId]
 * @property {string | null} [userId]
 */
