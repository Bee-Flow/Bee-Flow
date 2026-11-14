// @typecheck strict
/**
 * Google Meet auto-import engine.
 *
 * Two-phase poller, both phases driven from a single 120s tick in
 * `automationRunner.processGmeetAutoImport`:
 *
 *   Phase A — discover() (advisory-locked, metadata only): for every opted-in,
 *   entitled user with a Meet-scoped Google credential, list recently ENDED
 *   calendar meetings with a Meet link and seed `gmeet_import_jobs` rows.
 *   Upcoming meetings are read live by the routes — only ended meetings
 *   become jobs.
 *
 *   Phase B — processDue() (runs OUTSIDE the lock — claims use FOR UPDATE
 *   SKIP LOCKED so every pod may ingest): claim due jobs and run each through
 *   the shared per-job pipeline (`processJobInline`, also used by the manual
 *   `POST /api/transcriptions/from-gmeet` route): space → conference record →
 *   generated recording → `ingestGmeetRecording`.
 *
 * Failure codes are the stable codes shared with the UI (API `code` field +
 * job `error_code`): not_connected, needs_meet_scopes, needs_reauth,
 * no_conference, no_recording, no_drive_access, recording_too_large, failed,
 * unsupported_edition.
 */

const configStore = require('../../stores/configStore');
const gmeetImportStore = require('../../stores/gmeetImportStore');
const { resolveGmeetNotesSettings, hasMeetScopes } = require('./gmeetNotesSettings');
const { listRecentlyEndedMeetMeetings } = require('./gmeetCalendar');
const { ingestGmeetRecording } = require('./ingestGmeetRecording');
const {
    NO_CONFERENCE_DEADLINE_MS, fetchEventAttendees, awaitConference, resolveDuplicate, isAuthFailure, discoverArtifacts, ownerBarredReason,
} = require('./gmeetDiscovery');
const log = require('../../telemetry/log');
const kit = require('./importJobKit');
const { fallback: fallbackSwallowed } = require('../../utils/bestEffort');
const { envInt } = require('../../utils/envNumber.mts');

const { codedError, backoffMsFor, meetingEndMs } = kit;

/** @typedef {import('../../stores/gmeetImportStore').GmeetJob} GmeetJob */
/** @typedef {NonNullable<Awaited<ReturnType<typeof import('../../auth/automationAuth').getProviderAuth>>>} ProviderAuth */
/** @typedef {{ accessToken?: string, refreshToken?: string }} GoogleSession  a live web session or the vault shim */
/** @typedef {import('./gmeetDiscovery').GmeetPending} GmeetPending */
/** @typedef {import('./gmeetDiscovery').GmeetImported} GmeetImported */

// Recording artifacts appear "soon after" the meeting ends (no SLA). A meeting
// still without a FILE_GENERATED recording 24h past its end simply wasn't
// recorded (the common case) — quiet terminal, no notification.
const NO_RECORDING_DEADLINE_MS = 24 * 3600_000;
// Parked needs_reauth jobs re-enter the queue when discovery sees a working
// credential again; the park horizon itself is informational.
const REAUTH_PARK_MS = 6 * 3600_000;
// Lease held across download + transcription + the LLM passes. Sized for the
// worst realistic meeting rather than the average: expiring early costs a full
// duplicate ingest, expiring late only delays recovery of a genuinely dead
// worker. See the heartbeat call in processJobInline.
const INGEST_LEASE_MINUTES = envInt('GMEET_INGEST_LEASE_MINUTES', 120, { min: 1 });

const MAX_INGEST_ATTEMPTS = 3;
const MAX_USERS_PER_TICK = 100;
const USER_JITTER_MS = 250;

// Classified codes retrying can never fix — they freeze the job.
const TERMINAL_CODES = new Set([
    'no_conference', 'no_recording', 'no_drive_access',
    'recording_too_large', 'unsupported_edition',
    // A colleague's note for this conference that this user cannot read, or
    // an engine the workspace does not allow: no retry changes either.
    'already_imported', 'provider_not_allowed',
]);
// Expected outcomes, not incidents — logged without alarm.
const QUIET_CODES = new Set(['no_recording', 'no_conference', 'no_drive_access']);

