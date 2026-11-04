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
    artifactsForSlot: () => require('./teamsArtifacts').artifactsForSlot,
    ingestTeamsMeeting: () => require('./ingestTeamsRecording').ingestTeamsMeeting,
});

const log = require('../../telemetry/log');
const kit = require('./importJobKit');
const { fallback: fallbackSwallowed } = require('../../utils/bestEffort');

const { codedError, backoffMsFor, meetingEndMs } = kit;

// A Teams recording lands in OneDrive/SharePoint shortly after the meeting;
// nothing 48 h after the end means it was not recorded (the common case).
// Processing of long meetings can take a day, so 24 h froze jobs too early.
const NO_RECORDING_DEADLINE_MS = 48 * 3600_000;
const INGEST_LEASE_MINUTES = Number(process.env.TEAMS_INGEST_LEASE_MINUTES) || 120;
const MAX_INGEST_ATTEMPTS = 3;
const MAX_USERS_PER_TICK = 100;
const USER_JITTER_MS = 250;

const TERMINAL_CODES = new Set([
    'not_organizer', 'no_recording', 'recording_too_large',
    'transcript_access_disabled', 'speaker_attribution_disabled', 'needs_teams_scopes',
    'empty_transcription',
    // A colleague's note for this recording that this user cannot read: no
    // retry changes that, and the 409's sentence (ask them to share it) is the
    // answer the user needs instead of "try again in a moment".
    'already_imported', 'provider_not_allowed',
]);
const QUIET_CODES = new Set(['no_recording', 'not_organizer']);

/**
 * A Microsoft-only session over a vault credential; refreshes write back to the vault.
 * @param {string | null} userId
 */
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
        log.warn(`[TeamsAutoImport] record opt-in lookup failed: ${/** @type {Error} */ (err).message}`);
    }
    return Array.from(users);
}

/**
 * @param {string} userId
 */
