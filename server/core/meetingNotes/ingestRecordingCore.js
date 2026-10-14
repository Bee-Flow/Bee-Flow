/**
 * ingestRecordingCore — provider-agnostic middle of the Meeting Notes ingest
 * pipeline. Takes a recording that already sits on local disk and turns it
 * into a Meeting Note: transcription (tenant-configured or explicitly pinned
 * provider, ./ingestTranscription.js), diarized speakers anchored to a
 * participant roster, summary, AI title and action items.
 *
 * Shared by the provider wrappers (`ingestNextcloudRecording.js`,
 * `ingestGmeetRecording.js`) which own download/auth/roster resolution and
 * any provider-specific write-back. The core CONSUMES `filePath`: on success
 * the audio is copied into saved-recordings and the original removed; on
 * failure or dedup the file is unlinked.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const transcriptionStore = require('../../stores/transcriptionStore');
const {
    identifySpeakerNames,
    generateMeetingSummary,
    generateMeetingTitle,
    extractMeetingArtifacts,
    generateSpeakerSummaries,
    applySpeakerSummaries,
    tagSpeakerProvenance,
    generateChapters,
    buildTranscriptArtifacts,
    applySpeakerNames,
    fillGenericSpeakerLabels,
    buildPipelineNotices,
    artifactsUsable,
    formatTime,
} = require('./summaryHelpers');
const { stampForTemplate } = require('./summaryStamp');
const { IngestError, safeUnlink } = require('./ingestShared');
const { chooseProvider, transcribe } = require('./ingestTranscription');
const log = require('../../telemetry/log');
// The trigger bus lives in automation/, a feature: injected (../automationRunner/featurePorts.js).
const { runnerPort } = require('../automationRunner/featurePorts');

const savedDir = path.resolve(__dirname, '../../data/uploads/saved-recordings');

/**
 * A `source_uri` dedup hit proves the recording was already imported — it does
 * NOT prove the caller may read the resulting note. Returning `{id, title}`
 * regardless leaked a colleague's meeting title and handed the client an id
 * that 404s the moment it opens it.
 *
 * `accessCtx` is optional: background workers (auto-import) run as the note's
 * own owner and pass none, in which case only ownership is checked.
 */
async function assertDedupHitReadable(existing, userId, accessCtx) {
    if (!existing) return;
    if (existing.user_id === userId) return;
    const transcriptionStore = require('../../stores/transcriptionStore');
    const readable = await transcriptionStore.canReadTranscription(existing.id, userId, accessCtx || {});
    if (readable) return;
    throw new IngestError(
        'This recording has already been imported by someone else. Ask them to share the meeting note with you.',
        { code: 'already_imported', status: 409 }
    );
}

/**
 * Map diarization speaker IDs → real names (parity with upload route). When
 * the caller supplies the real attendee roster the model maps speaker_0/1/2 to
 * the actual participants instead of guessing. Pass the stats rows, not bare
 * IDs — the speaking times are what let the model separate real participants
 * from short diarization fragments. The platform already named every speaker:
 * keep those names as they are.
 */
async function nameSpeakers(built, { speakersNamed, language, userName, orgId, participantNames, voiceprint }) {
    const { speakers } = built;
    const nameMapping = speakersNamed
        ? Object.fromEntries(speakers.map((s) => [s.id, s.id]))
        : speakers.length
            ? await identifySpeakerNames(
                built.merged, speakers, language, userName, orgId,
                [...(participantNames || []), ...voiceprint.roster],
                // No speaker-count input on the auto-import paths — Talk/Meet
                // supply an attendee roster instead, which is stronger.
                { lockedNames: voiceprint.mapping, ruledOutNames: voiceprint.ruledOut },
            )
            : null;
    // Floor unnamed ids to clean "Spreker N"/"Speaker N" — never leak raw ids.
    const filledMapping = fillGenericSpeakerLabels(speakers, nameMapping, language);
    const named = applySpeakerNames(built.merged, filledMapping);
    return { ...named, speakers: tagSpeakerProvenance(named.speakers, voiceprint.mapping) };
}

