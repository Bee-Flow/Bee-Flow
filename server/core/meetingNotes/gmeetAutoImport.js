// @typecheck
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
const { getSpaceByMeetingCode, findConferenceRecord, findGeneratedRecording } = require('./gmeetArtifacts');
const { ingestGmeetRecording } = require('./ingestGmeetRecording');
const log = require('../../telemetry/log');

// Artifact wait/retry backoff, indexed by the job's attempt count; past the
// end of the table the poller settles into an hourly re-check.
const BACKOFF_MINUTES = [2, 5, 10, 20, 40];
const HOURLY_MS = 60 * 60_000;

// Recording artifacts appear "soon after" the meeting ends (no SLA). A meeting
// still without a FILE_GENERATED recording 24h past its end simply wasn't
// recorded (the common case) — quiet terminal, no notification.
const NO_RECORDING_DEADLINE_MS = 24 * 3600_000;
// No conference record at all 48h past the end: the meeting never happened on
// Meet (or under a different code) — terminal no_conference.
const NO_CONFERENCE_DEADLINE_MS = 48 * 3600_000;
// Parked needs_reauth jobs re-enter the queue when discovery sees a working
// credential again; the park horizon itself is informational.
const REAUTH_PARK_MS = 6 * 3600_000;
// Lease held across download + transcription + the LLM passes. Sized for the
// worst realistic meeting rather than the average: expiring early costs a full
// duplicate ingest, expiring late only delays recovery of a genuinely dead
// worker. See the heartbeat call in processJobInline.
const INGEST_LEASE_MINUTES = Number(process.env.GMEET_INGEST_LEASE_MINUTES) || 120;

const MAX_INGEST_ATTEMPTS = 3;
const MAX_USERS_PER_TICK = 100;
const USER_JITTER_MS = 250;

// Classified codes retrying can never fix — they freeze the job.
const TERMINAL_CODES = new Set([
    'no_conference', 'no_recording', 'no_drive_access',
    'recording_too_large', 'unsupported_edition',
]);
// Expected outcomes, not incidents — logged without alarm.
const QUIET_CODES = new Set(['no_recording', 'no_conference', 'no_drive_access']);