async function discoverUser(userId) {
    let user = null;
    try { user = await d.userStore.getUser(userId); } catch (err) {
        fallbackSwallowed('core/meetingNotes/teamsAutoImport:discoverUser', err); // [TeamsAutoImport] user lookup failed for :
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

/**
 * Attendees of the job's calendar event (speaker roster + sharing). [] on
 * failure. Rooms and other resources are no participants, and an invitee who
 * DECLINED was not there: neither gets the note shared nor becomes a speaker
 * candidate.
 */
async function fetchEventAttendees(session, job) {
    try {
        const event = await d.graphFetch(`/me/events/${encodeURIComponent(job.calendarEventId)}?$select=attendees`, session);
        return (event?.attendees || [])
            .filter(a => String(a?.type || '').toLowerCase() !== 'resource'
                && String(a?.status?.response || '').toLowerCase() !== 'declined')
            .map(a => ({
                email: a.emailAddress?.address || null,
                displayName: a.emailAddress?.name || null,
            }));
    } catch (err) {
        log.warn(`[TeamsAutoImport] attendee lookup failed for job ${job.id}: ${/** @type {Error} */ (err).message}`);
        return [];
    }
}

/**
 * The artifact to ingest for this occurrence: its recording, else (when the
 * transcript scope was granted) its transcript, else null. Transcript access
 * switched off by the tenant counts as "no transcript", not as a failure.
 * `extraRecordings` counts the OTHER artifacts of the same occurrence (a
 * recording stopped and restarted makes one per part), so the note can say it
 * covers only one of them.
 * @returns {Promise<{ kind: 'recording'|'transcript', id: string, extraRecordings?: number }|null>}
 * @param {string} meetingId
 */
async function findArtifact(session, meetingId, job, { transcriptAllowed }) {
    const slot = { meetingStart: job.meetingStart, meetingEnd: job.meetingEnd };
    const recordings = await d.listRecordings(session, meetingId);
    const recording = d.pickArtifactForSlot(recordings, slot);
    if (recording?.id) return withExtras({ kind: 'recording', id: recording.id }, recordings, slot);
    if (!transcriptAllowed) return null;
    try {
        const transcripts = await d.listTranscripts(session, meetingId);
        const transcript = d.pickArtifactForSlot(transcripts, slot);
        if (transcript?.id) return withExtras({ kind: 'transcript', id: transcript.id }, transcripts, slot);
    } catch (err) {
        if (err?.code !== 'transcript_access_disabled') throw err;
    }
    return null;
}

/**
 * The picked artifact, plus how many others of `items` fall in this occurrence's window.
 * @param {{ kind: 'recording' | 'transcript', id: string }} artifact
 * @param {any[]} items
 * @param {{ meetingStart?: string | null, meetingEnd?: string | null }} slot
 */
function withExtras(artifact, items, slot) {
    const extra = d.artifactsForSlot(items, slot).filter((/** @type {{ id?: string }} */ a) => a?.id && a.id !== artifact.id).length;
    return extra > 0 ? { ...artifact, extraRecordings: extra } : artifact;
}

// Always throws: classified codes freeze the job; anything else retries up to
// MAX_INGEST_ATTEMPTS, then freezes as 'failed'. A run the user is watching
// (`manual`) is not retried behind their back: its failure is final and keeps
// its own code, so the screen and the job agree.
async function failIngest(job, err, { manual = false } = {}) {
    return kit.failIngest({
        store: d.teamsImportStore, job, err,
        terminalCodes: TERMINAL_CODES,
        maxAttempts: manual ? 1 : MAX_INGEST_ATTEMPTS,
        keepCode: manual,
        fallbackMessage: 'Teams import failed',
    });
}

/**
 * Shared per-job pipeline (poller + manual route). Returns
 *   { transcription }          note created (or already there)
 *   { pending: true, status }  no artifact yet; the job stays claimable
 * and throws an Error with a stable `.code` for classified failures, after
 * recording the outcome on the job row.
 * `manual`: the run a user started and is watching (the /from-teams route).
 * @param {{ job: any, session: any, settings?: any, language?: string|null, contextTerms?: string, transcriptAllowed?: boolean, accessCtx?: any, manual?: boolean }} args
 */
async function processJobInline({ job, session, settings = null, language = null, contextTerms = '', transcriptAllowed = true, accessCtx = undefined, manual = false }) {
    const effective = settings || await d.resolveTeamsNotesSettings({ orgId: job.orgId, userId: job.userId });

    let meetingId = job.onlineMeetingId;
    /** @type {{ kind: 'recording' | 'transcript'; id: string; extraRecordings?: number } | null} */
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
        // The Graph client signals a session it could not use (no token, a
        // refresh Microsoft refused) with a bare NOT_CONNECTED: that is a
        // reconnect, not a retry.
        if (!err?.code && /** @type {Error} */ (err)?.message === 'NOT_CONNECTED') {
            await d.teamsImportStore.parkNeedsReauth(job.id);
            throw codedError('Reconnect your Microsoft account to import this meeting', 'needs_reauth');
        }
        // Classified codes freeze; anything else (a 404 on a cached meeting,
        // a lasting 5xx) retries with backoff until the same 48 h deadline as
        // a missing recording, then freezes as 'failed' with the last error.
        return kit.failLookup({
            store: d.teamsImportStore, job, err,
            terminalCodes: TERMINAL_CODES,
            deadlineMs: NO_RECORDING_DEADLINE_MS,
            fallbackMessage: 'Teams lookup failed',
        });
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

    let saved;
    try {
        // The ingest outlives the 10-minute claim lease by far; the lease is
        // extended and kept renewed for as long as it runs, so no tick on
        // another replica starts the same meeting again mid-ingest.
        saved = await kit.withLeaseHeartbeat({
            store: d.teamsImportStore, jobId: job.id, leaseMinutes: INGEST_LEASE_MINUTES, label: 'TeamsAutoImport',
            work: () => d.ingestTeamsMeeting({
                userId: job.userId,
                session,
                orgId: job.orgId,
                meetingId,
                artifact,
                title: job.title,
                meetingStart: job.meetingStart,
                language: language || job.requestedLanguage || effective.language,
                contextTerms: contextTerms || job.contextTerms || '',
                attendees,
                accessCtx,
            }),
        });
    } catch (err) {
        return failIngest(job, err, { manual });
    }
    await d.teamsImportStore.completeJob(job.id, saved.id);
    return { transcription: saved };
}

/**
 * May this job's owner still have a meeting imported? Checked again at claim
 * time, not only at discovery: a job can wait up to 48 h for its recording,
 * and a user deactivated, or an org whose licence lapsed, in that window must
 * not still get a note transcribed, stored and shared.
 * @returns {Promise<string | null>} why not, or null when they may
 */
async function ownerBarredReason(job) {
    // A failed lookup throws: the claim lease retries the job instead of skipping it for good.
    const user = await d.userStore.getUser(job.userId);
    if (!user || (user.status ?? 'active') !== 'active') return 'the account is no longer active';
    if (!await d.hasCapability('meeting_notes', { userId: job.userId, orgId: job.orgId })) return 'Meeting Notes is not licensed for this account';
    return null;
}

async function processClaimedJob(job) {
    const barred = await ownerBarredReason(job);
    if (barred) {
        await d.teamsImportStore.updateJob(job.id, { status: 'skipped', lastError: `Skipped: ${barred}` });
        return;
    }
    // Re-read the settings and the explicit per-meeting choice: an opt-out
    // made after seeding must still win.
    const settings = await d.resolveTeamsNotesSettings({ orgId: job.orgId, userId: job.userId });
    const meetingPrefs = d.meetingPrefs;
    const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'teams', userId: job.userId, orgId: job.orgId });
    const opinion = prefs.opinionFor(
        meetingPrefs.teamsIds({ eventId: job.calendarEventId, seriesMasterId: job.seriesMasterId }),
    );
    // An explicit opt-out always wins; with autoImport off an explicit opt-in
    // is required — and a meeting the user asked to import BY HAND is one
    // (`requestedByUser`): the poller finishing a manual import that had to
    // wait for Teams must not skip it because auto-import is off.
    if (opinion === false || (!settings.autoImport && opinion !== true && !job.requestedByUser)) {
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

module.exports = { init, discover, processDue, processJobInline, findArtifact, NO_RECORDING_DEADLINE_MS };

/**
 * @typedef {NonNullable<Awaited<ReturnType<typeof import('../../stores/teamsImportStore').getJob>>>} TeamsImportJob
 * @typedef {Awaited<ReturnType<typeof import('../../auth/microsoftSessionHydration').resolveMicrosoftSession>>} MicrosoftSession
 */

/**
 * @typedef {{ limit?: number }} ProcessDueArgs
 */