/** ── Summary, title, action items, chapters, per-speaker summaries ── */
async function writeSummary(named, { userId, orgId, language, fileName, titleHint, participantNames, voiceprint }) {
    const { transcript } = named;
    const defaultTemplate = await resolveOwnerDefaultTemplate(userId, orgId);
    const rawSummary = await generateMeetingSummary(transcript, language, orgId, { templatePrompt: defaultTemplate?.prompt || null });
    // BEFORE the note's notice lines, because a failed artifact pass is one
    // of them. This writer used to pass `artifacts.*` through raw: a pass that
    // fell over or could not be parsed then produced a finished note claiming
    // nothing was agreed, and an auto-import has no other channel at all to
    // report that — there was no screen watching.
    const artifacts = await extractMeetingArtifacts(transcript, language, orgId, {
        meetingDateIso: new Date().toISOString().slice(0, 10),
        personNames: [...named.speakers.map((s) => s.id), ...(participantNames || [])],
    });
    const usable = artifactsUsable(artifacts);
    if (!usable) {
        log.warn(`[IngestCore] ${fileName}: artifact extraction failed — the note says so instead of claiming an empty meeting.`);
    }
    // An auto-import has no UI to report to, so the note's summary is the
    // only place to explain why voice recognition didn't name everyone —
    // and why this note has no action items.
    const notices = buildPipelineNotices({ voiceprint: voiceprint.info, artifactsFailed: !usable, language });
    const summary = notices.length ? `${notices.join('\n')}\n\n${rawSummary || ''}`.trim() : rawSummary;
    let title = titleHint || fileName.replace(/\.[^/.]+$/, '');
    if (summary) {
        const aiTitle = await generateMeetingTitle(summary, language, orgId);
        if (aiTitle) title = aiTitle;
    }
    const chapters = await generateChapters(transcript, language, orgId);
    const speakerSummaries = await generateSpeakerSummaries(transcript, named.speakers.map((s) => s.id), language, orgId);
    const speakers = applySpeakerSummaries(named.speakers, speakerSummaries);
    return { defaultTemplate, artifacts, usable, summary, title, chapters, speakers };
}

/**
 * ── Save the note ── The audio copies exist before any row references them,
 * so every exit from here that does not produce a row throws them away.
 */
async function saveNote(row, savedAudio) {
    const { discardSavedAudio } = require('./savedAudioStore');
    try {
        return await transcriptionStore.createTranscription(row);
    } catch (e) {
        await discardSavedAudio(savedAudio);
        throw e;
    }
}

/**
 * @param {object} opts
 * @param {string} opts.userId             Bee Flow user who owns the note
 * @param {string} [opts.orgId]            org id (model-tier + EU resolution)
 * @param {string} [opts.filePath]         local recording file (consumed); absent only with transcriptResponse
 * @param {string} [opts.fileName]         display name (default: basename)
 * @param {string} [opts.language]         BCP-47-ish lang code (default 'nl')
 * @param {string} [opts.provider]         explicit provider override
 * @param {string} [opts.contextTerms]     bias terms for the transcriber
 * @param {string} [opts.titleHint]        fallback title
 * @param {string} [opts.userName]         recorder's first name (speaker hint)
 * @param {string[]}[opts.participantNames] real attendee roster for diarization
 * @param {string} [opts.source]           provenance tag ('nextcloud', 'gmeet', …)
 * @param {string} [opts.sourceUri]        canonical dedup key
 * @param {object} [opts.extraStoreFields] extra createTranscription fields
 * @param {{text?: string, segments: object[]}} [opts.transcriptResponse]
 *        an already-made transcript (Teams VTT): transcription is skipped and
 *        `filePath` may be absent, in which case the note has no audio
 * @param {boolean} [opts.speakersNamed]   the segments' speakerIds are real
 *        names (from the platform), so the LLM naming pass is skipped
 * @returns {Promise<object>} the saved-note payload (+ `dedup`)
 */
