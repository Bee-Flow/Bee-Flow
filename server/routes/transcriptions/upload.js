/**
 * Transcriptions — upload & transcribe.
 *
 * POST / — multipart audio upload → 202 + background pipeline (transcribe →
 * diarize → name speakers → summary / artifacts / chapters), written to the
 * 'processing' note created up front.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const transcriptionStore = require('../../stores/transcriptionStore');
const configStore = require('../../stores/configStore');
const { requireAuth } = require('../../auth/permissions');
const { asM4aIfAdts } = require('../../core/voice/audioPreprocess');
const {
    parseSpeakerCount,
    resolveUserOrgFromReq,
    resolveDefaultTemplateForReq,
    VOXTRAL_TIMEOUT_MS,
} = require('./shared');
const { stampForTemplate } = require('../../core/meetingNotes/summaryStamp');
const meetingFiling = require('../../projects/meetingFiling');

// Multer for audio file upload. Scratch in /tmp; the kept copies are
// saved-recordings and RustFS, made further down.
const { AUDIO_SCRATCH_DIR: uploadsDir } = require('../../core/meetingNotes/savedAudioStore');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
    dest: uploadsDir,
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const allowed = ['.mp3', '.wav', '.m4a', '.ogg', '.webm', '.flac', '.mp4', '.mpeg', '.aac'];
        if (allowed.includes(ext) || file.mimetype?.startsWith('audio/')) {
            cb(null, true);
        } else {
            cb(new Error('Unsupported audio format. Supported: MP3, WAV, M4A, OGG, WEBM, FLAC, MP4, AAC'));
        }
    },
});

// Every engine the pipeline knows how to drive. A request may name one of
// these; anything else is rejected rather than silently falling through to the
// configured default (which made a typo look like it had been honoured).
const KNOWN_PROVIDERS = ['voxtral', 'whisperx', 'scaleway', 'azure', 'whisper_azure', 'pyannote', 'local'];

/**
 * Which engines this workspace lets a user pick per upload.
 *
 * Admins set `transcription_providers_allowed` (an array). Unset means "any
 * known engine", which is the historical behaviour — narrowing it is opt-in so
 * an upgrade never breaks the "Switch engine & retry" button. The configured
 * default is always allowed, and `local` additionally requires
 * `local_whisper_enabled`.
 */
async function resolveAllowedProviders(localEnabled) {
    const configured = await configStore.getConfig('transcription_provider') || 'voxtral';
    const raw = await configStore.getConfig('transcription_providers_allowed');
    let allowed = Array.isArray(raw) && raw.length
        ? raw.map(p => String(p).trim().toLowerCase()).filter(p => KNOWN_PROVIDERS.includes(p))
        : [...KNOWN_PROVIDERS];
    if (!allowed.includes(configured)) allowed.push(configured);
    if (!localEnabled) allowed = allowed.filter(p => p !== 'local');
    return allowed;
}

// Meeting-notes pipeline helpers (model tiers, diarization naming, summary /
// title / action-item generation) live in a shared module so the background
// Nextcloud Talk auto-ingest can reuse the exact same logic.
const {
    identifySpeakerNames,
    generateMeetingSummary,
    generateMeetingTitle,
    extractMeetingArtifacts,
    generateChapters,
    generateSpeakerSummaries,
    applySpeakerSummaries,
    tagSpeakerProvenance,
    toContextBias,
    applySpeakerNames,
    fillGenericSpeakerLabels,
    buildTranscriptArtifacts,
    buildPipelineNotices,
    artifactsUsable,
} = require('../../core/meetingNotes/summaryHelpers');

/**
 * Transcribe audio via the self-hosted WhisperX FastAPI service.
 * Returns a response object with the same shape as Voxtral output.
 */
const { transcribeWithWhisperX, transcribeWithScaleway } = require('../../core/meetingNotes/summaryHelpers');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { worded, bodyOf, choice } = require('./schemas');