/**
 * Session-shaped shim over a vault credential. `createGoogleApiClient` calls
 * `session.save?.()` after an SDK-side token refresh — write the rotated
 * tokens back to the vault so the next tick doesn't start from a stale
 * refresh token.
 * @param {ProviderAuth} auth
 */
function buildVaultSession(auth) {
    return {
        userId: auth.userId,
        oauthProvider: 'google',
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        save() {
            const automationCredentialStore = require('../../stores/automationCredentialStore');
            automationCredentialStore.upsertCredential({
                userId: auth.userId,
                orgId: auth.orgId,
                provider: 'google',
                accessToken: this.accessToken,
                refreshToken: this.refreshToken,
                expiresAt: null, // unknown after an SDK refresh; getProviderAuth re-checks next tick
                scope: auth.scope,
            }).catch((err) => log.warn(`[GmeetAutoImport] vault write-back failed for user ${auth.userId}: ${err.message}`));
        },
    };
}

/** @param {string} userId */
async function resolveOrgIdForUser(userId) {
    return kit.resolveOrgIdForUser(userId, () => require('../../stores/userStore'));
}

/**
 * Candidate user set: everyone with a user_gmeet_notes_* doc, plus members of
 * any org whose org_gmeet_notes_* doc enabled autoImport (so an org can turn
 * it on for members who never opened their own settings).
 */
async function listCandidateUsers() {
    return kit.listCandidateUsers({
        configStore,
        kind: 'gmeet_notes',
        resolveSettings: resolveGmeetNotesSettings,
        flag: 'autoImport',
        getUserStore: () => require('../../stores/userStore'),
    });
}

/** @param {string} userId */
async function discoverUser(userId) {
    const orgId = await resolveOrgIdForUser(userId);
    const settings = await resolveGmeetNotesSettings({ orgId, userId });
    if (!settings.autoImport) return;

    // The background path bypasses the route gates — enforce the license
    // capability per user here (skip, never an error).
    const { hasCapability } = require('../entitlements/entitlements');
    if (!await hasCapability('meeting_notes', { userId, orgId })) return;

    const { getProviderAuth } = require('../../auth/automationAuth');
    const auth = await getProviderAuth(userId, 'google');
    if (!auth) return; // not connected / needs_reauth / transient refresh failure
    if (!hasMeetScopes(auth.scope)) return; // silent — surfaced via the status endpoints

    // The credential works again — release any jobs parked on needs_reauth.
    try {
        // Rows read from the table map to jobs, never to null.
        const parked = /** @type {NonNullable<Awaited<ReturnType<typeof gmeetImportStore.listRecentJobsForUser>>[number]>[]} */ (await gmeetImportStore.listRecentJobsForUser(userId))
            .filter((j) => j.status === 'needs_reauth');
        for (const j of parked) {
            await gmeetImportStore.updateJob(j.id, {
                status: 'pending', errorCode: null, nextAttemptAt: new Date().toISOString(),
            });
        }
    } catch (err) {
        log.warn(`[GmeetAutoImport] unpark failed for user ${userId}: ${/** @type {Error} */ (err).message}`);
    }

    const session = buildVaultSession(auth);
    // De per-vergadering keuze komt uit meeting_prefs (M5): één query voor deze
    // gebruiker (plus de org-brede regels), daarna per vergadering beslissen.
    const meetingPrefs = require('../../stores/meetingPrefsStore');
    const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'gmeet', userId, orgId });

    const ended = await listRecentlyEndedMeetMeetings({ session, lookbackHours: settings.lookbackHours });
    for (const m of ended) {
        if (settings.importScope === 'organizer' && !m.organizerSelf) continue;
        // autoImport was already checked above; within that switch the preference decides,
        // including the 1-on-1 default (the count comes from the participant list of the calendar
        // appointment; if that is missing, the count is unknown and it narrows).
        const decision = prefs.decide({
            ids: meetingPrefs.gmeetIds({ eventId: m.eventId, meetingCode: m.meetingCode }),
            participantCount: meetingPrefs.participantCountOf(m),
            fallback: true,
        });
        if (!decision.record) continue;
        await gmeetImportStore.seedJob({
            userId,
            orgId,
            calendarEventId: m.eventId,
            icalUid: m.iCalUID,
            meetingCode: m.meetingCode,
            title: m.title,
            meetingStart: m.start,
            meetingEnd: m.end,
            preferred: m.organizerSelf,
        });
    }
}