async function ingestLocalRecording(opts) {
    const {
        userId, orgId = null, filePath, fileName: fileNameArg,
        language = 'nl', provider: requestedProvider, contextTerms = '',
        titleHint = null, userName: userNameArg, participantNames = [],
        source = 'upload', sourceUri = null, extraStoreFields = {},
        transcriptResponse = null, speakersNamed = false,
    } = opts || {};

    if (!userId) throw new IngestError('userId is required', { code: 'missing_user', status: 400 });
    if (!transcriptResponse && (!filePath || typeof filePath !== 'string')) {
        throw new IngestError('filePath is required', { code: 'missing_path', status: 400 });
    }

    const fileName = fileNameArg || (filePath ? path.basename(filePath) : 'transcript');
    const ext = filePath ? path.extname(filePath).toLowerCase() : '';

    // Cheap pre-check so an already-ingested recording isn't transcribed twice.
    if (sourceUri) {
        const existing = await transcriptionStore.getTranscriptionBySourceUri(sourceUri);
        if (existing) {
            safeUnlink(filePath);
            return { id: existing.id, title: existing.title, dedup: true, sourceUri };
        }
    }

    try {
        const userName = userNameArg !== undefined ? userNameArg : await resolveUserFirstName(userId);
        const provider = await chooseProvider(requestedProvider, transcriptResponse);
        const { response, voiceprint } = await transcribe(provider, {
            filePath, fileName, language, contextTerms, orgId, userId, participantNames, transcriptResponse,
        });

        // ── Build transcript + diarized speakers ─────────────
        const built = buildTranscriptArtifacts(response.segments || []);
        // Same guard as the upload and reprocess routes: an empty result is a
        // failure, not a note. Without it an auto-imported Talk/Meet recording
        // that transcribed to nothing is saved as a finished, empty note that
        // the user cannot retry.
        if (!built.merged.length) {
            safeUnlink(filePath);
            throw new IngestError('Transcription returned no segments.', { code: 'empty_transcription', status: 502 });
        }
        const totalDuration = built.totalDuration;
        const named = await nameSpeakers(built, { speakersNamed, language, userName, orgId, participantNames, voiceprint });
        const { merged, transcript } = named;
        const { defaultTemplate, artifacts, usable, summary, title, chapters, speakers } = await writeSummary(named, {
            userId, orgId, language, fileName, titleHint, participantNames, voiceprint,
        });

        // ── Persist audio for playback ───────────────────────
        // A transcript-only ingest (Teams VTT without a recording) has no audio.
        const { discardSavedAudio } = require('./savedAudioStore');
        const { audioPath, audioStorageKey } = filePath
            ? await persistAudioCopy(filePath, userId, ext)
            : { audioPath: null, audioStorageKey: null };
        const savedAudio = { audioPath: audioPath && fs.existsSync(audioPath) ? audioPath : null, audioStorageKey };
        const saved = await saveNote({
            userId, organizationId: orgId, title, fileName, language,
            durationSeconds: Math.round(totalDuration),
            speakerCount: speakers.length, segmentCount: merged.length,
            fullText: response.text || '', transcript, segments: merged, speakers,
            summary, audioPath: savedAudio.audioPath || '',
            audioStorageKey,
            provider,
            // A new row, so there is nothing to keep here — but nothing is
            // claimed that the pass did not find either. The notice line
            // above says why these are empty.
            actionItems: usable ? artifacts.actionItems : [],
            decisions: usable ? artifacts.decisions : [],
            questions: usable ? artifacts.questions : [],
            tags: usable ? artifacts.tags : [],
            chapters,
            // Persist the roster the auto-import resolved (Talk participants,
            // Meet attendees). It was only ever used in-memory for naming, so
            // re-transcribing an auto-imported note started blind and relabelled
            // everyone "Spreker 1/2" — the manual upload path has always stored
            // it. Done here rather than in each wrapper so every source gets it.
            attendees: participantNames,
            source, sourceUri,
            // Which template, and which version of it, wrote this summary. No
            // default template → both null, and the screen stays silent
            // instead of naming a template.
            ...stampForTemplate(defaultTemplate),
            ...extraStoreFields,
        }, savedAudio);

        // Concurrent ingest won the race — surface the existing note. Our copies
        // belong to nothing: the winner has its own.
        if (saved.dedup) {
            await discardSavedAudio(savedAudio);
            return { id: saved.id, title, dedup: true, sourceUri };
        }

        /**
         * `meeting.processed` — ONE emission point, here.
         *
         * After the dedup check, so a concurrent ingest that lost the race does
         * not announce a note it did not create. And here rather than further
         * down: the summary, the actions, the decisions and the tags are all
         * arguments to the `createTranscription` above, so the row is complete
         * the moment it exists. What follows is the voiceprint UPDATE, which is
         * diagnostic and changes nothing a subscriber reads.
         *
         * Fire-and-forget with its own catch: a bus that is down must not fail
         * an ingest whose note is already saved.
         */
        emitMeetingProcessed({
            transcriptionId: saved.id,
            tags: usable ? artifacts.tags : [],
            userId,
            orgId,
        });

        // Diagnostic trail for the voice matches. A follow-up UPDATE rather
        // than another createTranscription parameter: it only applies to one
        // provider with at least one enrolled colleague, and the INSERT is
        // already 29 columns wide.
        if (voiceprint.info?.detail?.length) {
            try {
                await transcriptionStore.updateTranscription(saved.id, userId, { voiceprintMatches: voiceprint.info.detail });
            } catch (e) { log.warn('[IngestCore] could not persist voiceprint matches:', e.message); }
        }

        return {
            id: saved.id, title, fileName, language,
            duration: formatTime(totalDuration), durationSeconds: Math.round(totalDuration),
            speakerCount: speakers.length, segmentCount: merged.length,
            speakers, fullText: response.text || '',
            transcript, segments: merged, summary, actionItems: usable ? artifacts.actionItems : [],
            source, sourceUri, dedup: false,
        };
    } catch (err) {
        safeUnlink(filePath);
        if (err instanceof IngestError) throw err;
        throw new IngestError(err.message, { code: 'transcription_failed', status: 500 });
    }
}

