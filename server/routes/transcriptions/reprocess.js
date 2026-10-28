/**
 * Transcriptions — reprocess.
 *
 * POST /:id/reprocess — re-run the transcription pipeline on the saved audio.
 * Async-202, mirroring the upload route.
 */

const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const router = express.Router();
const transcriptionStore = require('../../stores/transcriptionStore');
const configStore = require('../../stores/configStore');
const { requireAuth } = require('../../auth/permissions');
const {
    parseSpeakerCount,
    resolveAccessContext,
    resolveUserOrgFromReq,
} = require('./shared');
const { applySpeakerSummaries } = require('../../core/meetingNotes/summaryHelpers');
const { transcribeStoredAudio, analyseTranscript } = require('./reprocessPipeline');
const { validate } = require('../../core/http/validate');
const { NOTHING, NO_QUERY } = require('./schemas');
const { bestEffort } = require('../../utils/bestEffort');

// ── Reprocess failed transcription ───────────────────────
//
// Async-202, mirroring the upload route: a long re-transcription (the recovery
// path for exactly the meetings that time out) cannot fit a synchronous
// request. The detail view already polls notes in 'processing'.

// Accepts nothing but the note in the path: what gets rerun is in the row, not in
// the request. A body key that looks as if it could send that (`provider`,
// `language`) should get a 400 and not be ignored — the previous run chose that
// service, and that choice stands.
router.post('/:id/reprocess', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (/** @type {import('express').Request<{ id: string }, any, import('zod').infer<typeof NOTHING>, import('zod').infer<typeof NO_QUERY>>} */ req, res) => {
    // Set once the note is flipped to 'processing' and the 202 sent; from then
    // on all outcomes are written to the note, never to the HTTP response.
    let transcriptionId = null;
    let prevStatus = null;
    /** @type {string | null} */
    let userId = null;
    /** @type {{ path: string | null; cleanup?: () => void; fromStorage?: boolean; cached?: boolean; reason?: string; }} */
    let audioSource = null; // { path, cleanup } — may be a temp file streamed from object storage
    try {
        userId = req.session.user.id;
        const userOrgId = await resolveUserOrgFromReq(req);
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        if (!transcription) return res.status(404).json({ error: 'Not found' });
        if (!transcription.isOwner) return res.status(403).json({ error: 'Only the owner can reprocess' });
        // Prefer the local saved copy; fall back to the durable object-storage
        // copy (streamed to a temp file) so re-transcribe survives a pod
        // restart / a different replica where the local file is gone.
        const { resolveSavedAudio, repairSavedAudio } = require('../../core/meetingNotes/savedAudioStore');
        audioSource = await resolveSavedAudio(transcription);
        if (!audioSource.path) {
            // One 400 used to cover every cause, and its advice — "please upload
            // again" — is impossible to follow for a meeting recorded in the
            // browser: those bytes never existed anywhere else. Say what is
            // actually true, and let the client branch on `code` not on prose.
            if (audioSource.reason === 'storage_unavailable') {
                throw new HttpError(503, 'audio_storage_unavailable',
                    'Audio storage is temporarily unavailable. Try again in a minute.');
            }
            const wasRecorded = transcription.source === 'recording';
            return res.status(410).json({
                error: wasRecorded
                    ? 'This meeting was recorded in your browser, so no other copy of the audio exists. The transcript and summary below are what remains.'
                    : 'The saved audio is no longer available. Upload the original file again to re-transcribe it.',
                code: wasRecorded ? 'audio_gone_recorded' : 'audio_gone_uploaded',
            });
        }
        // Opportunistic repair: this pod can read the file and the note has no
        // durable copy. On a multi-replica deploy the owning pod is the ONLY one
        // that can fix this, so every reprocess is a chance we should not waste.
        if (!audioSource.fromStorage && !transcription.audioStorageKey) {
            repairSavedAudio({
                id: transcription.id,
                ownerId: transcription.ownerId || userId,
                audioPath: audioSource.path,
                audioStorageKey: transcription.audioStorageKey,
            }).catch((e) => bestEffort('routes/transcriptions/reprocess:anon', e));
        }
        const audioPath = audioSource.path;

        // Use the stored provider, falling back to current admin config
        const provider = transcription.provider || await configStore.getConfig('transcription_provider') || 'voxtral';
        const fileName = transcription.fileName || 'audio.webm';
        const language = transcription.language || 'nl';
        // The speaker-count hint the user gave at upload, reused so a reprocess
        // diarizes with the same expectation.
        const numSpeakers = parseSpeakerCount(transcription.numSpeakers);

        prevStatus = transcription.status;
        // Claim the note atomically. Losing means another run already owns it —
        // a double-clicked Retry, a second tab, or another replica — and
        // starting anyway would both double the provider bill and let this
        // run's outcome overwrite the winner's.
        if (!(await transcriptionStore.claimForProcessing(transcription.id, userId))) {
            return res.status(409).json({
                error: 'This recording is already being processed. Wait for it to finish.',
                code: 'already_processing',
            });
        }
        transcriptionId = transcription.id;
        res.status(202).json({ id: transcriptionId, status: 'processing' });

        log.info(`[Transcriptions] Reprocessing "${log.nameForLog(fileName)}" via ${provider}`);

        const transcribed = await transcribeStoredAudio({ provider, audioPath, fileName, language, numSpeakers, transcription, userId });
        const { response, voiceprintInfo } = transcribed;
        const {
            merged, transcript, speakers, totalDuration, chapters, artifacts, usable,
            speakerSummaries, summaryStamp, finalSummary,
            mergedActionItems, mergedDecisions, mergedQuestions,
        } = await analyseTranscript({ req, transcriptionId, transcription, userId, userOrgId, language, numSpeakers, transcribed });

        // Update the existing record — but only while we still hold the claim,
        // so a slow run cannot overwrite a note someone else has since taken.
        //
        // This write goes round transcriptionStore.updateTranscription on
        // purpose (the claim predicate is the point of it), so it has to seal
        // the content columns ITSELF. Without that, a reprocess would write
        // plaintext straight over an encrypted note — silently, and only for
        // orgs that had asked for encryption. The derived previews travel with
        // the columns they come from, exactly as they do in the store.
        const { run } = require('../../db');
        const transcriptCrypto = require('../../stores/transcriptCrypto');
        const cryptoCtx = await transcriptCrypto.resolveTranscriptCrypto(transcription.organizationId || null);
        const sealed = transcriptCrypto.encryptRow(req.params.id, {
            full_text: response.text || '',
            transcript,
            segments: JSON.stringify(merged),
            speakers: JSON.stringify(applySpeakerSummaries(speakers, speakerSummaries)),
            summary: finalSummary,
            chapters: JSON.stringify(chapters),
        }, cryptoCtx);
        const { rowCount: written } = await run(
            `UPDATE transcriptions SET status = $1, duration_seconds = $2, speaker_count = $3, segment_count = $4, full_text = $5, transcript = $6, segments = $7, speakers = $8, summary = $9, chapters = $10, action_items = $11, decisions = $12, questions = $13,
                    tags = CASE WHEN tags IS NULL OR tags = '[]'::jsonb THEN $14::jsonb ELSE tags END,
                    voiceprint_matches = $15,
                    summary_template_id = $16,
                    summary_template_version = $17,
                    full_text_snippet_enc = $18,
                    summary_snippet_enc = $19,
                    updated_at = NOW() WHERE id = $20 AND user_id = $21 AND status = 'processing'`,
            // speaker_count is the count of identified people, not of raw
            // diarizer IDs — those collapse many-to-one onto the same person.
            ['completed', Math.round(totalDuration), speakers.length, merged.length, sealed.full_text, sealed.transcript, sealed.segments, sealed.speakers, sealed.summary, sealed.chapters, JSON.stringify(mergedActionItems), JSON.stringify(mergedDecisions), JSON.stringify(mergedQuestions), JSON.stringify(usable ? artifacts.tags : []), JSON.stringify(voiceprintInfo?.detail || []), summaryStamp.summaryTemplateId, summaryStamp.summaryTemplateVersion, transcriptCrypto.buildSnippet(req.params.id, response.text || '', cryptoCtx), transcriptCrypto.buildSummarySnippet(req.params.id, finalSummary || '', cryptoCtx), req.params.id, userId]
        );
        if (!written) {
            log.warn(`[Transcriptions] Reprocess of ${transcriptionId} finished but the claim was lost — discarding the result`);
            return;
        }
        log.info(`[Transcriptions] Reprocess of ${transcriptionId} completed — ${merged.length} segments, ${speakers.length} speakers, provider ${provider}`);

        // AFTER the conditional write, and only when it actually landed: a run
        // whose claim was lost announced nothing above, and must announce
        // nothing here either — the winning run will do it with its own
        // content.
        require('../../core/meetingNotes/ingestRecordingCore').emitMeetingProcessed({
            transcriptionId,
            tags: usable ? artifacts.tags : [],
            userId,
            orgId: userOrgId,
            reprocessed: true,
        });
    } catch (err) {
        if (err instanceof HttpError && !transcriptionId) throw err;
        log.error('[Transcriptions] Reprocess error:', /** @type {Error} */ (err).message);
        /** @type {HttpError | null} */
        let failure = null;
        try {
            if (transcriptionId) {
                // Never clobber a good note with a failed rerun: a previously
                // completed note keeps its old content and status; only a note
                // that had nothing to lose is marked failed (with the reason in
                // `summary`, the upload-route convention).
                //
                // `finishProcessing` makes the write conditional on still
                // holding the claim, so a run that failed slowly cannot stamp
                // its error over a note another run has already completed.
                const outcome = prevStatus === 'completed'
                    ? { status: 'completed' }
                    : { status: 'failed', summary: `Transcription failed: ${/** @type {Error} */ (err).message}` };
                const wrote = await transcriptionStore.finishProcessing(transcriptionId, userId, outcome);
                if (!wrote) {
                    log.warn(`[Transcriptions] Reprocess of ${transcriptionId} failed but the claim was already lost — leaving the note alone`);
                }
            } else if (!res.headersSent) {
                failure = new HttpError(500, 'reprocess_failed', 'Reprocessing failed');
            }
        } catch (dbErr) {
            log.error('[Transcriptions] Failed to record reprocess failure:', /** @type {Error} */ (dbErr).message);
        }
        if (failure) throw failure;
    } finally {
        // Remove the temp file if the audio was streamed from object storage.
        try { audioSource?.cleanup?.(); } catch (_) { log.debug('temp audio already gone', _); }
    }
});

module.exports = router;

/** @typedef {{ actionItems: object[], decisions: object[], questions: object[], tags: string[] }} UsableArtifacts  what `artifactsUsable` lets through */