// ── Wat een upload mag dragen ───────────────────────────────────────
//
// Multipart, dus het schema staat ACHTER multer: die leest de stream en zet
// de tekstvelden pas daarna op `req.body` (het bestand gaat naar `req.file`,
// niet naar de body). Een `validate()` ervoor zou dus een lege body zien.
//
// `.strict()`, want elk veld hieronder verandert wat er met de opname
// GEBEURT, en elk veld viel stil weg als je het verkeerd spelde:
// `{languge:'en'}` liet een Engelse vergadering in het Nederlands
// transcriberen, `{atendees:'Tom, Anna'}` liet de namenlijst vallen die
// sprekerherkenning haar enige houvast geeft, en `{provder:'local'}` stuurde
// de audio naar de standaarddienst in plaats van naar de zelfgehoste.
//
// `capture_mode` was bovendien een stille terugval — `=== 'recording' ?
// 'recording' : 'upload'` — dus een browseropname die hier verkeerd gespeld
// binnenkwam werd als geüpload bestand geboekt. Dat onderscheid is precies
// wat bepaalt of de "deze bytes bestaan nergens anders"-waarschuwing verschijnt.
//
// Alles is tekst: FormData draagt geen andere typen.
const CAPTURE_TEXT = 'capture_mode is "recording" of "upload".';
const UploadBody = bodyOf({
    capture_mode: choice(['recording', 'upload'], CAPTURE_TEXT).optional(),
    language: worded('language is een taalcode.').trim().min(1).optional(),
    title: worded('Een titel is tekst.').optional(),
    context_terms: worded('context_terms is tekst.').optional(),
    attendees: worded('attendees is tekst met namen.').optional(),
    // parseSpeakerCount klemt hem daarna op 1..50; wat het schema toevoegt is
    // dat "twee" geen stille Auto meer is.
    num_speakers: z.coerce.number({ invalid_type_error: 'num_speakers is een getal.' })
        .int('num_speakers is een heel getal.').optional(),
    provider: worded('provider is de naam van een transcriptiedienst.').trim().min(1).optional(),
    // Files the new note into a collaborative project (editor or owner there;
    // see projects/meetingFiling.js). Empty means none: a form field is always text.
    projectId: worded('projectId is the id of a project.').trim().max(200, 'projectId is the id of a project.').optional(),
});

// ── Upload & transcribe ──────────────────────────────────