/**
 * Phase A — seed jobs from candidates' calendars. Metadata only; the caller
 * wraps this in the Postgres advisory lock so one pod discovers per tick.
 */
const discover = kit.makeDiscovery({
    label: 'GmeetAutoImport',
    maxUsersPerTick: MAX_USERS_PER_TICK,
    jitterMs: USER_JITTER_MS, // spread calendar reads (quota friendliness)
    listCandidateUsers,
    discoverUser,
});

// Always throws: classified codes freeze the job per code; anything else
// retries up to MAX_INGEST_ATTEMPTS, then freezes as 'failed'.
/**
 * This job held the org's claim on the conference; the attendees' jobs behind
 * it are parked at `duplicate` waiting for a note that is now never coming.
 * Hand the claim back so one of them can take over.
 *
 * Only the ingest path calls this, and deliberately so: its failures are
 * properties of *this user* (revoked token, no Drive access to the organizer's
 * file, their provider erroring), so another attendee genuinely may succeed.
 * `no_conference` and `no_recording` are properties of the meeting — waking the
 * siblings would only make each of them re-derive the same answer at the cost
 * of N more Google API round-trips.
 * @param {GmeetJob} job
 */
async function releaseClaimAfterTerminalFailure(job) {
    try {
        const woken = await gmeetImportStore.releaseConferenceClaim(job.id);
        if (woken > 0) {
            log.info(`[GmeetAutoImport] job ${job.id} failed terminally — returned ${woken} sibling job(s) to pending`);
        }
    } catch (e) {
        log.warn('[GmeetAutoImport] could not release the conference claim:', /** @type {Error} */ (e).message);
    }
}

/**
 * @param {GmeetJob} job
 * @param {Error & { code?: string }} err
 */
async function failIngest(job, err, { manual = false } = {}) {
    // A run the user is watching (`manual`) is not retried behind their back:
    // its failure is final and keeps its own code, so screen and job agree.
    return kit.failIngest({
        store: gmeetImportStore, job, err,
        terminalCodes: TERMINAL_CODES,
        maxAttempts: manual ? 1 : MAX_INGEST_ATTEMPTS,
        keepCode: manual,
        fallbackMessage: 'Google Meet import failed',
        onTerminal: releaseClaimAfterTerminalFailure,
    });
}

/**
 * Shared per-job pipeline (background worker + manual-import route). Takes a
 * caller-provided session (live web session or vault shim) and persists every
 * job-state transition itself. Returns:
 *   { transcription }          — note created (or an org sibling already made it)
 *   { pending: true, status }  — conference/artifacts not ready yet; the job
 *                                stays claimable and the poller carries on
 * Throws an Error with `.code` set to a stable failure code for classified
 * failures (the job row is already updated by the time it throws).
 * `manual`: the run a user started and is watching (the /from-gmeet route).
 * @param {{ job: GmeetJob, session: GoogleSession, settings?: Awaited<ReturnType<typeof resolveGmeetNotesSettings>> | null,
 *   language?: string | null, contextTerms?: string, manual?: boolean,
 *   accessCtx?: import('../../stores/transcription/acl').ReadAclCtx }} args
 * @returns {Promise<GmeetPending | GmeetImported>}
 */
