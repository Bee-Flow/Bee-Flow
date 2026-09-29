// @typecheck
/**
 * Talk recording auto-ingest.
 *
 * Invoked as a side-effect tap from `triggerBus.dispatchEvent` on every
 * Nextcloud `file.new` event. NB: that means CONNECTOR PUSH ONLY — the polling
 * fallback (`dispatchToSubscription`) does not run this tap, so a recording
 * whose push webhook is lost is never auto-transcribed until someone imports
 * it manually. Wiring the tap into the polling path needs a claim/lock first
 * (mirror gmeet's claimDueJobs) so two dispatch paths can't double-transcribe;
 * tracked as a follow-up.
 *
 * When the new file is a Talk call recording AND the owning org/user has
 * enabled auto-transcription, it runs the recording through Bee Flow's
 * transcription pipeline and (optionally) posts the summary back into the
 * Talk room.
 *
 * Requires ZERO connector changes — it rides the existing file.new event.
 * Never throws into the dispatcher (the tap is fire-and-forget).
 */

const path = require('path');
const transcriptionStore = require('../../stores/transcriptionStore');
const { resolveTalkNotesSettings } = require('./talkNotesSettings');
const { ingestNextcloudRecording, parseTalkRoomToken, ACCEPTED_RECORDING_EXTS } = require('./ingestNextcloudRecording');
const log = require('../../telemetry/log');

async function resolveOrgIdForUser(userId) {
    if (!userId) return null;
    try {
        const { getUser } = require('../../stores/userStore');
        const u = await getUser(userId);
        return u?.organizationId || null;
    } catch (_) { return null; }
}

/**
 * Map the Nextcloud uid that OWNS the file to a Bee Flow user.
 *
 * Talk's recording backend uploads through the `/recording/{token}/store` OCS
 * endpoint, which is authenticated by the recording secret rather than a user
 * session — so `webhook_listeners` serializes the delivery with `user: null`
 * and the connector forwards no `ncUid`. The owning uid is still right there in
 * the node path (`/<uid>/files/Talk/Recording/…`, which the connector splits
 * into `payload.owner`), so use it. Without this every auto-recorded call fell
 * through to the org's `defaultOwnerUserId` — unset on most tenants, which
 * dropped the recording, and wrong attribution where it was set.
 */
async function resolveUserFromNcUid(orgId, ncUid) {
    if (!orgId || !ncUid) return null;
    try {
        const { getUserByNcUid } = require('../../stores/userStore');
        const u = await getUserByNcUid(orgId, ncUid);
        return u?.id || null;
    } catch (_) { return null; }
}

/**
 * @param {object} args
 * @param {object} args.payload  normalized file.new payload ({ path, name, extension, actor, ... })
 * @param {string|null} args.userId  Bee Flow user mapped from the event actor (may be null)
 * @param {string|null} args.orgId   org the event belongs to (from the connector instance)
 */
async function maybeIngest({ payload, userId = null, orgId = null }) {
    const ncPath = payload?.path;
    if (!ncPath) return;

    // Cheap extension reject before touching config.
    const ext = path.extname(ncPath).toLowerCase();
    if (!ACCEPTED_RECORDING_EXTS.includes(ext)) return;

    // Resolve org if the dispatcher didn't carry one.
    if (!orgId && userId) orgId = await resolveOrgIdForUser(userId);

    // ── Attribution ──────────────────────────────────────
    // 1. the mapped event actor, when the delivery carried one;
    // 2. else the uid whose Files root the recording landed in — the recording
    //    backend uploads without a user session, so this is the normal path;
    // 3. else the org's default owner (bot/federated actors we can't map).
    let ownerId = userId
        || await resolveUserFromNcUid(orgId, payload?.owner)
        || null;
    if (!ownerId) {
        // defaultOwnerUserId is org-only, so this read needs no user scope.
        const orgSettings = await resolveTalkNotesSettings({ orgId });
        ownerId = orgSettings.defaultOwnerUserId || null;
    }
    if (!ownerId) {
        log.warn('[TalkAutoIngest] Talk recording with no mappable owner — skipping', { path: ncPath, actor: payload?.actor, fileOwner: payload?.owner, orgId });
        return;
    }
    if (!orgId) orgId = await resolveOrgIdForUser(ownerId);

    // Settings are resolved for the OWNER, not the (often absent) event actor —
    // autoTranscribe, language and the recordings folder are all user-scopable.
    const settings = await resolveTalkNotesSettings({ orgId, userId: ownerId });

    // Must live under the Talk recordings folder as <folder>/<token>/<file>.
    const token = parseTalkRoomToken(ncPath, settings.recordingFolder);
    if (!token) return;

    // ── Gate ─────────────────────────────────────────────
    // Transcribe if the folder-level autoTranscribe is on, OR if WE started this
    // recording via auto-record (an "armed" token) — so auto-record always
    // produces a note even when autoTranscribe is off.
    // Resolved UNCONDITIONALLY. It used to be read only when autoTranscribe was
    // off, so a user who armed a room and then turned autoTranscribe ON left the
    // token armed forever — and turning autoTranscribe back off later silently
    // resumed transcribing that room.
    let armed = false;
    try { armed = await require('./talkAutoRecord').isArmed(ownerId, token); } catch (_) { armed = false; }
    if (!settings.autoTranscribe && !armed) return;

    // ── Dedup ────────────────────────────────────────────
    // Tenant-scoped, mirroring `ingestNextcloudRecording` and the gmeet key.
    // Both sides must build this identically or auto-ingest and manual import
    // stop deduping against each other.
    const sourceUri = `talk://${orgId || `user:${ownerId}`}/${token}/${path.basename(ncPath)}`;
    const existing = await transcriptionStore.getTranscriptionBySourceUri(sourceUri);
    if (existing) return;

    // ── Background auth (connector pseudo-session / vault token) ──
    const triggerBus = require('../../automation/triggerBus');
    const session = await triggerBus.loadSession(ownerId);
    if (!session) {
        log.warn('[TalkAutoIngest] no Nextcloud credentials for owner — skipping', { ownerId, path: ncPath });
        return;
    }

    log.info(`[TalkAutoIngest] ingesting Talk recording ${ncPath} (room ${token}) for user ${ownerId}`);
    try {
        const out = await ingestNextcloudRecording({
            userId: ownerId, session, orgId,
            ncPath, language: settings.language,
            source: 'talk-auto', sourceUri, talkRoomToken: token,
            postSummaryBack: settings.postSummaryBack,
        });
        if (out?.dedup) log.info(`[TalkAutoIngest] already ingested ${sourceUri}`);
        else log.info(`[TalkAutoIngest] created Meeting Note ${out?.id} from ${sourceUri}` + (out?.writeBack ? ` (write-back: ${out.writeBack.ok ? 'ok' : out.writeBack.error})` : ''));
    } catch (err) {
        // Surface, don't swallow — but keep it out of the dispatcher's path.
        log.error(`[TalkAutoIngest] ingest failed for ${ncPath} [${err.code || 'error'}]: ${err.message}`);
    } finally {
        // Disarmed on the FAILURE path too. The token means "the next recording
        // in this room came from auto-record"; that recording has now arrived,
        // whether or not we managed to transcribe it. Leaving it armed made
        // every later manual recording in the room auto-transcribe against the
        // user's own setting.
        if (armed) { try { await require('./talkAutoRecord').disarmToken(ownerId, token); } catch (_) {} }
    }
}

module.exports = { maybeIngest };
