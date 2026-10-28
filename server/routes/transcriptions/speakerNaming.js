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
 * and its answer cannot override them.
 * @returns {Promise<{ merged: any[], transcript: string, speakers: any[], filledMapping: object }>}
 */
async function nameSpeakers({ merged, speakers, language, userName, userOrgId, roster, voiceprintMapping, voiceprintRuledOut, numSpeakers }) {
    const nameMapping = await identifySpeakerNames(
        merged, speakers, language, userName, userOrgId,
        roster,
        { lockedNames: voiceprintMapping, ruledOutNames: voiceprintRuledOut, expectedSpeakers: numSpeakers },
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
    return built;
}

module.exports = { lookupUserName, nameSpeakers, buildTranscriptOrThrow };
