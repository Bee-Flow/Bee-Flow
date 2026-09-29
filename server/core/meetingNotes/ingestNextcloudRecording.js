// @typecheck
/**
 * ingestNextcloudRecording — download a recording from Nextcloud Files and
 * run it through Bee Flow's own transcription pipeline (the tenant's
 * configured provider), producing a Meeting Note with transcript, diarized
 * speakers, summary, AI title and action items.
 *
 * This is the single shared entry point used by BOTH:
 *   - the HTTP route `POST /api/transcriptions/from-nextcloud` (manual import)
 *   - the background Nextcloud Talk auto-ingest (`talkAutoIngest.js`)
 *
 * Auth is delegated to `nextcloudClient.resolveAuth(session, userId)`, so it
 * works transparently for OAuth, app-password and ExApp-connector sessions —
 * including the connector pseudo-session built by `triggerBus.loadSession`
 * in a background context (no live request).
 *
 * The provider-agnostic middle (transcribe → diarize → summarize → persist)
 * lives in `ingestRecordingCore.js`; this wrapper owns the Nextcloud download,
 * the Talk roster resolution and the optional Talk write-back.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const transcriptionStore = require('../../stores/transcriptionStore');
const { ingestLocalRecording, IngestError, assertDedupHitReadable } = require('./ingestRecordingCore');
// Talk's on-disk recording layout (`<attachmentFolder>/Recording/<token>/<file>`)
// lives in its own db-free module so the routes can share it.
const { parseTalkRoomToken, talkRecordingRoots, DEFAULT_RECORDING_FOLDER } = require('./talkRecordingPaths');
const log = require('../../telemetry/log');

// Audio + (Talk) video container extensions we can hand to a provider. Talk
// records audio as .ogg and video as .mp4/.webm/.ogv/.mkv.
const ACCEPTED_RECORDING_EXTS = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.mp4', '.mpeg', '.aac', '.ogv', '.mkv'];

// Hard ceiling — matches the manual-upload multer limit. Larger recordings are
// rejected with a classified error rather than silently timing out.
const MAX_RECORDING_BYTES = 500 * 1024 * 1024;

const uploadsDir = path.resolve(__dirname, '../../data/uploads/audio');

/**
 * @param {object} opts
 * @param {object} [opts.accessCtx]        the caller's access context, for a dedup hit it must be able to read
 * @param {string} opts.userId          Bee Flow user who owns the note
 * @param {object} opts.session         req.session OR triggerBus pseudo-session
 * @param {string} [opts.orgId]         org id (model-tier + EU resolution)
 * @param {string} opts.ncPath          Nextcloud Files path to the recording
 * @param {string} [opts.language]      BCP-47-ish lang code (default 'nl')
 * @param {string} [opts.provider]      explicit provider override
 * @param {string} [opts.contextTerms]  bias terms for the transcriber
 * @param {string} [opts.titleHint]     fallback title
 * @param {string} [opts.userName]      recorder's first name (speaker hint)
 * @param {string} [opts.source]        'nextcloud' | 'talk' | 'talk-auto'
 * @param {string} [opts.sourceUri]     canonical dedup key (derived if absent)
 * @param {string} [opts.talkRoomToken] originating Talk room (for write-back)
 * @param {boolean}[opts.postSummaryBack] post summary back into the Talk room
 * @returns {Promise<object>} the saved-note payload (+ `dedup`, `writeBack`)
 */
