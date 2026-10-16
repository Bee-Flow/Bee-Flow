// @typecheck
/**
 * Microsoft Teams auto-import engine — the Teams sibling of gmeetAutoImport.js.
 *
 * Two phases, both driven from one 120 s tick in
 * `automationRunner/scheduler/ticks.js` (processTeamsAutoImport):
 *
 *   Phase A — discover() (advisory-locked, metadata only): for every opted-in,
 *   entitled user with a Microsoft credential carrying the Teams scopes, list
 *   recently ENDED Teams meetings the user ORGANIZED and seed
 *   `teams_import_jobs` rows. Organizer only: Graph does not give recordings to
 *   attendees under delegated permissions.
 *
 *   Phase B — processDue() (outside the lock; claims are SKIP LOCKED): run each
 *   due job through `processJobInline`, which the manual `/from-teams` route
 *   shares: join URL → onlineMeeting → recording of this occurrence (or, when
 *   there is none, its transcript) → `ingestTeamsMeeting`.
 *
 * Stable failure codes (job `error_code` + API `code`): not_connected,
 * needs_teams_scopes, needs_reauth, not_organizer, no_recording,
 * recording_too_large, transcript_access_disabled, failed.
 */

const { lazyDeps } = require('./lazyDeps');

/**
 * Collaborators, loaded on first use; tests swap them through init(). Each
 * entry is the module or function the code below calls.
 */
const { deps: d, init } = lazyDeps({
    configStore: () => require('../../stores/configStore'),
    teamsImportStore: () => require('../../stores/teamsImportStore'),
    userStore: () => require('../../stores/userStore'),
    meetingPrefs: () => require('../../stores/meetingPrefsStore'),
    recordOptIn: () => require('../../stores/meetingPrefsOptIn'),
    automationAuth: () => require('../../auth/automationAuth'),
    resolveMicrosoftSession: () => require('../../auth/microsoftSessionHydration').resolveMicrosoftSession,
    hasCapability: () => require('../entitlements/entitlements').hasCapability,
    graphFetch: () => require('../integrations/integrationClients').integrationClient('msGraph').graphFetch,
    resolveTeamsNotesSettings: () => require('./teamsNotesSettings').resolveTeamsNotesSettings,
    hasTeamsScopes: () => require('./teamsNotesSettings').hasTeamsScopes,
    hasTranscriptScope: () => require('./teamsNotesSettings').hasTranscriptScope,
    listRecentlyEndedTeamsMeetings: () => require('./teamsCalendar').listRecentlyEndedTeamsMeetings,
    getOnlineMeetingByJoinUrl: () => require('./teamsArtifacts').getOnlineMeetingByJoinUrl,
    listRecordings: () => require('./teamsArtifacts').listRecordings,
    listTranscripts: () => require('./teamsArtifacts').listTranscripts,
    pickArtifactForSlot: () => require('./teamsArtifacts').pickArtifactForSlot,
    ingestTeamsMeeting: () => require('./ingestTeamsRecording').ingestTeamsMeeting,
});

const log = require('../../telemetry/log');
const kit = require('./importJobKit');

const { codedError, backoffMsFor, meetingEndMs } = kit;

// A Teams recording lands in OneDrive/SharePoint shortly after the meeting;
// nothing 24 h after the end means it was not recorded (the common case).
const NO_RECORDING_DEADLINE_MS = 24 * 3600_000;
const INGEST_LEASE_MINUTES = Number(process.env.TEAMS_INGEST_LEASE_MINUTES) || 120;
const MAX_INGEST_ATTEMPTS = 3;
const MAX_USERS_PER_TICK = 100;
const USER_JITTER_MS = 250;

const TERMINAL_CODES = new Set([
    'not_organizer', 'no_recording', 'recording_too_large',
    'transcript_access_disabled', 'speaker_attribution_disabled', 'needs_teams_scopes',
    'empty_transcription',
]);
const QUIET_CODES = new Set(['no_recording', 'not_organizer']);

/** A Microsoft-only session over a vault credential; refreshes write back to the vault. */
async function vaultSession(auth, userId) {
    return d.resolveMicrosoftSession({ automationProviders: { microsoft: auth } }, userId);
}

/**
 * Users with their own Teams settings, plus members of orgs that turned autoImport on,
 * plus users who explicitly marked a meeting "record" (that mark alone is enough).
 */
async function listCandidateUsers() {
    const users = new Set(await kit.listCandidateUsers({
        configStore: d.configStore,
        kind: 'teams_notes',
        resolveSettings: (args) => d.resolveTeamsNotesSettings(args),
        flag: 'autoImport',
        getUserStore: () => d.userStore,
    }));
    try {
        for (const id of await d.recordOptIn.listUsersWithRecordOptIn({ provider: 'teams' })) users.add(id);
    } catch (err) {
        log.warn(`[TeamsAutoImport] record opt-in lookup failed: ${err.message}`);
    }
    return Array.from(users);
}