/**
 * Announce that a meeting note is ready to be read.
 *
 * ── ONE FUNCTION, THREE CALLERS, ONE EVENT ──────────────────────────
 * A note becomes readable in three ways: it is ingested, it is reprocessed,
 * or its summary is regenerated. All three have to reach the same subscribers
 * — a `meeting_tag` knowledge source that missed a regenerate would hold the
 * OLD summary and nobody would know why. So the payload is built once here
 * rather than three times at three call sites that would drift.
 *
 * `reprocessed: true` distinguishes the later two. The bus dedupes on
 * `transcriptionId`, and a re-run has to get past that: it is precisely the
 * case where the content changed.
 *
 * Never throws. The note is already saved by the time this runs, and a bus
 * that is down is not a reason to fail an ingest.
 */
function emitMeetingProcessed({ transcriptionId, tags, userId, orgId, reprocessed = false }) {
    if (!transcriptionId) return;
    try {
        const { dispatchEvent } = runnerPort('triggerBus');
        Promise.resolve(dispatchEvent({
            provider: 'meeting-notes',
            event: 'meeting.processed',
            payload: {
                transcriptionId,
                tags: Array.isArray(tags) ? tags : [],
                orgId: orgId || null,
                ...(reprocessed ? { reprocessed: true } : {}),
            },
            userId,
            orgId: orgId || null,
        })).catch(e => log.warn('[MeetingNotes] meeting.processed dispatch failed:', e.message));
    } catch (e) {
        log.warn('[MeetingNotes] meeting.processed tap unavailable:', e.message);
    }
}

