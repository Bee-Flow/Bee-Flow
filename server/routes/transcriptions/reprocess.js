/**
 * Transcriptions — reprocess.
 *
 * POST /:id/reprocess — re-run the transcription pipeline on the saved audio.
 * Async-202, mirroring the upload route.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const fs = require('fs');
const transcriptionStore = require('../../stores/transcriptionStore');
const configStore = require('../../stores/configStore');
const { requireAuth } = require('../../auth/permissions');
const { asM4aIfAdts } = require('../../core/voice/audioPreprocess');
const {
    parseSpeakerCount,
    resolveAccessContext,
    resolveUserOrgFromReq,
    resolveDefaultTemplateForReq,
    VOXTRAL_TIMEOUT_MS,
} = require('./shared');
const { stampForTemplate } = require('../../core/meetingNotes/summaryStamp');
const {
    identifySpeakerNames,
    generateMeetingSummary,
    extractMeetingArtifacts,
    generateChapters,
    generateSpeakerSummaries,
    applySpeakerSummaries,
    tagSpeakerProvenance,
    applySpeakerNames,
    fillGenericSpeakerLabels,
    buildTranscriptArtifacts,
    buildPipelineNotices,
    artifactsUsable,
    transcribeWithWhisperX,
    transcribeWithScaleway,
} = require('../../core/meetingNotes/summaryHelpers');
const { mergeRegeneratedActionItems, mergeRegeneratedNotes } = require('../../core/meetingNotes/actionItems');
const { validate } = require('../../core/http/validate');
const { NOTHING, NO_QUERY } = require('./schemas');

// ── Reprocess failed transcription ───────────────────────
//
// Async-202, mirroring the upload route: a long re-transcription (the recovery
// path for exactly the meetings that time out) cannot fit a synchronous
// request. The detail view already polls notes in 'processing'.

// Neemt niets aan dan de notitie in het pad: wat er opnieuw wordt gedraaid
// staat in de rij, niet in het verzoek. Een body-sleutel die eruitziet alsof
// hij dat kan sturen (`provider`, `language`) hoort een 400 te krijgen en niet
// genegeerd te worden — de vorige run koos die dienst, en die keuze staat vast.
router.post('/:id/reprocess', requireAuth, validate({ body: NOTHING, query: NO_QUERY }), async (req, res) => {
    // Set once the note is flipped to 'processing' and the 202 sent; from then
    // on all outcomes are written to the note, never to the HTTP response.
    let transcriptionId = null;
    let prevStatus = null;
    let userId = null;
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
                return res.status(503).json({
                    error: 'Audio storage is temporarily unavailable. Try again in a minute.',
                    code: 'audio_storage_unavailable',
                });
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
            }).catch(() => {});
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

        log.info(`[Transcriptions] Reprocessing "${fileName}" via ${provider}`);

        let response;
        let truncationNotice = null;
        let voiceprintMapping = null;
        let voiceprintRoster = [];
        let voiceprintRuledOut = null;
        let voiceprintInfo = null;

        if (provider === 'local') {
            // The note was transcribed on-device by choice; never silently move
            // it to a cloud provider on reprocess.
            const { transcribeLocally } = require('../../core/voice/localWhisper');
            const local = await transcribeLocally(audioPath, { language });
            if (!local) {
                throw new Error('Local transcription model is not available. Try again, or pick a cloud provider.');
            }
            response = { text: local.text, segments: local.segments };
        } else if (provider === 'whisperx') {
            response = await transcribeWithWhisperX(audioPath, fileName, language, '');
        } else if (provider === 'scaleway') {
            response = await transcribeWithScaleway(audioPath, fileName, language, '');
        } else if (provider === 'azure') {
            const { transcribeWithAzureSpeech } = require('../../core/voice/azureSpeech');
            const az = await transcribeWithAzureSpeech(audioPath, { language });
            truncationNotice = az.truncated;
            response = { text: az.text, segments: az.segments };
        } else if (provider === 'whisper_azure') {
            const { runAzureWhisperBatch } = require('../../integrations/transcriptionTools');
            response = await runAzureWhisperBatch({ filePath: audioPath, fileName, language, numSpeakers });
        } else if (provider === 'pyannote') {
            const { transcribeWithPyannote } = require('../../core/voice/pyannoteClient');
            // Org comes from the NOTE, not from the caller: resolveUserOrgFromReq
            // picks an arbitrary element of a multi-org user's set, and choosing
            // which organisation's biometric templates leave the building must
            // never be non-deterministic.
            const p = await transcribeWithPyannote(audioPath, {
                language, numSpeakers,
                orgId: transcription.organizationId || null,
                recorderUserId: transcription.ownerId || userId,
                attendees: transcription.attendees || [],
            });
            response = p;
            voiceprintMapping = p.voiceprintMapping;
            voiceprintRoster = p.voiceprintRoster || [];
            voiceprintRuledOut = p.voiceprintRuledOut;
            voiceprintInfo = p.voiceprintInfo;
        } else {
            const apiKey = await configStore.getSecret('mistral_api_key');
            if (!apiKey) throw new Error('Mistral API key not configured');

            const { createVoxtralClient } = require('../../core/meetingNotes/voxtralClient');
            const client = createVoxtralClient(apiKey, { timeoutMs: VOXTRAL_TIMEOUT_MS });

            // A stored .aac from the phone goes over as .m4a (audioPreprocess.asM4aIfAdts).
            const voxtralAudio = await asM4aIfAdts(audioPath, fileName);
            let fileContent;
            try {
                fileContent = await fs.promises.readFile(voxtralAudio.path);
            } finally {
                voxtralAudio.cleanup();
            }

            response = await client.audio.transcriptions.complete({
                model: 'voxtral-mini-2602',
                file: { fileName: voxtralAudio.fileName, content: fileContent },
                diarize: true,
                language,
                timestampGranularities: ['segment'],
            });
        }

        // Shared artifacts helper — same merge/transcript/stats shape as the
        // upload route and ingestRecordingCore (segments carry speaker+speakerId).
        let { merged, transcript, speakers, totalDuration } = buildTranscriptArtifacts(response.segments || []);
        if (!merged.length) {
            throw new Error('Transcription returned no segments.');
        }

        // Speaker identification — pass the stats rows so the model can tell
        // real participants from short diarization fragments.
        let reprocessUserName = null;
        try { const { getUser } = require('../../stores/userStore'); const u = await getUser(userId); reprocessUserName = u?.firstName || u?.displayName || null; } catch (_) {}
        // Reuse the roster captured at upload — reprocessing without it would
        // throw away the strongest naming signal we have. Names the OWNER typed
        // in the speaker editor count too, and count for more than anything the
        // model guessed: the previous run's diarization is discarded here, so
        // without this a user who painstakingly named five speakers got
        // "Spreker 1..5" back and had to do it again.
        const manualNames = (transcription.speakers || [])
            .filter((s) => s && s.source === 'manual' && typeof s.id === 'string' && s.id.trim())
            .map((s) => s.id.trim());
        const reprocessRoster = [...new Set([
            ...manualNames,
            ...(transcription.attendees || []),
            ...voiceprintRoster,
        ])];
        const nameMapping = await identifySpeakerNames(
            merged, speakers, language, reprocessUserName, userOrgId,
            reprocessRoster,
            { lockedNames: voiceprintMapping, ruledOutNames: voiceprintRuledOut, expectedSpeakers: numSpeakers },
        );

        // Same generic-label floor as the upload route — never leak raw ids.
        const filledMapping = fillGenericSpeakerLabels(speakers, nameMapping, language);

        // Collapse the diarizer's many IDs onto the identified names (same
        // treatment as the upload route).
        ({ merged, transcript, speakers } = applySpeakerNames(merged, filledMapping));
        speakers = tagSpeakerProvenance(speakers, voiceprintMapping);

        // Summary + timeline chapters + structured artifacts. The artifacts are
        // re-extracted too: the transcript is brand new, so the old action
        // items/decisions/questions point at timestamps that no longer exist.
        const defaultTemplate = await resolveDefaultTemplateForReq(req, userId, userOrgId);
        const summary = await generateMeetingSummary(transcript, language, userOrgId, { templatePrompt: defaultTemplate?.prompt || null });
        // De samenvatting wordt hier OPNIEUW geschreven, dus de sjabloonstempel
        // wordt opnieuw gezet — ook als het antwoord "geen sjabloon" is. Een
        // oude stempel laten staan zou een sjabloonnaam plakken op tekst die
        // dat sjabloon nooit gemaakt heeft.
        const summaryStamp = stampForTemplate(defaultTemplate);
        const chapters = await generateChapters(transcript, language, userOrgId);
        const artifacts = await extractMeetingArtifacts(transcript, language, userOrgId, {
            meetingDateIso: (transcription.createdAt || '').slice(0, 10) || null,
            personNames: [...speakers.map((s) => s.id), ...(transcription.attendees || [])],
        });
        const speakerSummaries = await generateSpeakerSummaries(transcript, speakers.map((s) => s.id), language, userOrgId);
        // Re-extraction replaces the AI's action items — and only those (M3).
        // The comment above justifies re-extracting with "the old items point at
        // timestamps that no longer exist", which is true of the model's items
        // and false of an action a person typed: that one has no timestamp to
        // invalidate, and losing it here would be the same silent deletion
        // "Opnieuw" used to do, from a button one step further away. Survivors
        // keep their text and destination and give up their anchors into the
        // transcript this run just replaced.
        // ── EEN MISLUKTE EXTRACTIE IS GEEN LEGE VERGADERING ─────────────
        // extractMeetingArtifacts kent DRIE uitkomsten: een vergadering waarin
        // niets is afgesproken, een antwoord dat niet te parsen was, en een
        // call die omviel. De laatste twee leverden vier lege lijsten op, en
        // die hier doorschrijven wist actiepunten, besluiten én vragen van een
        // notitie die al 'completed' was — zonder undo, en het scherm toont
        // daarna een vergadering die niets heeft opgeleverd.
        // `artifactsUsable` stelt de vraag aan de WAARDE en niet aan een losse
        // vlag, en versmalt op alles wat er niet als afgeronde pass uitziet:
        // de vorige poort (`ok !== false`) liet ook een antwoord zónder lijsten
        // door als "gelukt", en wiste er dan de hele notitie mee leeg.
        // Bij een mislukte pass blijft alles staan wat er stond — wél zonder de
        // ankers, want de transcriptie waar ze in wezen is zojuist vervangen.
        const usable = artifactsUsable(artifacts);
        if (!usable) {
            log.warn(`[Transcriptions] Reprocess ${transcriptionId}: artifact extraction failed — keeping the existing action items, decisions and questions.`);
        }
        const mergedActionItems = mergeRegeneratedActionItems(
            transcription.actionItems, artifacts.actionItems,
            { transcriptChanged: true, keepAiItems: !usable },
        );
        // Same rule for the other two lists (M4). A decision picked off a
        // transcript line is a person's, and re-transcribing the audio is not
        // a reason to delete it — only a reason to drop its anchors into the
        // transcript this run just replaced.
        const mergedDecisions = mergeRegeneratedNotes(
            transcription.decisions, artifacts.decisions,
            { field: 'decisions', transcriptChanged: true, keepAiNotes: !usable },
        );
        const mergedQuestions = mergeRegeneratedNotes(
            transcription.questions, artifacts.questions,
            { field: 'questions', transcriptChanged: true, keepAiNotes: !usable },
        );
        // Bewaren is de helft; zeggen dat je bewaard hebt is de andere helft.
        // Zonder deze regel is een mislukte pass op het scherm niet te
        // onderscheiden van een vergadering waarin niets is afgesproken.
        const notices = buildPipelineNotices({ truncated: truncationNotice, voiceprint: voiceprintInfo, artifactsFailed: !usable, language });
        const finalSummary = notices.length ? `${notices.join('\n')}\n\n${summary || ''}`.trim() : summary;

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
        log.error('[Transcriptions] Reprocess error:', err.message);
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
                    : { status: 'failed', summary: `Transcription failed: ${err.message}` };
                const wrote = await transcriptionStore.finishProcessing(transcriptionId, userId, outcome);
                if (!wrote) {
                    log.warn(`[Transcriptions] Reprocess of ${transcriptionId} failed but the claim was already lost — leaving the note alone`);
                }
            } else if (!res.headersSent) {
                res.status(500).json({ error: `Reprocessing failed: ${err.message}` });
            }
        } catch (dbErr) {
            log.error('[Transcriptions] Failed to record reprocess failure:', dbErr.message);
        }
    } finally {
        // Remove the temp file if the audio was streamed from object storage.
        try { audioSource?.cleanup?.(); } catch (_) {}
    }
});

module.exports = router;