router.post('/', requireAuth, upload.single('audio'), validate({ body: UploadBody }), async (req, res) => {
    const userId = req.session.user.id;
    const userOrgId = await resolveUserOrgFromReq(req);

    if (!req.file) {
        return res.status(400).json({ error: 'No audio file uploaded' });
    }

    // A project to file the note into is checked BEFORE anything is saved or
    // transcribed: a refusal here must cost nothing and leave nothing behind.
    let projectId = null;
    if (req.body.projectId) {
        const dropUpload = () => { try { fs.unlinkSync(req.file.path); } catch (_) { /* multer's temp file may already be gone */ } };
        let target;
        try {
            target = await meetingFiling.resolve(userId, userOrgId, req.body.projectId);
        } catch (err) {
            // The access check could not be answered: refuse, never file blind.
            dropUpload();
            log.error('[Transcriptions] project access check failed:', err.message);
            return res.status(503).json({ error: 'Could not check access to that project. Try again in a moment.', code: 'project_check_unavailable' });
        }
        if (!target.ok) {
            dropUpload();
            return res.status(target.status).json({ error: target.error, code: target.code });
        }
        projectId = target.projectId;
    }

    const language = req.body.language || 'nl';
    const contextTerms = req.body.context_terms || '';
    // Who was in the room. This is the single strongest input to speaker
    // naming: it turns an open-ended "who are these 29 voice IDs?" — which text
    // alone cannot answer — into assignment onto a known, closed set.
    const attendees = toContextBias(req.body.attendees || '');
    // Optional per-meeting speaker-count hint (Auto when absent). Drives
    // pyannote's numSpeakers and Azure Whisper's diarization min/max.
    const numSpeakers = parseSpeakerCount(req.body.num_speakers);
    let title = req.body.title || req.file.originalname || 'Untitled';

    // Async pipeline bookkeeping — declared out here so the catch can reach them.
    // Once the 'processing' note is created and the 202 sent, transcriptionId is
    // set and all further outcomes are written to the note, not the HTTP response.
    let transcriptionId = null;
    let savedAudioPath = '';

    try {
        // The transcription pipeline (transcribe → diarize → summarise) can take
        // many minutes on long recordings; keep the socket alive long enough to
        // send the initial 202, then the work continues in the background.
        const routeTimeout = Number(process.env.TRANSCRIBE_ROUTE_TIMEOUT_MS) || 1800000;
        req.setTimeout(routeTimeout);
        res.setTimeout(routeTimeout);

        // NOT read into memory here. The cap is 500 MB and only ONE provider
        // (Voxtral) wants the bytes in hand — everything else takes a path.
        // Buffering up front meant a 500 MB upload cost 500 MB of heap for the
        // entire multi-minute pipeline, on every replica, whatever the engine.
        const fileName = req.file.originalname || 'audio.mp3';
        const uploadBytes = req.file.size || 0;

        // Fetch the logged-in user's display name for speaker ID anchoring
        let userName = null;
        try {
            const { getUser } = require('../../stores/userStore');
            const userRecord = await getUser(userId);
            userName = userRecord?.firstName || userRecord?.displayName || null;
        } catch (_) {}

        // Provider precedence:
        //   1. Per-upload `provider` form field (only honoured for 'local',
        //      and only when local transcription is admin-enabled). Picks
        //      from the upload modal in the UI.
        //   2. Server-side default `transcription_provider` config.
        const requestedProvider = (req.body.provider || '').toLowerCase();
        const localEnabled = (await configStore.getConfig('local_whisper_enabled')) !== false;
        let provider = await configStore.getConfig('transcription_provider') || 'voxtral';
        if (requestedProvider) {
            // Any authenticated user could override the admin's configured
            // engine from a form field. On this product that is not a
            // preference: it decides which third party the meeting audio is
            // sent to, and an admin who chose the self-hosted WhisperX for
            // exactly that reason had no way to stop a user picking a US cloud.
            const allowed = await resolveAllowedProviders(localEnabled);
            if (!allowed.includes(requestedProvider)) {
                if (req.file?.path) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
                return res.status(403).json({
                    error: 'That transcription engine is not enabled for this workspace.',
                    code: 'provider_not_allowed',
                    allowed,
                });
            }
            provider = requestedProvider;
        }

        log.info(`[Transcriptions] Transcribing "${fileName}" (${(uploadBytes / (1024 * 1024)).toFixed(1)} MB) via ${provider} for user ${userId} (${userName || 'unknown'})`);

        // ── Go async: save the audio up front (so a crashed/timed-out job can
        // still be reprocessed), create a 'processing' note, and respond 202
        // immediately. The heavy pipeline below keeps running after the response
        // and writes its result to this note (or marks it 'failed' in the catch). ──
        const audioDir = path.resolve(__dirname, '../../data/uploads/saved-recordings');
        if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
        const savedExt = path.extname(req.file.originalname || '.webm') || '.webm';
        // Same hazard as ingestRecordingCore's copy, same directory: two uploads
        // by one user in the same millisecond used to overwrite each other, so
        // one note's row pointed at the other note's audio.
        const savedBase = `${Date.now()}-${crypto.randomUUID()}-${userId}${savedExt}`;
        savedAudioPath = path.join(audioDir, savedBase);
        try {
            await fs.promises.copyFile(req.file.path, savedAudioPath);
        } catch (copyErr) {
            log.error('[Transcriptions] Could not persist audio up front:', copyErr.message);
            savedAudioPath = '';
        }
        // Durable copy in object storage (RustFS/S3) when available, so a later
        // "Re-transcribe" survives pod restarts / lands on any replica. Self-host
        // without object storage keeps only the local copy on its persistent disk.
        const { savedAudioKey, persistSavedAudioToStorage } = require('../../core/meetingNotes/savedAudioStore');
        // Reads from the copy we just made and lets the buffer go immediately
        // afterwards, instead of holding the upload for the whole pipeline.
        const persisted = await persistSavedAudioToStorage(
            savedAudioKey(savedBase),
            await fs.promises.readFile(savedAudioPath || req.file.path),
            savedExt,
        );
        const audioStorageKey = persisted.ok ? persisted.key : null;
        if (!persisted.ok && persisted.reason !== 'not_configured') {
            // Deliberately not fatal: the note and its transcript are still
            // worth having, and the backfill job will retry from the local file
            // while this pod still holds it. But it must be loud — on a deploy
            // with no persistent volume this is the window in which a recording
            // can be lost for good.
            log.error(`[Transcriptions] No durable audio copy for upload "${fileName}" (${persisted.reason}) — queued for repair`);
        }

        const processingNote = await transcriptionStore.createTranscription({
            userId,
            organizationId: userOrgId,
            title,
            fileName,
            language,
            status: 'processing',
            audioPath: savedAudioPath,
            audioStorageKey,
            provider,
            attendees,
            numSpeakers,
            // Both used to be 'upload'. The distinction matters only when the
            // audio is later missing: for a recording there is no original file
            // anywhere, so "upload it again" is not something the user can do.
            source: req.body.capture_mode || 'upload',
            projectId,
        });
        transcriptionId = processingNote.id;
        // Members see the note appear (still processing) the moment it exists.
        if (projectId) await meetingFiling.announce(projectId, userId, transcriptionId);
        // What we just wrote. The AI title lands minutes later, and the note is
        // openable and renameable the whole time — so the final write must only
        // replace this exact placeholder, never a name the user typed meanwhile.
        const placeholderTitle = title;
        res.status(202).json({ id: transcriptionId, status: 'processing', title, fileName, projectId });

        let response;
        // Tracks an automatic engine switch (e.g. local → voxtral when an upload
        // exceeds the on-device CPU model's duration cap). The 202 is long gone
        // by the time this is known, so it is surfaced as a notice line on the
        // note's summary (buildPipelineNotices) rather than in the response.
        let providerFallback = null;
        // Set when a provider salvaged a partial transcript (Azure watchdog).
        let truncationNotice = null;
        // Speaker identities established acoustically by pyannoteAI voiceprints
        // (pyannote provider only). `Mapping` is the confident pins, `Roster`
        // the plausible-but-unpinned names handed to the LLM as candidates.
        let voiceprintMapping = null;
        let voiceprintRoster = [];
        let voiceprintRuledOut = null;
        let voiceprintInfo = null;

        if (provider === 'local') {
            // ── In-process Whisper-base on CPU (privacy / no-cloud path) ──
            const { transcribeLocally } = require('../../core/voice/localWhisper');
            try {
                const local = await transcribeLocally(req.file.path, { language });
                if (!local) {
                    // Post-202: fail the note (the catch handles it), never res.* again.
                    throw new Error('Local transcription model is not available. Try again, or pick a cloud provider.');
                }
                response = { text: local.text, segments: local.segments };
            } catch (err) {
                if (err.code === 'local_whisper_too_long') {
                    // Try to fall back to a configured cloud provider so the
                    // upload doesn't dead-end. Voxtral is preferred (no extra
                    // setup once a Mistral key is present); WhisperX is the
                    // self-hosted alternative if it's configured.
                    const mistralKey = await configStore.getSecret('mistral_api_key');
                    // whisperx_url is stored encrypted (setSecret) — getConfig
                    // would hand back the raw ciphertext, which is truthy and
                    // so "worked" here by accident.
                    const whisperxUrl = process.env.WHISPERX_URL || await configStore.getSecret('whisperx_url');
                    const azureKey = await configStore.getSecret('azure_speech_key');
                    const azureRegion = await configStore.getConfig('azure_speech_region');
                    let cloud = null;
                    if (mistralKey) cloud = 'voxtral';
                    else if (whisperxUrl) cloud = 'whisperx';
                    else if (azureKey && azureRegion) cloud = 'azure';

                    if (cloud) {
                        log.info(`[Transcriptions] Local cap exceeded — falling back to ${cloud}`);
                        providerFallback = { from: 'local', to: cloud, reason: 'too_long', message: err.message };
                        provider = cloud;
                        // Fall through to the cloud branch below.
                    } else {
                        throw new Error(err.message + '. No cloud provider is configured — ask an admin to enable Voxtral, WhisperX or Azure, or split the recording.');
                    }
                } else {
                    throw err;
                }
            }
        }

        if (!response && provider === 'whisperx') {
            // ── WhisperX (self-hosted) ───────────────────────
            response = await transcribeWithWhisperX(req.file.path, fileName, language, contextTerms);

        } else if (!response && provider === 'scaleway') {
            // ── Scaleway Whisper large-v3 (cloud) + local diarization ──
            response = await transcribeWithScaleway(req.file.path, fileName, language, contextTerms);

        } else if (!response && provider === 'azure') {
            // ── Azure AI Speech (shared ConversationTranscriber core) ──
            // Duration-aware timeouts + partial-transcript salvage live in
            // core/voice/azureSpeech.js, shared with the chat tool and reprocess.
            const { transcribeWithAzureSpeech } = require('../../core/voice/azureSpeech');
            const az = await transcribeWithAzureSpeech(req.file.path, { language, contextTerms });
            truncationNotice = az.truncated;
            response = { text: az.text, segments: az.segments };

        } else if (!response && provider === 'whisper_azure') {
            // ── Azure Whisper Batch (REST API v3.2) ─────────────────
            // Raw segments only — the shared post-processing below owns naming,
            // summary, action items and chapters, exactly like every other
            // provider. (This branch used to self-finalise a second-class note
            // with no chapters and no attendee roster.)
            const { runAzureWhisperBatch } = require('../../integrations/transcriptionTools');
            const w = await runAzureWhisperBatch({ filePath: req.file.path, fileName, language, numSpeakers });
            response = { text: w.text, segments: w.segments };

        } else if (!response && provider === 'pyannote') {
            // ── pyannoteAI (all-in-one diarization + transcription) ──
            // Self-staging via pyannote's own media store — no RustFS/public URL.
            // Also the only provider that can identify speakers by voiceprint;
            // the client submits that second job only when this org has
            // enrolled members, so orgs that never enroll pay nothing extra.
            const { transcribeWithPyannote } = require('../../core/voice/pyannoteClient');
            const p = await transcribeWithPyannote(req.file.path, {
                language, numSpeakers,
                orgId: userOrgId, recorderUserId: userId, attendees,
            });
            response = { text: p.text, segments: p.segments };
            voiceprintMapping = p.voiceprintMapping;
            voiceprintRoster = p.voiceprintRoster || [];
            voiceprintRuledOut = p.voiceprintRuledOut;
            voiceprintInfo = p.voiceprintInfo;

        } else if (!response) {
            // ── Voxtral (cloud, default) ─────────────────────
            const apiKey = await configStore.getSecret('mistral_api_key');
            if (!apiKey) {
                try { fs.unlinkSync(req.file.path); } catch (_) {}
                throw new Error('Mistral API key not configured. Go to Admin → AI Config → API Keys.');
            }

            const { createVoxtralClient } = require('../../core/meetingNotes/voxtralClient');
            const client = createVoxtralClient(apiKey, { timeoutMs: VOXTRAL_TIMEOUT_MS });

            // The only branch that needs the bytes in memory. The phone's
            // crash-safe .aac goes over as .m4a (audioPreprocess.asM4aIfAdts).
            // nosemgrep: ajinabraham.njsscan.traversal.path_traversal.generic_path_traversal -- req.file.path is the random name multer wrote under uploadsDir, and the repack is a fresh os.tmpdir() file: no client-supplied path is read
            const voxtralAudio = await asM4aIfAdts(req.file.path, fileName);
            let fileContent;
            try {
                fileContent = await fs.promises.readFile(voxtralAudio.path);
            } finally {
                voxtralAudio.cleanup();
            }
            const transcriptionOptions = {
                model: 'voxtral-mini-2602',
                file: { fileName: voxtralAudio.fileName, content: fileContent },
                diarize: true,
                language,
                timestampGranularities: ['segment'],
            };
            const contextBias = toContextBias(contextTerms);
            if (contextBias.length) transcriptionOptions.contextBias = contextBias;

            response = await client.audio.transcriptions.complete(transcriptionOptions);
        }

        // Merge consecutive same-speaker segments and derive the transcript
        // string + per-speaker stats (shared shape with ingestRecordingCore).
        let { merged, transcript, speakers, totalDuration } = buildTranscriptArtifacts(response.segments || []);
        // No segments means no transcription happened — a muted mic, a corrupt
        // file, or a provider that returned an empty body. Every LLM helper
        // below swallows its own errors and returns ''/null, so without this
        // the note is written as a green 'completed' with an empty transcript,
        // 0 speakers and 0 duration, and the user never gets the failed view or
        // its Retry button. The reprocess route has had this guard all along.
        if (!merged.length) {
            throw new Error('Transcription returned no segments.');
        }

        // Identify speaker names using fast-tier model. Pass the stats rows,
        // not bare IDs — the speaking times are what let the model separate
        // real participants from short diarization fragments. IDs already
        // pinned by a voiceprint are passed as `lockedNames`: the model is not
        // asked about them, and its answer cannot override them.
        const nameMapping = await identifySpeakerNames(
            merged, speakers, language, userName, userOrgId,
            [...attendees, ...voiceprintRoster],
            { lockedNames: voiceprintMapping, ruledOutNames: voiceprintRuledOut, expectedSpeakers: numSpeakers },
        );

        // Floor: any ID the model couldn't confidently name gets a clean,
        // language-appropriate "Spreker N"/"Speaker N" instead of leaking the raw
        // diarizer id (SPEAKER_00) — real names where intros exist, tidy generic
        // labels where they don't.
        const filledMapping = fillGenericSpeakerLabels(speakers, nameMapping, language);

        // Collapse the diarizer's many IDs onto the identified names: renames
        // the segments and folds the duplicate stats rows together. Turn
        // boundaries are preserved, not re-merged — see applySpeakerNames.
        ({ merged, transcript, speakers } = applySpeakerNames(merged, filledMapping));
        speakers = tagSpeakerProvenance(speakers, voiceprintMapping);

        // The user told us how many people were in the room. Ending up with
        // fewer means two of them were given the same name and collapsed —
        // which is how a two-person meeting once came out as one speaker.
        // Reported, not auto-corrected: silently rewriting a name assignment is
        // worse than saying the count looks wrong.
        if (numSpeakers && speakers.length < numSpeakers) {
            log.warn(
                `[Transcriptions] ${transcriptionId}: ${speakers.length} speaker(s) after naming but ${numSpeakers} expected`
                + ` — names may have over-merged: ${JSON.stringify(filledMapping)}`
            );
        }

        // Generate meeting summary with Claude. De hele sjabloonRIJ, niet
        // alleen de prompt: de notitie wordt ermee gestempeld (welk sjabloon,
        // welke versie). Zonder standaardsjabloon blijft de stempel leeg —
        // de ingebouwde eerste-generatieprompt hieronder is geen van de vijf
        // ingebouwde sjablonen, dus er valt niets waars over te melden.
        const defaultTemplate = await resolveDefaultTemplateForReq(req, userId, userOrgId);
        const summary = await generateMeetingSummary(transcript, language, userOrgId, { templatePrompt: defaultTemplate?.prompt || null });

        // Always generate AI title from summary
        if (summary) {
            const aiTitle = await generateMeetingTitle(summary, language, userOrgId);
            if (aiTitle) title = aiTitle;
        }

        // Extract the structured artifacts (action items + due dates, decisions,
        // open questions, topic tags — one LLM pass) + topic chapters.
        const artifacts = await extractMeetingArtifacts(transcript, language, userOrgId, {
            meetingDateIso: new Date().toISOString().slice(0, 10),
            personNames: [...speakers.map((s) => s.id), ...(attendees || [])],
        });
        const chapters = await generateChapters(transcript, language, userOrgId);
        // Per-speaker prose for the Insights panel, stored on the speaker rows.
        const speakerSummaries = await generateSpeakerSummaries(transcript, speakers.map((s) => s.id), language, userOrgId);

        // ── EEN MISLUKTE ARTEFACTPASS IS GEEN LEGE VERGADERING ──────────
        // Deze route schreef `artifacts.actionItems/decisions/questions` rauw
        // weg. Bij een omgevallen of onparseerbare pass leverde dat een
        // AFGERONDE notitie op die beweert dat er niets is afgesproken —
        // terwijl de pass nooit gedraaid heeft. De notitie is bovendien al
        // zichtbaar en bewerkbaar tijdens het verwerken, dus een decision die
        // iemand ondertussen vastlegde werd er zwijgend door overschreven.
        // Niet schrijven is hier het juiste antwoord: `undefined` betekent bij
        // updateTranscription "raak deze kolom niet aan".
        const usable = artifactsUsable(artifacts);
        if (!usable) {
            log.warn(`[Transcriptions] Async note ${transcriptionId}: artifact extraction failed — leaving the artifact columns untouched.`);
        }

        // Engine fallback / truncation / een mislukte artefactpass gebeurden na
        // de 202, dus de samenvatting van de notitie is de enige plek die de
        // gebruiker er nog over kan vertellen.
        const notices = buildPipelineNotices({ providerFallback, truncated: truncationNotice, voiceprint: voiceprintInfo, artifactsFailed: !usable, language });
        const finalSummary = notices.length ? `${notices.join('\n')}\n\n${summary || ''}`.trim() : summary;

        // Audio was persisted up front (savedAudioPath); clean up the temp upload.
        try { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (_) {}

        // Fill in the 'processing' note with the finished result.
        await transcriptionStore.updateTranscription(transcriptionId, userId, {
            status: 'completed',
            ...(title === placeholderTitle
                ? {}
                : { titleIfUnchanged: { title, expected: placeholderTitle } }),
            durationSeconds: Math.round(totalDuration),
            fullText: response.text || '',
            transcript,
            segments: merged,
            speakers: applySpeakerSummaries(speakers, speakerSummaries),
            summary: finalSummary,
            ...(usable ? {
                actionItems: artifacts.actionItems,
                decisions: artifacts.decisions,
                questions: artifacts.questions,
                // Auto-topic tags fill the column only while it's still empty — a
                // user who tagged the note while it was processing keeps their tags.
                ...(artifacts.tags.length ? { tagsIfEmpty: artifacts.tags } : {}),
            } : {}),
            chapters,
            provider,
            voiceprintMatches: voiceprintInfo?.detail || [],
            // Met welk sjabloon en welke versie ervan deze samenvatting
            // geschreven is. Zonder standaardsjabloon zijn beide null: dan is
            // er geen sjabloon geweest, en niets is hier het juiste antwoord.
            ...stampForTemplate(defaultTemplate),
        });
        log.info(`[Transcriptions] Async note ${transcriptionId} completed — ${merged.length} segments, ${speakers.length} speakers, provider ${provider}`);

    } catch (err) {
        log.error('[Transcriptions] Transcribe error:', err.message);
        try { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (_) {}
        try {
            if (transcriptionId) {
                // Already responded 202 — flip the note to 'failed' and stash the
                // reason in `summary` (a failed note has none) so the UI can show
                // WHY, since the client only ever received the 202. Saved audio
                // (savedAudioPath) stays so the note can be reprocessed.
                await transcriptionStore.updateTranscription(transcriptionId, userId, {
                    status: 'failed',
                    summary: `Transcription failed: ${err.message}`,
                });
            } else if (!res.headersSent) {
                // Failed before the processing note / 202 — surface synchronously.
                res.status(500).json({ error: 'Transcription failed' });
            }
        } catch (dbErr) {
            log.error('[Transcriptions] Failed to record transcription failure:', dbErr.message);
        }
    }
});

module.exports = router;