/**
 * Copy the recording to saved-recordings (playback) and, when configured, to
 * object storage, then delete the scratch file. Returns where it landed.
 */
async function persistAudioCopy(filePath, userId, ext) {
    if (!fs.existsSync(savedDir)) fs.mkdirSync(savedDir, { recursive: true });
    // randomUUID for the same reason as the scratch names upstream, but the
    // stakes here are higher: a collision in saved-recordings does not fail
    // loudly, it silently re-points one note's playback at another meeting's
    // audio (and, via savedAudioKey, at the other note's object-storage copy).
    // Nothing parses this basename — savedAudioBackfill matches on the full
    // path — so the extra segment is safe for existing rows.
    const savedBase = `${Date.now()}-${crypto.randomUUID()}-${userId}${ext}`;
    const audioPath = path.join(savedDir, savedBase);
    try { fs.copyFileSync(filePath, audioPath); }
    catch (e) {
        // Was `catch (_) {}` with no log at all: the note then quietly got an
        // empty audio_path and nobody knew until a replay failed.
        log.error(`[IngestCore] local audio copy failed (${audioPath}): ${e.message}`);
    }
    // Durable object-storage copy (when configured) so replay + reprocess
    // survive pod restarts / replicas — same backstop as the upload route.
    let audioStorageKey = null;
    const { savedAudioKey, persistSavedAudioToStorage } = require('./savedAudioStore');
    try {
        const buf = fs.readFileSync(fs.existsSync(audioPath) ? audioPath : filePath);
        const persisted = await persistSavedAudioToStorage(savedAudioKey(savedBase), buf, ext);
        audioStorageKey = persisted.ok ? persisted.key : null;
        // This try/catch used to swallow everything; a `{ok:false}` must not
        // slip through it silently the way the old `null` did.
        if (!persisted.ok && persisted.reason !== 'not_configured') {
            log.error(`[IngestCore] No durable audio copy for ${savedBase} (${persisted.reason}) — queued for repair`);
        }
    } catch (e) { log.error('[IngestCore] durable audio copy failed:', e.message); }
    safeUnlink(filePath);
    return { audioPath, audioStorageKey };
}

async function resolveUserFirstName(userId) {
    try {
        const { getUser } = require('../../stores/userStore');
        const u = await getUser(userId);
        return u?.firstName || u?.displayName || null;
    } catch (_) { return null; }
}

/**
 * Resolve the note owner's default summary TEMPLATE (personal ▸ group ▸ org) so
 * a saved default also styles auto-ingested (Talk / Meet) notes.
 * Best-effort — returns null (→ built-in first-generation prompt) on any failure.
 *
 * De hele rij, want de notitie wordt ermee gestempeld (welk sjabloon, welke
 * versie): uit een promptstring is geen id terug te winnen. null stempelt
 * niets — de ingebouwde eerste-generatieprompt is geen van de vijf ingebouwde
 * sjablonen, dus er valt niets waars te melden.
 */
async function resolveOwnerDefaultTemplate(userId, orgId) {
    try {
        const { getUser } = require('../../stores/userStore');
        const summaryTemplateStore = require('../../stores/summaryTemplateStore');
        const u = await getUser(userId);
        let groupIds = [];
        if (u) {
            if (Array.isArray(u.groups)) groupIds = u.groups;
            else { try { groupIds = JSON.parse(u.groups || '[]'); } catch (_) { /* ignore */ } }
        }
        return await summaryTemplateStore.resolveDefaultTemplate({ userId, orgIds: orgId ? [orgId] : [], groupIds });
    } catch (_) {
        return null;
    }
}


module.exports = {
    ingestLocalRecording,
    IngestError,
    assertDedupHitReadable,
    // The ONE emission point for meeting.processed. /reprocess and
    // /regenerate-summary call it with `reprocessed: true` rather than
    // building the payload again — a second copy is how a subscriber ends up
    // hearing about an ingest and not about a regenerate.
    emitMeetingProcessed,
};