// Round-robin cursor so a large install fans discovery over successive ticks.
let _userCursor = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function codedError(message, code) {
    const e = new Error(message);
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

/**
 * Session-shaped shim over a vault credential. `createGoogleApiClient` calls
 * `session.save?.()` after an SDK-side token refresh — write the rotated
 * tokens back to the vault so the next tick doesn't start from a stale
 * refresh token.
 */
function buildVaultSession(auth) {
    return {
        userId: auth.userId,
        oauthProvider: 'google',
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        save() {
            const routineCredentialStore = require('../../stores/routineCredentialStore');
            routineCredentialStore.upsertCredential({
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

async function resolveOrgIdForUser(userId) {
    try {
        const { getUser } = require('../../stores/userStore');
        return (await getUser(userId))?.organizationId || null;
    } catch (_) { return null; }
}

/**
 * Candidate user set: everyone with a user_gmeet_notes_* doc, plus members of
 * any org whose org_gmeet_notes_* doc enabled autoImport (so an org can turn
 * it on for members who never opened their own settings).
 */
async function listCandidateUsers() {
    const all = await configStore.getAllConfig().catch(() => ({}));
    const userIds = new Set();
    const orgIds = new Set();
    for (const key of Object.keys(all || {})) {
        if (key.startsWith('user_gmeet_notes_')) userIds.add(key.slice('user_gmeet_notes_'.length));
        else if (key.startsWith('org_gmeet_notes_')) orgIds.add(key.slice('org_gmeet_notes_'.length));
    }
    if (orgIds.size) {
        const enabledOrgs = [];
        for (const orgId of orgIds) {
            const s = await resolveGmeetNotesSettings({ orgId }).catch(() => null);
            if (s?.autoImport) enabledOrgs.push(orgId);
        }
        if (enabledOrgs.length) {
            try {
                const { getAllUsers } = require('../../stores/userStore');
                const users = await getAllUsers();
                for (const u of users) {
                    if (u.organizationId && enabledOrgs.includes(u.organizationId)) userIds.add(u.id);
                }
            } catch (_) { /* best-effort */ }
        }
    }
    return Array.from(userIds);
}

async function discoverUser(userId) {
    const orgId = await resolveOrgIdForUser(userId);
    const settings = await resolveGmeetNotesSettings({ orgId, userId });
    if (!settings.autoImport) return;

    // The background path bypasses the route gates — enforce the license
    // capability per user here (skip, never an error).
    const { hasCapability } = require('../entitlements/entitlements');
    if (!await hasCapability('meeting_notes', { userId, orgId })) return;

    const { getProviderAuth } = require('../../auth/routineAuth');
    const auth = await getProviderAuth(userId, 'google');
    if (!auth) return; // not connected / needs_reauth / transient refresh failure
    if (!hasMeetScopes(auth.scope)) return; // silent — surfaced via the status endpoints

    // The credential works again — release any jobs parked on needs_reauth.
    try {
        const parked = (await gmeetImportStore.listRecentJobsForUser(userId))
            .filter((j) => j.status === 'needs_reauth');
        for (const j of parked) {
            await gmeetImportStore.updateJob(j.id, {
                status: 'pending', errorCode: null, nextAttemptAt: new Date().toISOString(),
            });
        }
    } catch (err) {
        log.warn(`[GmeetAutoImport] unpark failed for user ${userId}: ${err.message}`);
    }

    const session = buildVaultSession(auth);
    // De per-vergadering keuze komt uit meeting_prefs (M5): één query voor deze
    // gebruiker (plus de org-brede regels), daarna per vergadering beslissen.
    const meetingPrefs = require('../../stores/meetingPrefsStore');
    const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'gmeet', userId, orgId });

    const ended = await listRecentlyEndedMeetMeetings({ session, lookbackHours: settings.lookbackHours });
    for (const m of ended) {
        if (settings.importScope === 'organizer' && !m.organizerSelf) continue;
        // autoImport is hierboven al gecontroleerd; binnen die schakelaar
        // beslist de voorkeur, inclusief de 1-op-1-standaard (het aantal komt
        // uit de deelnemerslijst van de agenda-afspraak; ontbreekt die, dan is
        // het onbekend en versmalt het).
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
async function discover() {
    let users;
    try { users = await listCandidateUsers(); }
    catch (e) { log.error('[GmeetAutoImport] candidate scan failed:', e.message); return; }
    if (!users.length) return;

    const count = Math.min(users.length, MAX_USERS_PER_TICK);
    const start = _userCursor % users.length;
    _userCursor = (start + count) % users.length;
    for (let i = 0; i < count; i++) {
        const userId = users[(start + i) % users.length];
        if (i > 0) await sleep(Math.floor(Math.random() * USER_JITTER_MS)); // spread calendar reads (quota friendliness)
        try { await discoverUser(userId); }
        catch (e) { log.error(`[GmeetAutoImport] discovery failed for user ${userId}: ${e.message}`); }
    }
}

/**
 * Best-effort calendar attendee list for a claimed job (used for the speaker
 * roster + the attendee → connected-user sharing map). The job table doesn't
 * carry attendees, so re-read the event from the user's calendar window
 * around the meeting. [] on any failure.
 */
async function fetchEventAttendees(session, job) {
    if (!job.calendarEventId) return [];
    try {
        const startMs = job.meetingStart ? new Date(job.meetingStart).getTime() : meetingEndMs(job);
        const hours = Math.min(Math.max(Math.ceil((Date.now() - startMs) / 3600_000) + 1, 1), 168);
        const meetings = await listRecentlyEndedMeetMeetings({ session, lookbackHours: hours, graceMinutes: 0 });
        return meetings.find((m) => m.eventId === job.calendarEventId)?.attendees || [];
    } catch (err) {
        log.warn(`[GmeetAutoImport] attendee lookup failed for job ${job.id}: ${err.message}`);
        return [];
    }
}

// No conference record (or even no space) yet: retry with backoff until the
// 48h post-end deadline, then freeze as no_conference.
async function awaitConference(job, spaceName = null) {
    if (Date.now() > meetingEndMs(job) + NO_CONFERENCE_DEADLINE_MS) {
        await gmeetImportStore.failJob(job.id, {
            errorCode: 'no_conference', terminal: true,
            lastError: 'No Meet conference record appeared for this meeting',
        });
        throw codedError('No Meet conference was found for this meeting', 'no_conference');
    }
    if (spaceName && spaceName !== job.spaceName) {
        await gmeetImportStore.updateJob(job.id, { spaceName });
    }
    await gmeetImportStore.failJob(job.id, {
        terminal: false, status: 'pending',
        backoffMs: backoffMsFor(job.attempts),
    });
    return { pending: true, status: 'pending' };
}

/**
 * The (org_id, conference_record) claim index rejected the attach — another
 * attendee's job in the same org owns this conference. Freeze quietly
 * (organizer-first seeding makes the organizer's job win the race) and
 * surface the sibling's note when it already exists.
 */
async function resolveDuplicate(job, conferenceRecordName) {
    await gmeetImportStore.updateJob(job.id, { status: 'duplicate', errorCode: null });
    const sourceUri = `gmeet://${job.orgId || `user:${job.userId}`}/${conferenceRecordName}`;
    const existing = await require('../../stores/transcriptionStore')
        .getTranscriptionBySourceUri(sourceUri).catch(() => null);
    if (existing) {
        await gmeetImportStore.updateJob(job.id, { transcriptionId: existing.id });
        return { transcription: existing };
    }
    return { pending: true, status: 'duplicate' };
}

// `lastError` carries an "attempt N/M:" marker so ingest retries are counted
// across claims — job.attempts also counts artifact waits, which must not eat
// into the ingest retry budget.
function ingestAttempt(job) {
    if (job.errorCode !== 'failed') return 0;
    const m = /^attempt (\d+)\//.exec(job.lastError || '');
    return m ? Number(m[1]) : 1;
}

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
 */
async function releaseClaimAfterTerminalFailure(job) {
    try {
        const woken = await gmeetImportStore.releaseConferenceClaim(job.id);
        if (woken > 0) {
            log.info(`[GmeetAutoImport] job ${job.id} failed terminally — returned ${woken} sibling job(s) to pending`);
        }
    } catch (e) {
        log.warn('[GmeetAutoImport] could not release the conference claim:', e.message);
    }
}

async function failIngest(job, err) {
    const code = err?.code || null;
    if (code && TERMINAL_CODES.has(code)) {
        await gmeetImportStore.failJob(job.id, { errorCode: code, terminal: true, lastError: err.message });
        await releaseClaimAfterTerminalFailure(job);
        throw err;
    }
    const attempt = ingestAttempt(job) + 1;
    const lastError = `attempt ${attempt}/${MAX_INGEST_ATTEMPTS}: ${String(err?.message || err).slice(0, 500)}`;
    if (attempt >= MAX_INGEST_ATTEMPTS) {
        await gmeetImportStore.failJob(job.id, { errorCode: 'failed', terminal: true, lastError });
        await releaseClaimAfterTerminalFailure(job);
    } else {
        await gmeetImportStore.failJob(job.id, {
            errorCode: 'failed', lastError,
            terminal: false, status: 'pending',
            backoffMs: backoffMsFor(job.attempts),
        });
    }
    throw codedError(err?.message || 'Google Meet import failed', 'failed');
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
 */
async function processJobInline({ job, session, settings = null, language = null, contextTerms = '' }) {
    // `language`/`contextTerms` come from the manual from-gmeet route's request
    // body; the background poller passes neither and runs on the settings.
    const effective = settings || await resolveGmeetNotesSettings({ orgId: job.orgId, userId: job.userId });

    let spaceName = job.spaceName;
    let conferenceRecordName = job.conferenceRecord;

    if (!conferenceRecordName) {
        if (!spaceName) {
            const space = await getSpaceByMeetingCode(session, job.meetingCode);
            spaceName = space?.name || null;
            if (!spaceName) return awaitConference(job);
        }
        const record = await findConferenceRecord(session, {
            spaceName,
            meetingStart: job.meetingStart,
            meetingEnd: job.meetingEnd,
        });
        if (!record) return awaitConference(job, spaceName);

        const attached = await gmeetImportStore.attachConferenceRecord(job.id, {
            spaceName, conferenceRecord: record.name,
        });
        if (attached && attached.duplicate) return resolveDuplicate(job, record.name);
        conferenceRecordName = record.name;
    }

    const recording = await findGeneratedRecording(session, conferenceRecordName);
    if (!recording.driveFileId) {
        // No FILE_GENERATED artifact (yet) — covers both "recordings exist but
        // no file" and "no recordings at all". Past the deadline the meeting
        // simply wasn't recorded: terminal and quiet (the common case).
        if (Date.now() > meetingEndMs(job) + NO_RECORDING_DEADLINE_MS) {
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
    // Extend the lease to cover the long stage. A crashed worker still loses
    // it (nothing renews it), so genuinely stuck jobs are still recovered.
    await gmeetImportStore.heartbeatJob(job.id, INGEST_LEASE_MINUTES)
        .catch(e => log.warn('[GmeetAutoImport] lease extension failed:', e.message));

    let saved;
    try {
        saved = await ingestGmeetRecording({
            userId: job.userId,
            session,
            orgId: job.orgId,
            conferenceRecordName,
            driveFileId: recording.driveFileId,
            meetingCode: job.meetingCode,
            title: job.title,
            language: language || effective.language,
            contextTerms,
            attendees,
        });
    } catch (err) {
        return failIngest(job, err); // always throws
    }
    await gmeetImportStore.completeJob(job.id, saved.id);
    return { transcription: saved };
}

async function processClaimedJob(job) {
    // Re-resolve settings at claim time — an exclusion or opt-out flipped
    // after seeding must still win.
    const settings = await resolveGmeetNotesSettings({ orgId: job.orgId, userId: job.userId });
    // Alleen de EXPLICIETE mening wordt hier opnieuw gelezen, niet de hele
    // beslissing: de 1-op-1-standaard is bij het seeden al toegepast met de
    // deelnemerslijst van de agenda, en de jobrij draagt die lijst niet. Zou je
    // decide() hier herhalen, dan las "geen deelnemers bekend" als onbekend en
    // werd élke job overgeslagen.
    const meetingPrefs = require('../../stores/meetingPrefsStore');
    const prefs = await meetingPrefs.loadMeetingPrefs({ provider: 'gmeet', userId: job.userId, orgId: job.orgId });
    const excluded = prefs.opinionFor(
        meetingPrefs.gmeetIds({ eventId: job.calendarEventId, meetingCode: job.meetingCode }),
    ) === false;
    if (!settings.autoImport || excluded || (settings.importScope === 'organizer' && !job.preferred)) {
        await gmeetImportStore.updateJob(job.id, { status: 'skipped' });
        return;
    }

    const { getProviderAuth } = require('../../auth/routineAuth');
    const auth = await getProviderAuth(job.userId, 'google');
    if (!auth) {
        // routineAuth pauses+notifies on definitive rejections; park the job so
        // it stops burning claim slots until discovery unparks it post-reauth.
        await gmeetImportStore.parkNeedsReauth(job.id, new Date(Date.now() + REAUTH_PARK_MS).toISOString());
        return;
    }
    await processJobInline({ job, session: buildVaultSession(auth), settings });
}

/**
 * Phase B — claim + process due jobs. Runs OUTSIDE the discovery lock (claims
 * are FOR UPDATE SKIP LOCKED, so every pod may run this concurrently).
 */
async function processDue({ limit = 2 } = {}) {
    let jobs;
    try { jobs = await gmeetImportStore.claimDueJobs(limit); }
    catch (e) { log.error('[GmeetAutoImport] claim failed:', e.message); return; }
    for (const job of jobs) {
        try {
            await processClaimedJob(job);
        } catch (e) {
            const code = e?.code || 'failed';
            const line = `[GmeetAutoImport] job ${job.id} (${job.meetingCode}): ${code}: ${e.message}`;
            if (QUIET_CODES.has(code)) log.info(line); // expected outcome, no alarm
            else log.warn(line);
        }
    }
}

module.exports = { discover, processDue, processJobInline };
