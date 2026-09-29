/**
 * ingestRecordingCore — provider-agnostic middle of the Meeting Notes ingest
 * pipeline. Takes a recording that already sits on local disk and turns it
 * into a Meeting Note: transcription (tenant-configured or explicitly pinned
 * provider), diarized speakers anchored to a participant roster, summary,
 * AI title and action items.
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
const configStore = require('../../stores/configStore');
const {
    transcribeWithWhisperX,
    transcribeWithScaleway,
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
    toContextBias,
    formatTime,
} = require('./summaryHelpers');
const { stampForTemplate } = require('./summaryStamp');
const log = require('../../telemetry/log');

const savedDir = path.resolve(__dirname, '../../data/uploads/saved-recordings');

class IngestError extends Error {
    constructor(message, { code = 'ingest_failed', status = 500 } = {}) {
        super(message);
        this.name = 'IngestError';
        this.code = code;
        this.status = status;
    }
}

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
 * @param {object} opts
 * @param {string} opts.userId             Bee Flow user who owns the note
 * @param {string} [opts.orgId]            org id (model-tier + EU resolution)
 * @param {string} opts.filePath           local recording file (consumed)
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
 * @returns {Promise<object>} the saved-note payload (+ `dedup`)
 */
async function ingestLocalRecording(opts) {
    const {
        userId, orgId = null, filePath, fileName: fileNameArg,
        language = 'nl', provider: requestedProvider, contextTerms = '',
        titleHint = null, userName: userNameArg, participantNames = [],
        source = 'upload', sourceUri = null, extraStoreFields = {},
    } = opts || {};

    if (!userId) throw new IngestError('userId is required', { code: 'missing_user', status: 400 });
    if (!filePath || typeof filePath !== 'string') throw new IngestError('filePath is required', { code: 'missing_path', status: 400 });

    const fileName = fileNameArg || path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

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

        // ── Provider selection (request → admin config → voxtral) ──
        const localEnabled = (await configStore.getConfig('local_whisper_enabled')) !== false;
        let provider = await configStore.getConfig('transcription_provider') || 'voxtral';
        const reqP = String(requestedProvider || '').trim().toLowerCase();
        if (reqP === 'local' && localEnabled) provider = 'local';
        else if (['voxtral', 'whisperx', 'scaleway', 'azure', 'whisper_azure', 'pyannote'].includes(reqP)) provider = reqP;

        // ── Transcribe ───────────────────────────────────────
        let response;
        // Only the pyannote provider can fill these (see below).
        let voiceprintMapping = null;
        let voiceprintRoster = [];
        let voiceprintRuledOut = null;
        let voiceprintInfo = null;
        if (provider === 'local') {
            const { transcribeLocally } = require('../voice/localWhisper');
            const local = await transcribeLocally(filePath, { language });
            if (!local) {
                safeUnlink(filePath);
                throw new IngestError('Local transcription unavailable. Pick a cloud provider.', { code: 'local_whisper_unavailable', status: 503 });
            }
            response = { text: local.text, segments: local.segments };
        } else if (provider === 'whisperx') {
            response = await transcribeWithWhisperX(filePath, fileName, language, contextTerms || '');
        } else if (provider === 'scaleway') {
            response = await transcribeWithScaleway(filePath, fileName, language, contextTerms || '');
        } else if (provider === 'pyannote') {
            // Self-staging via pyannote's own media store — works for auto-import
            // paths too (no public URL needed, unlike whisper_azure).
            // Talk/Meet supply the attendee roster automatically, which is also
            // the best possible prioritiser when an org has more enrolled
            // members than one identify job can carry.
            const { transcribeWithPyannote } = require('../voice/pyannoteClient');
            const p = await transcribeWithPyannote(filePath, {
                language, orgId, recorderUserId: userId, attendees: participantNames,
            });
            response = p;
            voiceprintMapping = p.voiceprintMapping;
            voiceprintRoster = p.voiceprintRoster || [];
            voiceprintRuledOut = p.voiceprintRuledOut;
            voiceprintInfo = p.voiceprintInfo;
        } else {
            // Voxtral default (other cloud providers reachable via manual upload).
            const apiKey = await configStore.getSecret('mistral_api_key');
            if (!apiKey) {
                safeUnlink(filePath);
                throw new IngestError('Mistral API key not configured.', { code: 'missing_mistral_key', status: 400 });
            }
            const client = require('./voxtralClient').createVoxtralClient(apiKey);
            const fileContent = fs.readFileSync(filePath);
            const contextBias = toContextBias(contextTerms);
            response = await client.audio.transcriptions.complete({
                model: 'voxtral-mini-2602',
                file: { fileName, content: fileContent },
                diarize: true, language,
                timestampGranularities: ['segment'],
                ...(contextBias.length ? { contextBias } : {}),
            });
        }

        // ── Build transcript + diarized speakers ─────────────
        let { merged, transcript, speakers, totalDuration } = buildTranscriptArtifacts(response.segments || []);
        // Same guard as the upload and reprocess routes: an empty result is a
        // failure, not a note. Without it an auto-imported Talk/Meet recording
        // that transcribed to nothing is saved as a finished, empty note that
        // the user cannot retry.
        if (!merged.length) {
            safeUnlink(filePath);
            throw new IngestError('Transcription returned no segments.', { code: 'empty_transcription', status: 502 });
        }

        // Map diarization speaker IDs → real names (parity with upload route).
        // When the caller supplies the real attendee roster the model maps
        // speaker_0/1/2 to the actual participants instead of guessing.
        // Pass the stats rows, not bare IDs — the speaking times are what let
        // the model separate real participants from short diarization fragments.
        const nameMapping = speakers.length
            ? await identifySpeakerNames(
                merged, speakers, language, userName, orgId,
                [...(participantNames || []), ...voiceprintRoster],
                // No speaker-count input on the auto-import paths — Talk/Meet
                // supply an attendee roster instead, which is stronger.
                { lockedNames: voiceprintMapping, ruledOutNames: voiceprintRuledOut },
            )
            : null;
        // Floor unnamed ids to clean "Spreker N"/"Speaker N" — never leak raw ids.
        const filledMapping = fillGenericSpeakerLabels(speakers, nameMapping, language);
        ({ merged, transcript, speakers } = applySpeakerNames(merged, filledMapping));
        speakers = tagSpeakerProvenance(speakers, voiceprintMapping);

        // ── Summary, title, action items ─────────────────────
        const defaultTemplate = await resolveOwnerDefaultTemplate(userId, orgId);
        const rawSummary = await generateMeetingSummary(transcript, language, orgId, { templatePrompt: defaultTemplate?.prompt || null });
        // VÓÓR de notitieregels, want een mislukte artefactpass is er één van.
        // Deze schrijver gaf `artifacts.*` rauw door: een omgevallen of
        // onparseerbare pass leverde dan een afgeronde notitie op die beweert
        // dat er niets is afgesproken, en een auto-import heeft geen enkel
        // ander kanaal om dat te melden — er is geen scherm dat toekeek.
        const artifacts = await extractMeetingArtifacts(transcript, language, orgId, {
            meetingDateIso: new Date().toISOString().slice(0, 10),
            personNames: [...speakers.map((s) => s.id), ...(participantNames || [])],
        });
        const usable = artifactsUsable(artifacts);
        if (!usable) {
            log.warn(`[IngestCore] ${fileName}: artifact extraction failed — the note says so instead of claiming an empty meeting.`);
        }
        // An auto-import has no UI to report to, so the note's summary is the
        // only place to explain why voice recognition didn't name everyone —
        // and why this note has no action items.
        const notices = buildPipelineNotices({ voiceprint: voiceprintInfo, artifactsFailed: !usable, language });
        const summary = notices.length ? `${notices.join('\n')}\n\n${rawSummary || ''}`.trim() : rawSummary;
        let title = titleHint || fileName.replace(/\.[^/.]+$/, '');
        if (summary) {
            const aiTitle = await generateMeetingTitle(summary, language, orgId);
            if (aiTitle) title = aiTitle;
        }
        const chapters = await generateChapters(transcript, language, orgId);
        const speakerSummaries = await generateSpeakerSummaries(transcript, speakers.map((s) => s.id), language, orgId);
        speakers = applySpeakerSummaries(speakers, speakerSummaries);

        // ── Persist audio for playback ───────────────────────
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
        const { savedAudioKey, persistSavedAudioToStorage, discardSavedAudio } = require('./savedAudioStore');
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

        // ── Save the note ────────────────────────────────────
        // The audio copies above exist before any row references them, so every
        // exit from here that does not produce a row must throw them away.
        const savedAudio = { audioPath: fs.existsSync(audioPath) ? audioPath : null, audioStorageKey };
        let saved;
        try {
            saved = await transcriptionStore.createTranscription({
                userId, organizationId: orgId, title, fileName, language,
                durationSeconds: Math.round(totalDuration),
                speakerCount: speakers.length, segmentCount: merged.length,
                fullText: response.text || '', transcript, segments: merged, speakers,
                summary, audioPath: savedAudio.audioPath || '',
                audioStorageKey,
                provider,
                // Een nieuwe rij, dus hier valt niets te bewaren — maar er
                // wordt ook niets geclaimd wat de pass niet gevonden heeft.
                // De notitieregel hierboven zegt waarom deze leeg zijn.
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
                // Welk sjabloon en welke versie ervan deze samenvatting
                // schreef. Geen standaardsjabloon → beide null, en het scherm
                // zwijgt in plaats van een sjabloon te noemen.
                ...stampForTemplate(defaultTemplate),
                ...extraStoreFields,
            });
        } catch (e) {
            await discardSavedAudio(savedAudio);
            throw e;
        }

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
        if (voiceprintInfo?.detail?.length) {
            try {
                await transcriptionStore.updateTranscription(saved.id, userId, { voiceprintMatches: voiceprintInfo.detail });
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
        const { dispatchEvent } = require('../../automation/triggerBus');
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

function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) {} }

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
