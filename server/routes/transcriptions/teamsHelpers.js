// @typecheck strict
/**
 * The Teams routes' collaborators (routes/transcriptions/teams.js) and the
 * Graph-facing helpers behind them: the caller's Microsoft session and its
 * connection flags, the reconnect state of a dead grant, a session copy for
 * background work, Teams' own auto-record flag and a meeting's recording state.
 */

const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const { lazyDeps } = require('../../core/meetingNotes/lazyDeps');
const { fallback: fallbackSwallowed } = require('../../utils/bestEffort');
const { sessionUser } = require('../../core/http/sessionUser');

/** @typedef {import('../../integrations/msGraphClient').MsSession} MsSession */

/** Collaborators, loaded on first use; tests swap them through `router.init()`. */
const { deps: d, init } = lazyDeps({
    permissions: () => require('../../auth/permissions'),
    shared: () => require('./shared'),
    settings: () => require('../../core/meetingNotes/teamsNotesSettings'),
    calendar: () => require('../../core/meetingNotes/teamsCalendar'),
    artifacts: () => require('../../core/meetingNotes/teamsArtifacts'),
    autoImport: () => require('../../core/meetingNotes/teamsAutoImport'),
    importStore: () => require('../../stores/teamsImportStore'),
    importRunner: () => require('../../core/meetingNotes/manualImportRunner'),
    meetingPrefs: () => require('../../stores/meetingPrefsStore'),
    credentialStore: () => require('../../stores/automationCredentialStore'),
    resolveMicrosoftSession: () => require('../../auth/microsoftSessionHydration').resolveMicrosoftSession,
    transcriptions: () => require('../../stores/transcriptionStore'),
});

/**
 * The caller's Microsoft session (live SSO session or vault shim) plus the
 * connection block the UI renders its connect/reconnect prompts from.
 * @param {import('express').Request} req
 */
async function resolveTeamsSession(req) {
    const userId = sessionUser(req).id;
    let credential = null;
    try {
        credential = await d.credentialStore.getCredential(userId, 'microsoft');
    } catch (err) { fallbackSwallowed('routes/transcriptions/teams:resolveTeamsSession', err); /* vault unavailable → session only */ }
    let connection = d.settings.deriveConnectionStatus({ session: req.session, credential });
    let session = null;
    try {
        // A login session from before the Teams scopes existed gives way to
        // the vault grant the user reconnected to get them: the reconnect
        // only writes the vault while a Microsoft session exists.
        session = await d.resolveMicrosoftSession(req.session, userId, { scopeSatisfies: d.settings.hasTeamsScopes });
    } catch (err) {
        log.warn('[Transcriptions] Microsoft session resolve failed:', /** @type {Error} */ (err).message);
    }
    // The scope flags of the session the Graph calls will actually carry:
    // the vault's grant said "granted" while the live token it does not
    // replace had none of it, and every call then answered 403.
    if (session && session === req.session && typeof session.oauthScope === 'string' && session.oauthScope.trim()) {
        const used = d.settings.deriveConnectionStatus({ session, credential: null });
        connection = {
            ...connection,
            teamsScopesGranted: used.teamsScopesGranted,
            hasMeetingWriteScope: used.hasMeetingWriteScope,
            hasTranscriptScope: used.hasTranscriptScope,
        };
    }
    return { session, connection };
}

/**
 * Graph says the Microsoft grant does not work any more (the access token expired
 * and the refresh token was refused): msGraphClient throws a plain
 * `NOT_CONNECTED`. That is the reconnect state, never a generic 500.
 * @param {unknown} err
 */
function isGrantGone(err) {
    return /** @type {{ message?: unknown }} */ (err)?.message === 'NOT_CONNECTED';
}

/** @param {unknown} err */
function asNeedsReauth(err) {
    return isGrantGone(err)
        ? new HttpError(409, 'needs_reauth', 'Microsoft access expired — reconnect your Microsoft 365 account')
        : err;
}

/**
 * A copy of the session for work that outlives the request. msGraphClient
 * writes refreshed tokens onto the session it is given and calls `save()`; on
 * the live express-session object that write-back re-creates a session the
 * user has since logged out of (its row deleted, its cookie still in the
 * browser). A plain copy carries the tokens and has no `save`. The vault shim
 * is already detached and saves to the vault, so it is used as it is.
 * @param {import('express').Request} req
 * @param {MsSession | null} session
 */
function detachedSession(req, session) {
    if (!session || session !== req.session) return session;
    return { ...session };
}

/**
 * Whether the note an import job points at still exists. A deleted note
 * leaves its job 'ingested' with the old id, and the meeting could then never
 * be imported again. Owner check only (the user made the note), never the
 * super-admin shortcut that answers yes for any id.
 * @param {string | null | undefined} transcriptionId
 * @param {string} userId
 */