async function processJobInline({ job, session, settings = null, language = null, contextTerms = '', manual = false, accessCtx = undefined }) {
    // `language`/`contextTerms` come from the manual from-gmeet route's request
    // body; a later claim of a manual job reads them off the job row.
    const effective = settings || await resolveGmeetNotesSettings({ orgId: job.orgId, userId: job.userId });

    let found;
    try {
        found = await discoverArtifacts(job, session);
    } catch (err) {
        // Unhandled, a Google failure here was only logged: the job kept its
        // status with no error and no attempt counted, and was re-claimed
        // every 10 minutes for good — a 403 from a project without the Meet
        // API looped forever. Now: a dead grant parks for a reconnect,
        // anything else retries with backoff and freezes as 'failed' once
        // the meeting is past the no-conference deadline.
        if (isAuthFailure(err)) {
            await gmeetImportStore.parkNeedsReauth(job.id, new Date(Date.now() + REAUTH_PARK_MS).toISOString());
            throw codedError('Reconnect your Google account to import this meeting', 'needs_reauth');
        }
        return kit.failLookup({
            store: gmeetImportStore, job, err,
            terminalCodes: TERMINAL_CODES,
            deadlineMs: NO_CONFERENCE_DEADLINE_MS,
            fallbackMessage: 'Google Meet lookup failed',
        });
    }
    if (found.next === 'await') return awaitConference(job, found.spaceName || null);
    if (found.next === 'duplicate') return resolveDuplicate(job, found.record, accessCtx);
    const { conferenceRecordName, recording } = found;

    // A recording stopped and restarted is several recordings of one
    // conference. While a later part is still being processed by Google, wait
    // for it (until the deadline) rather than import half the meeting and
    // close the job.
    const stillProcessing = Number(recording.pendingRecordings) || 0;
    const pastDeadline = Date.now() > meetingEndMs(job) + NO_RECORDING_DEADLINE_MS;
    if (!recording.driveFileId || (stillProcessing > 0 && !pastDeadline)) {
        // No FILE_GENERATED artifact (yet) — covers both "recordings exist but
        // no file" and "no recordings at all". Past the deadline the meeting
        // simply wasn't recorded: terminal and quiet (the common case).
        if (!recording.driveFileId && pastDeadline) {
            await gmeetImportStore.failJob(job.id, {
                errorCode: 'no_recording', terminal: true,
                lastError: 'No recording was generated for this meeting',
            });
            throw codedError('This meeting has no recording', 'no_recording');
        }
        await gmeetImportStore.failJob(job.id, {
            terminal: false, status: 'awaiting_artifacts',
            backoffMs: backoffMsFor(job.attempts),
        });
        return { pending: true, status: 'awaiting_artifacts' };
    }

    const attendees = await fetchEventAttendees(session, job);

    // Everything above is cheap discovery and fits comfortably inside the
    // 10-minute claim lease. What follows does not: downloading the recording
    // from Drive, transcribing it, and running five to seven LLM passes takes
    // far longer than that on a real meeting. With only the claim lease, the
    // next 120-second tick re-claimed this job mid-ingest and ran the entire
    // pipeline again — every copy but the first thrown away by the source_uri
    // dedup, after being paid for in full.
    //
    // The lease is extended and kept renewed for as long as the ingest runs
    // (one extension ran out on a meeting longer than the lease). A crashed
    // worker stops renewing, so genuinely stuck jobs are still recovered.
    /** @type {{ id: string; title?: string | null; dedup?: boolean; sourceUri?: string; }} */
    let saved;
    try {
        saved = await kit.withLeaseHeartbeat({
            store: gmeetImportStore, jobId: job.id, leaseMinutes: INGEST_LEASE_MINUTES, label: 'GmeetAutoImport',
            work: () => ingestGmeetRecording({
                userId: job.userId,
                session,
                orgId: job.orgId,
                conferenceRecordName,
                driveFileId: /** @type {string} */ (recording.driveFileId),
                meetingCode: job.meetingCode,
                title: job.title,
                meetingStart: job.meetingStart,
                extraRecordings: Number(recording.extraRecordings) || 0,
                language: language || job.requestedLanguage || effective.language,
                contextTerms: contextTerms || job.contextTerms || '',
                attendees,
                accessCtx,
            }),
        });
    } catch (err) {
        return failIngest(job, err, { manual }); // always throws
    }
    await gmeetImportStore.completeJob(job.id, saved.id);
    return { transcription: saved };
}

