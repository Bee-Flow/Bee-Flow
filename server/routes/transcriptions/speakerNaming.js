// @typecheck
/**
 * Transcriptions: speaker naming shared by the upload and reprocess pipelines.
 */

const {
    identifySpeakerNames,
    tagSpeakerProvenance,
    applySpeakerNames,
    fillGenericSpeakerLabels,
    buildTranscriptArtifacts,
} = require('../../core/meetingNotes/summaryHelpers');

/**
 * The caller's first name (or display name), used to anchor speaker naming.
 * Null when the user cannot be looked up: naming works without it.
 * @param {string} userId
 */
async function lookupUserName(userId) {
    try {
        const { getUser } = require('../../stores/userStore');
        const u = await getUser(userId);
        return u?.firstName || u?.displayName || null;
    } catch (_) {
        return null;
    }
}

/**
 * Identify speaker names and collapse the diarizer's many IDs onto them.
 * Pass the stats rows, not bare IDs: the speaking times are what let the model
 * separate real participants from short diarization fragments. IDs already
 * pinned by a voiceprint are `lockedNames`: the model is not asked about them,
 * and its answer cannot override them. `knownNames` are names known to be in
 * the meeting (a speaker the owner named by hand): candidates for the model,
 * not part of the closed attendee `roster`.
 * @returns {Promise<{ merged: any[], transcript: string, speakers: any[], filledMapping: object }>}
 */
async function nameSpeakers({ merged, speakers, language, userName, userOrgId, roster, voiceprintMapping, voiceprintRuledOut, numSpeakers, knownNames = undefined }) {
    const nameMapping = await identifySpeakerNames(
        merged, speakers, language, userName, userOrgId,
        roster,
        {
            lockedNames: voiceprintMapping, ruledOutNames: voiceprintRuledOut, expectedSpeakers: numSpeakers,
            ...(knownNames && knownNames.length ? { knownNames } : {}),
        },
    );

    // Floor: any ID the model couldn't confidently name gets a clean,
    // language-appropriate "Spreker N"/"Speaker N" instead of leaking the raw
    // diarizer id (SPEAKER_00).
    const filledMapping = fillGenericSpeakerLabels(speakers, nameMapping, language);

    // Renames the segments and folds the duplicate stats rows together. Turn
    // boundaries are preserved, not re-merged: see applySpeakerNames.
    const named = applySpeakerNames(merged, filledMapping);
    return {
        merged: named.merged,
        transcript: named.transcript,
        speakers: tagSpeakerProvenance(named.speakers, voiceprintMapping),
        filledMapping,
    };
}

/**
 * Merge consecutive same-speaker segments and derive the transcript string and
 * per-speaker stats (shared shape with ingestRecordingCore). No segments means
 * no transcription happened — a muted mic, a corrupt file, or a provider that
 * returned an empty body — and must fail the note instead of completing it empty.
 */
function buildTranscriptOrThrow(response) {
    const built = buildTranscriptArtifacts(response.segments || []);
    if (!built.merged.length) {
        throw new Error('Transcription returned no segments.');
    }
    // Segments without a single word are the same outcome. A diarizer can
    // return speaker turns while its speech-to-text leg found nothing (pyannote
    // maps a diarization-only result to rows with empty text, on purpose, so
    // speaker lanes survive). Completing that note ran the summary, title,
    // chapters and artifacts over bare "[S1] 00:00 - 00:12:" lines, and the
    // user got an invented summary with no hint to retry.
    if (!built.merged.some((seg) => typeof seg.text === 'string' && seg.text.trim())) {
        throw new Error('Transcription returned no words. The recording may be silent, or in a language the engine could not transcribe.');
    }
    return built;
}

module.exports = { lookupUserName, nameSpeakers, buildTranscriptOrThrow };
