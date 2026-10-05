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
    automationAuth: () => require('../../auth/automationAuth'),
    resolveMicrosoftSession: () => require('../../auth/microsoftSessionHydration').resolveMicrosoftSession,
    hasCapability: () => require('../entitlements/entitlements').hasCapability,
    graphFetch: () => require('../../integrations/msGraphClient').graphFetch,
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

const BACKOFF_MINUTES = [2, 5, 10, 20, 40];
const HOURLY_MS = 60 * 60_000;
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

let _userCursor = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function codedError(message, code) {
    const e = /** @type {Error & {code?: string}} */ (new Error(message));
    e.code = code;
    return e;
}

function backoffMsFor(attempts) {
    const min = BACKOFF_MINUTES[Math.max(0, attempts || 0)];
    return min != null ? min * 60_000 : HOURLY_MS;
}

function meetingEndMs(job) {
    const end = job.meetingEnd ? new Date(job.meetingEnd).getTime() : NaN;
    if (Number.isFinite(end)) return end;
    const created = job.createdAt ? new Date(job.createdAt).getTime() : NaN;
    return Number.isFinite(created) ? created : Date.now();
}

/** A Microsoft-only session over a vault credential; refreshes write back to the vault. */
async function vaultSession(auth, userId) {
    return d.resolveMicrosoftSession({ automationProviders: { microsoft: auth } }, userId);
}

async function resolveOrgIdForUser(userId) {
    try {
        return (await d.userStore.getUser(userId))?.organizationId || null;
    } catch (_) { return null; }
}

/** Users with their own Teams settings, plus members of orgs that turned autoImport on. */
async function listCandidateUsers() {
    const all = await d.configStore.getAllConfig().catch(() => ({}));
    const userIds = new Set();
    const orgIds = new Set();
    for (const key of Object.keys(all || {})) {
        if (key.startsWith('user_teams_notes_')) userIds.add(key.slice('user_teams_notes_'.length));
        else if (key.startsWith('org_teams_notes_')) orgIds.add(key.slice('org_teams_notes_'.length));
    }
    const enabledOrgs = [];
    for (const orgId of orgIds) {
        const s = await d.resolveTeamsNotesSettings({ orgId }).catch(() => null);
        if (s?.autoImport) enabledOrgs.push(orgId);
    }
    if (enabledOrgs.length) {
        try {
            for (const u of await d.userStore.getAllUsers()) {
                if (u.organizationId && enabledOrgs.includes(u.organizationId)) userIds.add(u.id);
            }
        } catch (_) { /* best-effort */ }
    }
    return Array.from(userIds);
}

async function discoverUser(userId) {
    const orgId = await resolveOrgIdForUser(userId);
    const settings = await d.resolveTeamsNotesSettings({ orgId, userId });
    if (!settings.autoImport) return;

    // The background path bypasses the route gates: check the licence here.
    if (!await d.hasCapability('meeting_notes', { userId, orgId })) return;

    const auth = await d.automationAuth.getProviderAuth(userId, 'microsoft');
    if (!auth || !d.hasTeamsScopes(auth.scope)) return;

    await d.teamsImportStore.unparkForUser(userId)
        .catch((err) => log.warn(`[TeamsAutoImport] unpark failed for user ${userId}: ${err.message}`));

    const session = await vaultSession(auth, userId);
    if (!session) return;
    const meetingPrefs = d.meetingPrefs;
    const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'teams', userId, orgId });

    const ended = await d.listRecentlyEndedTeamsMeetings({ session, lookbackHours: settings.lookbackHours });
    for (const m of ended) {
        if (!m.organizerSelf) continue;
        const decision = prefs.decide({
            ids: meetingPrefs.teamsIds({ eventId: m.eventId, seriesMasterId: m.seriesMasterId }),
            participantCount: meetingPrefs.participantCountOf(m),
            fallback: true,
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
async function discover() {
    let users;
    try { users = await listCandidateUsers(); }
    catch (e) { log.error('[TeamsAutoImport] candidate scan failed:', e.message); return; }
    if (!users.length) return;

    const count = Math.min(users.length, MAX_USERS_PER_TICK);
    const start = _userCursor % users.length;
    _userCursor = (start + count) % users.length;
    for (let i = 0; i < count; i++) {
        const userId = users[(start + i) % users.length];
        // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- scheduling jitter between users, not a secret
        if (i > 0) await sleep(Math.floor(Math.random() * USER_JITTER_MS));
        try { await discoverUser(userId); }
        catch (e) { log.error(`[TeamsAutoImport] discovery failed for user ${userId}: ${e.message}`); }
    }
}

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

function ingestAttempt(job) {
    if (job.errorCode !== 'failed') return 0;
    const m = /^attempt (\d+)\//.exec(job.lastError || '');
    return m ? Number(m[1]) : 1;
}

// Always throws: classified codes freeze the job; anything else retries up to
// MAX_INGEST_ATTEMPTS, then freezes as 'failed'.
async function failIngest(job, err) {
    const code = err?.code || null;
    if (code && TERMINAL_CODES.has(code)) {
        await d.teamsImportStore.failJob(job.id, { errorCode: code, terminal: true, lastError: err.message });
        throw err;
    }
    const attempt = ingestAttempt(job) + 1;
    const lastError = `attempt ${attempt}/${MAX_INGEST_ATTEMPTS}: ${String(err?.message || err).slice(0, 500)}`;
    await d.teamsImportStore.failJob(job.id, attempt >= MAX_INGEST_ATTEMPTS
        ? { errorCode: 'failed', terminal: true, lastError }
        : { errorCode: 'failed', lastError, terminal: false, status: 'pending', backoffMs: backoffMsFor(job.attempts) });
    throw codedError(err?.message || 'Teams import failed', 'failed');
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
    const excluded = prefs.opinionFor(
        meetingPrefs.teamsIds({ eventId: job.calendarEventId, seriesMasterId: job.seriesMasterId }),
    ) === false;
    if (!settings.autoImport || excluded) {
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
    let jobs;
    try { jobs = await d.teamsImportStore.claimDueJobs(limit); }
    catch (e) { log.error('[TeamsAutoImport] claim failed:', e.message); return; }
    for (const job of jobs) {
        try {
            await processClaimedJob(job);
        } catch (e) {
            const code = e?.code || 'failed';
            const line = `[TeamsAutoImport] job ${job.id}: ${code}: ${e.message}`;
            if (QUIET_CODES.has(code)) log.info(line);
            else log.warn(line);
        }
    }
}

module.exports = { init, discover, processDue, processJobInline, findArtifact };