/** @param {GmeetJob} job */
async function processClaimedJob(job) {
    const barred = await ownerBarredReason(job);
    if (barred) {
        await gmeetImportStore.updateJob(job.id, { status: 'skipped', lastError: `Skipped: ${barred}` });
        return;
    }
    // Re-resolve settings at claim time — an exclusion or opt-out flipped
    // after seeding must still win.
    const settings = await resolveGmeetNotesSettings({ orgId: job.orgId, userId: job.userId });
    // Only the EXPLICIT opinion is read again here, not the whole decision: the 1-on-1 default was already
    // applied when seeding, with the participant list of the agenda, and the job row does not carry that
    // list. Were one to repeat decide() here, "no participants known" would read as unknown and
    // EVERY job would be skipped.
    const meetingPrefs = require('../../stores/meetingPrefsStore');
    const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'gmeet', userId: job.userId, orgId: job.orgId });
    const excluded = prefs.opinionFor(
        meetingPrefs.gmeetIds({ eventId: job.calendarEventId, meetingCode: job.meetingCode }),
    ) === false;
    // A meeting the user asked to import BY HAND (`requestedByUser`) is their
    // explicit choice: the poller finishing it after Google was not ready must
    // not skip it for the auto-import rules (autoImport off, organizer scope).
    // An explicit opt-out still wins.
    const autoRulesSkip = !settings.autoImport || (settings.importScope === 'organizer' && !job.preferred);
    if (excluded || (autoRulesSkip && !job.requestedByUser)) {
        await gmeetImportStore.updateJob(job.id, { status: 'skipped' });
        return;
    }

    const { getProviderAuth } = require('../../auth/automationAuth');
    const auth = await getProviderAuth(job.userId, 'google');
    if (!auth) {
        // getProviderAuth also answers null when a refresh failed for a
        // passing reason (Google 503); the credential is then still active.
        // That is a retry, not a reconnect: parking it showed "Access
        // expired, reconnect" while nothing was wrong.
        let stored = null;
        try { stored = await require('../../stores/automationCredentialStore').getCredential(job.userId, 'google'); }
        catch (e) { fallbackSwallowed('core/meetingNotes/gmeetAutoImport:processClaimedJob', e); }
        if (stored && stored.status === 'active') {
            await gmeetImportStore.failJob(job.id, {
                errorCode: null, lastError: 'Google token refresh failed, retrying',
                terminal: false, status: job.status, backoffMs: backoffMsFor(job.attempts),
            });
            return;
        }
        // automationAuth pauses+notifies on definitive rejections; park the job so
        // it stops burning claim slots until discovery unparks it post-reauth.
        await gmeetImportStore.parkNeedsReauth(job.id, new Date(Date.now() + REAUTH_PARK_MS).toISOString());
        return;
    }
    await processJobInline({ job, session: buildVaultSession(auth), settings });
}

/**
 * @typedef {{ limit?: number }} ProcessDueArgs
 */
/**
 * Phase B — claim + process due jobs. Runs OUTSIDE the discovery lock (claims
 * are FOR UPDATE SKIP LOCKED, so every pod may run this concurrently).
 * @param {ProcessDueArgs} [param0]
 */
async function processDue({ limit = 2 } = {}) {
    return kit.processDueJobs({
        store: gmeetImportStore, limit,
        label: 'GmeetAutoImport',
        describe: (job) => `${job.id} (${job.meetingCode})`,
        processClaimedJob,
        quietCodes: QUIET_CODES,
    });
}

module.exports = { discover, processDue, processJobInline };