async function ingestNextcloudRecording(opts) {
    const {
        userId, session, orgId = null, ncPath,
        language = 'nl', provider: requestedProvider, contextTerms = '',
        titleHint = null, userName: userNameArg,
        source = 'nextcloud', talkRoomToken = null, postSummaryBack = false,
    } = opts || {};

    if (!userId) throw new IngestError('userId is required', { code: 'missing_user', status: 400 });
    if (!ncPath || typeof ncPath !== 'string') throw new IngestError('ncPath is required', { code: 'missing_path', status: 400 });

    const ext = path.extname(ncPath).toLowerCase();
    if (!ACCEPTED_RECORDING_EXTS.includes(ext)) {
        throw new IngestError(`Unsupported recording extension: ${ext}`, { code: 'unsupported_extension', status: 400 });
    }

    const fileName = path.basename(ncPath);
    // Tenant-scoped, exactly like `gmeet://<orgId|user:userId>/...`. A Talk room
    // token is only unique within one Nextcloud, and self-hosters routinely run
    // one Nextcloud behind several Bee Flow tenants — an unscoped
    // `talk://<token>/<file>` let tenant B's import dedup against tenant A's
    // note (the source_uri unique index is global), handing B a note id it can
    // never open and silently dropping B's recording on the floor.
    const tenant = orgId || `user:${userId}`;
    const sourceUri = opts.sourceUri
        || (talkRoomToken ? `talk://${tenant}/${talkRoomToken}/${fileName}` : `nextcloud://${userId}${ncPath}`);

    // Cheap pre-check so the same recording isn't downloaded + transcribed twice.
    const existing = await transcriptionStore.getTranscriptionBySourceUri(sourceUri);
    if (existing) {
        await assertDedupHitReadable(existing, userId, opts.accessCtx);
        return { id: existing.id, title: existing.title, dedup: true, sourceUri, writeBack: null };
    }

    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    // randomUUID, not a bare millisecond stamp: the clock is not a unique id.
    // Two ingests for the SAME user in the same millisecond (two Talk rooms, a
    // retry, or two API pods sharing the uploads volume) owned the same scratch
    // path, and whichever finished first unlinked the other one's bytes — the
    // loser's recording then failed to copy with ENOENT. Same precedent as
    // savedAudioStore's `.part` files and summaryHelpers' transcode output.
    const tmpPath = path.join(uploadsDir, `${Date.now()}-${crypto.randomUUID()}-${userId}${ext}`);

    // ── Download from Nextcloud ──────────────────────────────
    try {
        const ncClient = require('../../integrations/nextcloudClient');
        await ncClient.downloadBinary(session, userId, ncPath, tmpPath);
    } catch (err) {
        safeUnlink(tmpPath);
        if (err.message === 'NOT_CONNECTED') {
            throw new IngestError('Nextcloud is not connected for this account', { code: 'not_connected', status: 400 });
        }
        throw new IngestError(`Could not fetch from Nextcloud: ${err.message}`, { code: 'download_failed', status: 502 });
    }

    // Reject oversized recordings up front (classified, not a timeout).
    try {
        const { size } = fs.statSync(tmpPath);
        if (size > MAX_RECORDING_BYTES) {
            safeUnlink(tmpPath);
            throw new IngestError('Recording exceeds the 500 MB limit. Record audio-only or trim the file.', { code: 'recording_too_large', status: 413 });
        }
    } catch (err) {
        if (err instanceof IngestError) throw err;
    }

    // For Talk recordings, pass the real attendee roster so the model maps
    // speaker_0/1/2 to the actual participants instead of guessing.
    const participantNames = talkRoomToken ? await resolveTalkParticipantNames(session, userId, talkRoomToken, orgId) : [];

    // ── Transcribe → diarize → summarize → persist (shared core) ──
    const result = await ingestLocalRecording({
        userId, orgId, filePath: tmpPath, fileName, language,
        provider: requestedProvider, contextTerms, titleHint, userName: userNameArg,
        participantNames, source, sourceUri,
        extraStoreFields: { talkRoomToken },
    });

    // Dedup (pre-existing note or a lost concurrent-ingest race).
    if (result.dedup) {
        return { ...result, writeBack: null };
    }

    // ── Optional write-back into the Talk conversation ────
    let writeBack = null;
    if (postSummaryBack && talkRoomToken) {
        writeBack = await postSummaryToTalk({ session, userId, orgId, talkRoomToken, title: result.title, summary: result.summary, actionItems: result.actionItems });
    }

    return { ...result, talkRoomToken, writeBack };
}