async function discoverUser(userId) {
    let user = null;
    try { user = await d.userStore.getUser(userId); } catch (err) {
        log.debug(`[TeamsAutoImport] user lookup failed for ${userId}: ${err.message}`);
    }
    // A deleted or deactivated user keeps stale settings and marks; skip them.
    if (!user || (user.status ?? 'active') !== 'active') return;
    const orgId = user.organizationId || null;
    const settings = await d.resolveTeamsNotesSettings({ orgId, userId });
    const meetingPrefs = d.meetingPrefs;
    const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'teams', userId, orgId });
    // With autoImport off only a live, explicit "record" mark imports a meeting
    // (it overrides an org-level off). Without one, stop before anything that
    // refreshes tokens, writes to the database or calls Graph.
    if (!settings.autoImport && !d.recordOptIn.hasLiveRecordOptIn(prefs.rows)) return;

    // The background path bypasses the route gates: check the licence here.
    if (!await d.hasCapability('meeting_notes', { userId, orgId })) return;

    const auth = await d.automationAuth.getProviderAuth(userId, 'microsoft');
    if (!auth || !d.hasTeamsScopes(auth.scope)) return;

    await d.teamsImportStore.unparkForUser(userId)
        .catch((err) => log.warn(`[TeamsAutoImport] unpark failed for user ${userId}: ${err.message}`));

    const session = await vaultSession(auth, userId);
    if (!session) return;

    const ended = await d.listRecentlyEndedTeamsMeetings({ session, lookbackHours: settings.lookbackHours });
    for (const m of ended) {
        if (!m.organizerSelf) continue;
        const decision = prefs.decide({
            ids: meetingPrefs.teamsIds({ eventId: m.eventId, seriesMasterId: m.seriesMasterId }),
            participantCount: meetingPrefs.participantCountOf(m),
            fallback: !!settings.autoImport,
        });
        if (!decision.record) continue;
        await d.teamsImportStore.seedJob({
            userId,
            orgId,
            calendarEventId: m.eventId,
            seriesMasterId: m.seriesMasterId,
            joinUrl: m.joinUrl,
            title: m.title,
            meetingStart: m.start,
            meetingEnd: m.end,
        });
    }
}

/** Phase A: seed jobs from candidates' calendars (caller holds the advisory lock). */
const discover = kit.makeDiscovery({
    label: 'TeamsAutoImport',
    maxUsersPerTick: MAX_USERS_PER_TICK,
    jitterMs: USER_JITTER_MS,
    listCandidateUsers,
    discoverUser,
});

/** Attendees of the job's calendar event (speaker roster + sharing). [] on failure. */
async function fetchEventAttendees(session, job) {
    try {
        const event = await d.graphFetch(`/me/events/${encodeURIComponent(job.calendarEventId)}?$select=attendees`, session);
        return (event?.attendees || []).map(a => ({
            email: a.emailAddress?.address || null,
            displayName: a.emailAddress?.name || null,
        }));
    } catch (err) {
        log.warn(`[TeamsAutoImport] attendee lookup failed for job ${job.id}: ${err.message}`);
        return [];
    }
}

/**
 * The artifact to ingest for this occurrence: its recording, else (when the
 * transcript scope was granted) its transcript, else null. Transcript access
 * switched off by the tenant counts as "no transcript", not as a failure.
 * @returns {Promise<{ kind: 'recording'|'transcript', id: string }|null>}
 */
async function findArtifact(session, meetingId, job, { transcriptAllowed }) {
    const slot = { meetingStart: job.meetingStart, meetingEnd: job.meetingEnd };
    const recording = d.pickArtifactForSlot(await d.listRecordings(session, meetingId), slot);
    if (recording?.id) return { kind: 'recording', id: recording.id };
    if (!transcriptAllowed) return null;
    try {
        const transcript = d.pickArtifactForSlot(await d.listTranscripts(session, meetingId), slot);
        if (transcript?.id) return { kind: 'transcript', id: transcript.id };
    } catch (err) {
        if (err?.code !== 'transcript_access_disabled') throw err;
    }
    return null;
}

// Always throws: classified codes freeze the job; anything else retries up to
// MAX_INGEST_ATTEMPTS, then freezes as 'failed'.
async function failIngest(job, err) {
    return kit.failIngest({
        store: d.teamsImportStore, job, err,
        terminalCodes: TERMINAL_CODES,
        maxAttempts: MAX_INGEST_ATTEMPTS,
        fallbackMessage: 'Teams import failed',
    });
}

