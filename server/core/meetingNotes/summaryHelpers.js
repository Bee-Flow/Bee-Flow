// @typecheck
/**
 * Shared meeting-notes pipeline helpers.
 *
 * Extracted from `server/routes/transcriptions.js` so both the HTTP routes
 * and the background Nextcloud Talk auto-ingest can reuse the exact same
 * logic without duplicating it (or creating a circular require on the route
 * module). This file is the stable import point; the code lives in:
 *   - summaryLlm.js          model-tier resolution (EU-aware) and the meeting
 *                            summary / title / artifacts / chapters
 *   - speakerNaming.js       speaker-name identification (diarization → real names)
 *   - transcribeWhisperX.js  the WhisperX provider call
 *   - transcribeScaleway.js  the Scaleway provider call (ffmpeg split + diarization merge)
 *   - transcriptArtifacts.js segment merge + transcript/speaker artifact builder
 */

// Pure transcript/diarization shaping lives in its own dep-free module so it
// stays unit-testable without loading the LLM stack. Re-exported below.
const {
    formatTime,
    toContextBias,
    buildTranscriptArtifacts,
    applySpeakerNames,
    applySpeakerSummaries,
    tagSpeakerProvenance,
    fillGenericSpeakerLabels,
    buildPipelineNotices,
    artifactsUsable,
    ARTIFACTS_FAILED,
} = require('./transcriptArtifacts');
const { identifySpeakerNames } = require('./speakerNaming');
const {
    SUMMARY_MAX_TOKENS,
    resolveSmartModel,
    resolveFastModel,
    generateMeetingSummary,
    generateMeetingTitle,
    extractActionItems,
    extractMeetingArtifacts,
    generateChapters,
    generateSpeakerSummaries,
} = require('./summaryLlm');
const { transcribeWithWhisperX } = require('./transcribeWhisperX');
const { transcribeWithScaleway, scalewayTranscodeArgs, scalewaySplitArgs } = require('./transcribeScaleway');

module.exports = {
    resolveSmartModel,
    resolveFastModel,
    identifySpeakerNames,
    generateMeetingSummary,
    generateMeetingTitle,
    extractActionItems,
    extractMeetingArtifacts,
    generateChapters,
    generateSpeakerSummaries,
    applySpeakerSummaries,
    tagSpeakerProvenance,
    transcribeWithWhisperX,
    transcribeWithScaleway,
    toContextBias,
    formatTime,
    buildTranscriptArtifacts,
    applySpeakerNames,
    fillGenericSpeakerLabels,
    buildPipelineNotices,
    artifactsUsable,
    ARTIFACTS_FAILED,
    SUMMARY_MAX_TOKENS,
    _scalewayTranscodeArgs: scalewayTranscodeArgs, // exported for tests
    _scalewaySplitArgs: scalewaySplitArgs,
};
