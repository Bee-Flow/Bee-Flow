// @typecheck
/**
 * The provider-independent tail of a chat-tool transcription: merge
 * consecutive segments per speaker, tally speaking time, ask for speaker
 * names, and build the result object the chat tool returns. Every provider
 * handler in integrations/transcriptionTools.js ends here; each one only
 * adapts its own response to `{ speakerId, start, end, text }` segments and
 * says how long the recording was.
 */

function formatTime(seconds) {
    if (seconds == null) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0)
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Merge consecutive segments from the same speaker for cleaner output.
 */
function mergeSegments(segments) {
    if (!segments || segments.length === 0) return [];
    const merged = [];
    for (const seg of segments) {
        const last = merged[merged.length - 1];
        if (last && seg.speakerId === last.speakerId) {
            last.end = seg.end;
            last.text += ' ' + (seg.text || '').trim();
        } else {
            merged.push({
                speakerId: seg.speakerId || 'Unknown',
                start: seg.start,
                end: seg.end,
                text: (seg.text || '').trim(),
            });
        }
    }
    return merged;
}

/** Speaking time and segment count per speaker id, in first-seen order. */
function buildSpeakerMap(merged) {
    const speakerMap = {};
    for (const seg of merged) {
        if (!speakerMap[seg.speakerId]) speakerMap[seg.speakerId] = { duration: 0, segments: 0 };
        speakerMap[seg.speakerId].duration += (seg.end || 0) - (seg.start || 0);
        speakerMap[seg.speakerId].segments += 1;
    }
    return speakerMap;
}

/** `[speaker] mm:ss - mm:ss: text` per merged segment. */
function formatTranscriptLines(merged) {
    return merged.map((s) => `[${s.speakerId}] ${formatTime(s.start)} - ${formatTime(s.end)}: ${s.text}`);
}

/** Latest segment end, 0 for no segments. */
function maxSegmentEnd(segments) {
    return segments.length > 0 ? Math.max(...segments.map((s) => s.end || 0)) : 0;
}

/**
 * Build the final result object shared by every provider. Applies the name
 * mapping to `merged` in place.
 */
function buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping }) {
    // Apply name mapping if available
    if (nameMapping) {
        for (const seg of merged) {
            if (nameMapping[seg.speakerId]) seg.speakerId = nameMapping[seg.speakerId];
        }
    }

    const formattedLines = formatTranscriptLines(merged);

    return {
        success: true,
        fileName: audioFileName,
        language,
        duration: formatTime(totalDuration),
        durationSeconds: Math.round(totalDuration),
        speakerCount: Object.keys(speakerMap).length,
        segmentCount: merged.length,
        speakers: Object.entries(speakerMap).map(([id, data]) => ({
            id: nameMapping?.[id] || id,
            speakingTime: formatTime(data.duration),
            segments: data.segments,
        })),
        transcript: formattedLines.join('\n'),
        segments: merged.map((s) => ({
            speaker: s.speakerId,
            start: s.start,
            end: s.end,
            startFormatted: formatTime(s.start),
            endFormatted: formatTime(s.end),
            text: s.text,
        })),
    };
}

/**
 * Raw provider segments in, chat-tool result out.
 *
 * @param {object} opts
 * @param {Array<{speakerId?: string, start?: number, end?: number, text?: string}>} opts.segments
 * @param {string} opts.audioFileName
 * @param {string} opts.language
 * @param {number} opts.totalDuration    recording length in seconds (see maxSegmentEnd)
 * @param {(speakerIds: string[], formattedLines: string[]) => Promise<object|null>|object|null} opts.identifyNames
 *        speaker id → display name, from the transcript lines before renaming
 */
async function finalizeTranscript({ segments, audioFileName, language, totalDuration, identifyNames }) {
    const merged = mergeSegments(segments);
    const speakerMap = buildSpeakerMap(merged);
    const nameMapping = await identifyNames(Object.keys(speakerMap), formatTranscriptLines(merged));
    return buildResult({ audioFileName, language, merged, totalDuration, speakerMap, nameMapping });
}

module.exports = {
    formatTime,
    mergeSegments,
    buildSpeakerMap,
    formatTranscriptLines,
    maxSegmentEnd,
    buildResult,
    finalizeTranscript,
};