/**
 * Format and post the meeting summary + action items into the originating
 * Talk conversation. Never throws — failures are returned as { ok:false }.
 */
async function postSummaryToTalk({ session, userId, orgId = null, talkRoomToken, title, summary, actionItems }) {
    try {
        const { executeNextcloudTalkTool } = require('../../integrations/nextcloudTalkTools');
        const lines = [`📝 **${title || 'Meeting summary'}**`, ''];
        if (summary) lines.push(summary.trim());
        if (Array.isArray(actionItems) && actionItems.length) {
            lines.push('', '**Action items**');
            for (const it of actionItems) {
                const who = it.assignee && it.assignee !== 'Unassigned' ? ` — ${it.assignee}` : '';
                lines.push(`- ${it.text}${who}`);
            }
        }
        lines.push('', '_Transcribed automatically by Bee Flow._');
        // Talk caps messages at 32k chars; keep a safe margin.
        let message = lines.join('\n');
        if (message.length > 30000) message = message.slice(0, 29900) + '\n…';

        // Same reason as talkAutoRecord: this write-back does not pass through
        // toolDispatcher, so it consults the scope itself. Posting a meeting
        // summary into a conversation the user excluded is a write into a room
        // they asked Bee Flow to stay out of.
        const { guardedNcCall } = require('../integrations/ncScopeGuard');
        const sendArgs = { token: talkRoomToken, message, silent: true };
        const result = await guardedNcCall('nextcloud_talk_send_message', sendArgs, { userId, orgId, session },
            () => executeNextcloudTalkTool('nextcloud_talk_send_message', sendArgs, userId, session));
        if (result?.nc_scope_denied) {
            log.warn(`[IngestNextcloudRecording] Talk write-back skipped for ${talkRoomToken}: outside the user's Nextcloud access scope`);
            return { ok: false, error: 'nc_scope_denied' };
        }
        if (result?.error) {
            log.warn(`[IngestNextcloudRecording] Talk write-back failed for ${talkRoomToken}: ${result.error}`);
            return { ok: false, error: result.error };
        }
        return { ok: true };
    } catch (err) {
        log.warn(`[IngestNextcloudRecording] Talk write-back threw for ${talkRoomToken}: ${err.message}`);
        return { ok: false, error: err.message };
    }
}

/**
 * Fetch the real display-name roster for a Talk room (best-effort). Used to
 * anchor diarization → real-name mapping. Never throws.
 */
async function resolveTalkParticipantNames(session, userId, talkRoomToken, orgId = null) {
    try {
        const { executeNextcloudTalkTool } = require('../../integrations/nextcloudTalkTools');
        // The roster is data about the conversation, and it is PERSISTED into
        // the meeting note as speaker names — so it needs the same scope check
        // as the write-back below. It sat two functions away from a guarded
        // call in the same file, which is precisely why the tripwire now
        // matches per call site instead of per file.
        const { guardedNcCall } = require('../integrations/ncScopeGuard');
        const rosterArgs = { token: talkRoomToken };
        const res = await guardedNcCall('nextcloud_talk_list_participants', rosterArgs, { userId, orgId, session },
            () => executeNextcloudTalkTool('nextcloud_talk_list_participants', rosterArgs, userId, session));
        if (res?.nc_scope_denied) return [];
        if (!res || res.error || !Array.isArray(res.participants)) return [];
        const names = res.participants
            .map(p => (p.displayName || '').trim())
            // Drop empty + obvious bot/system actors.
            .filter(n => n && !/^(bot|system|changelog)$/i.test(n));
        return Array.from(new Set(names));
    } catch (_) {
        return [];
    }
}

function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) {} }

module.exports = {
    ingestNextcloudRecording,
    // Re-exported so existing callers keep one import site for the ingest
    // pipeline; the implementation lives in talkRecordingPaths.js.
    parseTalkRoomToken,
    talkRecordingRoots,
    DEFAULT_RECORDING_FOLDER,
    ACCEPTED_RECORDING_EXTS,
    IngestError,
};