/**
 * Shared per-job pipeline (poller + manual route). Returns
 *   { transcription }          note created (or already there)
 *   { pending: true, status }  no artifact yet; the job stays claimable
 * and throws an Error with a stable `.code` for classified failures, after
 * recording the outcome on the job row.
 * @param {{ job: any, session: any, settings?: any, language?: string|null, contextTerms?: string, transcriptAllowed?: boolean, accessCtx?: any }} args
 */
async function processJobInline({ job, session, settings = null, language = null, contextTerms = '', transcriptAllowed = true, accessCtx = undefined }) {
    const effective = settings || await d.resolveTeamsNotesSettings({ orgId: job.orgId, userId: job.userId });

    let meetingId = job.onlineMeetingId;
    let artifact;
    try {
        if (!meetingId) {
            const meeting = await d.getOnlineMeetingByJoinUrl(session, job.joinUrl);
            if (!meeting) throw codedError('Only the organizer of this Teams meeting can import it', 'not_organizer');
            meetingId = meeting.id;
            await d.teamsImportStore.updateJob(job.id, { onlineMeetingId: meetingId });
        }
        artifact = await findArtifact(session, meetingId, job, { transcriptAllowed });
    } catch (err) {
        if (err?.code && TERMINAL_CODES.has(err.code)) {
            await d.teamsImportStore.failJob(job.id, { errorCode: err.code, terminal: true, lastError: err.message });
            throw err;
        }
        await d.teamsImportStore.failJob(job.id, {
            errorCode: null, lastError: String(err?.message || err).slice(0, 500),
            terminal: false, status: job.status, backoffMs: backoffMsFor(job.attempts),
        });
        throw codedError(err?.message || 'Teams lookup failed', 'failed');
    }

    if (!artifact) {
        if (Date.now() > meetingEndMs(job) + NO_RECORDING_DEADLINE_MS) {
            await d.teamsImportStore.failJob(job.id, {
                errorCode: 'no_recording', terminal: true,
                lastError: 'No recording or transcript was made for this meeting',
            });
            throw codedError('This meeting has no recording or transcript', 'no_recording');
        }
        await d.teamsImportStore.failJob(job.id, {
            terminal: false, status: 'awaiting_artifacts', backoffMs: backoffMsFor(job.attempts),
        });
        return { pending: true, status: 'awaiting_artifacts' };
    }

    const attendees = await fetchEventAttendees(session, job);
    // The ingest outlives the 10-minute claim lease by far; extend it so the
    // next tick does not start the same meeting again on another replica.
    await d.teamsImportStore.heartbeatJob(job.id, INGEST_LEASE_MINUTES)
        .catch(e => log.warn('[TeamsAutoImport] lease extension failed:', e.message));

    let saved;
    try {
        saved = await d.ingestTeamsMeeting({
            userId: job.userId,
            session,
            orgId: job.orgId,
            meetingId,
            artifact,
            title: job.title,
            language: language || effective.language,
            contextTerms,
            attendees,
            accessCtx,
        });
    } catch (err) {
        return failIngest(job, err);
    }
    await d.teamsImportStore.completeJob(job.id, saved.id);
    return { transcription: saved };
}

async function processClaimedJob(job) {
    // Re-read the settings and the explicit per-meeting choice: an opt-out
    // made after seeding must still win.
    const settings = await d.resolveTeamsNotesSettings({ orgId: job.orgId, userId: job.userId });
    const meetingPrefs = d.meetingPrefs;
    const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'teams', userId: job.userId, orgId: job.orgId });
    const opinion = prefs.opinionFor(
        meetingPrefs.teamsIds({ eventId: job.calendarEventId, seriesMasterId: job.seriesMasterId }),
    );
    // An explicit opt-out always wins; with autoImport off an explicit opt-in is required.
    if (opinion === false || (!settings.autoImport && opinion !== true)) {
        await d.teamsImportStore.updateJob(job.id, { status: 'skipped' });
        return;
    }

    const auth = await d.automationAuth.getProviderAuth(job.userId, 'microsoft');
    const session = auth ? await vaultSession(auth, job.userId) : null;
    if (!session) {
        await d.teamsImportStore.parkNeedsReauth(job.id);
        return;
    }
    await processJobInline({ job, session, settings, transcriptAllowed: d.hasTranscriptScope(auth.scope) });
}

/** Phase B: claim and process due jobs (every pod may run this). */
async function processDue({ limit = 2 } = {}) {
    return kit.processDueJobs({
        store: d.teamsImportStore, limit,
        label: 'TeamsAutoImport',
        describe: (job) => String(job.id),
        processClaimedJob,
        quietCodes: QUIET_CODES,
    });
}

module.exports = { init, discover, processDue, processJobInline, findArtifact };