async function noteStillExists(transcriptionId, userId) {
    if (!transcriptionId) return false;
    try {
        return await d.transcriptions.canReadTranscription(transcriptionId, userId, { orgIds: [], userGroupIds: [], isSuperAdmin: false });
    } catch (err) {
        fallbackSwallowed('routes/transcriptions/teams:noteStillExists', err);
        return true; // cannot tell: keep the job's answer rather than import twice
    }
}

/**
 * The upcoming meeting `eventId` names, when this user organises it and it has
 * a join link (the handle Graph finds its onlineMeeting by); else null.
 * @param {MsSession} session
 * @param {string} eventId
 */
async function organisedMeeting(session, eventId) {
    const match = (await d.calendar.listUpcomingTeamsMeetings({ session, windowHours: 48 })).find(m => m.eventId === eventId);
    return match && match.organizerSelf && match.joinUrl ? { seriesMasterId: match.seriesMasterId, joinUrl: match.joinUrl } : null;
}

/**
 * Teams' own "record automatically" follows the EFFECTIVE choice, both ways,
 * while the settings say Bee Flow manages it (autoRecordConfig):
 *   - on only when the meeting will really be recorded (an org-wide or
 *     series opt-out that overrides this click must not arm Teams);
 *   - off again when the user switches the meeting off, or Teams keeps
 *     recording it, banner for everyone and all, after the user declined.
 * A recurring meeting shares ONE onlineMeeting across its occurrences, so the
 * flag can only follow a choice that covers the whole series; a single
 * occurrence reports 'series_only' and leaves Teams as it is.
 * Never throws: the outcome is reported, the PATCH itself has succeeded.
 * @param {import('express').Request} req
 * @param {{ orgId: string | null, userId: string, eventId: string, record: boolean, effectiveRecord: boolean, seriesMasterId: string | null, applyToSeries: boolean }} choice
 * @returns {Promise<string>} 'set' (switched on), 'unset' (switched off), or why nothing was changed
 */
async function configureTeamsAutoRecord(req, { orgId, userId, eventId, record, effectiveRecord, seriesMasterId, applyToSeries }) {
    try {
        const settings = await d.settings.resolveTeamsNotesSettings({ orgId, userId });
        if (!settings.autoRecordConfig) return 'skipped';
        const { session, connection } = await resolveTeamsSession(req);
        if (!session) return 'not_connected';
        if (!connection.hasMeetingWriteScope) return 'needs_teams_scopes';
        const match = await organisedMeeting(session, eventId);
        if (!match) return 'not_organizer';
        if ((match.seriesMasterId || seriesMasterId) && !applyToSeries) return 'series_only';
        // Switched on, but an org-wide or series opt-out wins: nothing will be
        // recorded, so Teams is not armed (and a flag the organiser set in
        // Teams is not touched either).
        if (record && !effectiveRecord) return 'overridden';
        const result = await d.artifacts.setRecordAutomatically(session, { joinUrl: match.joinUrl, enabled: effectiveRecord });
        if (!result.ok) return result.error;
        return effectiveRecord ? 'set' : 'unset';
    } catch (err) {
        log.warn('[Transcriptions] teams auto-record config failed:', /** @type {Error} */ (err).message);
        return isGrantGone(err) ? 'needs_reauth' : 'error';
    }
}

/**
 * Whether Teams has a recording or transcript for an ended meeting
 * ('available' | 'transcript_only' | 'processing' | 'none'). Best-effort.
 * @param {MsSession} session
 * @param {{ joinUrl?: string, start?: string | null, end?: string | null }} m
 * @param {{ hasTranscriptScope: boolean }} connection
 */
async function teamsRecordingState(session, m, connection) {
    // Teams needs time to process a recording: inside the import deadline an
    // empty answer means "not ready yet", not "was not recorded".
    const endMs = new Date(m.end || 0).getTime();
    const stillProcessing = Number.isFinite(endMs) && Date.now() <= endMs + d.autoImport.NO_RECORDING_DEADLINE_MS;
    try {
        const meeting = await d.artifacts.getOnlineMeetingByJoinUrl(session, m.joinUrl);
        // No online meeting for this account: nothing will ever appear.
        if (!meeting) return 'none';
        const artifact = await d.autoImport.findArtifact(session, meeting.id,
            { meetingStart: m.start, meetingEnd: m.end },
            { transcriptAllowed: connection.hasTranscriptScope });
        if (artifact) return artifact.kind === 'recording' ? 'available' : 'transcript_only';
    } catch (err) { fallbackSwallowed('routes/transcriptions/teams:anon', err); /* best-effort — keep the default state */ }
    return stillProcessing ? 'processing' : 'none';
}

module.exports = {
    deps: d, init, resolveTeamsSession, isGrantGone, asNeedsReauth, detachedSession, noteStillExists, configureTeamsAutoRecord, teamsRecordingState,
};
