/**
 * Transcriptions — upload & transcribe.
 *
 * POST / — multipart audio upload → 202 + background pipeline (transcribe →
 * diarize → name speakers → summary / artifacts / chapters), written to the
 * 'processing' note created up front. The intake steps live in uploadIntake.js,
 * the background pipeline in uploadPipeline.js.
 */

const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const router = express.Router();
// The multer instance (scratch dir, size cap, audio-only filter): ./audioUpload.js.
const { upload } = require('./audioUpload');
const fs = require('fs');
const transcriptionStore = require('../../stores/transcriptionStore');
const { requireAuth } = require('../../auth/permissions');
const {
    parseSpeakerCount,
    resolveUserOrgFromReq,
} = require('./shared');
const meetingFiling = require('../../projects/meetingFiling');
const { toContextBias } = require('../../core/meetingNotes/summaryHelpers');
const { lookupUserName } = require('./speakerNaming');
const { resolveProjectFiling, resolveUploadProvider, persistUploadAudio } = require('./uploadIntake');
const { transcribeUpload, analyseUpload, finishUpload } = require('./uploadPipeline');
const { validate } = require('../../core/http/validate');
const { z, typeError } = require('../../utils/zod');
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
    num_speakers: z.coerce.number({ error: typeError({ invalid: 'num_speakers is een getal.' }) })
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
    const filing = await resolveProjectFiling(req, userId, userOrgId);
    if (filing.refusal) return res.status(filing.refusal.status).json(filing.refusal.body);
    const projectId = filing.projectId;

    const language = req.body.language || 'nl';
    const contextTerms = req.body.context_terms || '';
    // Who was in the room. This is the single strongest input to speaker
    // naming: it turns an open-ended "who are these 29 voice IDs?" — which text
    // alone cannot answer — into assignment onto a known, closed set.
    const attendees = toContextBias(req.body.attendees || '');
    // Optional per-meeting speaker-count hint (Auto when absent). Drives
    // pyannote's numSpeakers and Azure Whisper's diarization min/max.
    const numSpeakers = parseSpeakerCount(req.body.num_speakers);
    const title = req.body.title || req.file.originalname || 'Untitled';

    // Async pipeline bookkeeping — declared out here so the catch can reach them.
    // Once the 'processing' note is created and the 202 sent, transcriptionId is
    // set and all further outcomes are written to the note, not the HTTP response.
    let transcriptionId = null;

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
        const userName = await lookupUserName(userId);

        const chosen = await resolveUploadProvider(req);
        if (chosen.refusal) return res.status(403).json(chosen.refusal);
        const provider = chosen.provider;

        log.info(`[Transcriptions] Transcribing "${fileName}" (${(uploadBytes / (1024 * 1024)).toFixed(1)} MB) via ${provider} for user ${userId} (${userName || 'unknown'})`);

        // ── Go async: save the audio up front (so a crashed/timed-out job can
        // still be reprocessed), create a 'processing' note, and respond 202
        // immediately. The heavy pipeline below keeps running after the response
        // and writes its result to this note (or marks it 'failed' in the catch). ──
        const { savedAudioPath, audioStorageKey } = await persistUploadAudio(req.file, userId, fileName);

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

        const transcribed = await transcribeUpload({
            provider, filePath: req.file.path, fileName, language, contextTerms, numSpeakers, userOrgId, userId, attendees,
        });
        const analysis = await analyseUpload({
            req, transcriptionId, userId, userOrgId, userName, language, attendees, numSpeakers, title, transcribed,
        });

        // Audio was persisted up front (savedAudioPath); clean up the temp upload.
        try { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (_) {}

        await finishUpload({
            transcriptionId, userId, userOrgId, transcribed, analysis, provider: transcribed.provider, placeholderTitle,
        });
    } catch (err) {
        log.error('[Transcriptions] Transcribe error:', err.message);
        let failure = null;
        try { if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch (_) {}
        try {
            if (transcriptionId) {
                // Already responded 202: flip the note to 'failed' with the reason
                // in `summary`; saved audio stays so it can be reprocessed.
                await transcriptionStore.updateTranscription(transcriptionId, userId, {
                    status: 'failed',
                    summary: `Transcription failed: ${err.message}`,
                });
            } else if (!res.headersSent) {
                // Failed before the processing note / 202 — surface synchronously.
                failure = new HttpError(500, 'transcription_failed', 'Transcription failed');
            }
        } catch (dbErr) {
            log.error('[Transcriptions] Failed to record transcription failure:', dbErr.message);
        }
        if (failure) throw failure;
    }
});

module.exports = router;
