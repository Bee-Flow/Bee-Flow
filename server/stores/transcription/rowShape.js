// @typecheck
/**
 * How a transcriptions row leaves the store: the detail shape and the list
 * shape. Content columns are opened through stores/transcriptCrypto.js.
 *
 * stores/transcriptCrypto.js sits in the server's big import
 * cycle, so this module does not require it: the barrel
 * (stores/transcriptionStore.js) hands it in, and the cycle does not grow by
 * the files the store was split into.
 */

const { parseJsonArray } = require('./jsonArrays');

/**
 * @param {{ transcriptCrypto: any }} deps  the module stores/transcriptCrypto.js
 */
function createRowShape({ transcriptCrypto }) {
    /**
     * Shape a FULL row for the detail view.
     *
     * `ctx` decides only how to OPEN what is there — never whether it is encrypted.
     * decryptRow asks each value what it is, so a plaintext row and an encrypted
     * one shape identically and a backfill can run while people are reading.
     *
     * A column that IS an envelope but will not open throws, deliberately. This
     * feeds updateTranscription, which writes back what it read: a silent '' would
     * overwrite a meeting's transcript with nothing.
     */
    function shapeRow(r, userId, ctx = transcriptCrypto.PLAINTEXT_CONTEXT) {
        r = transcriptCrypto.decryptRow(r, ctx);
        return {
            ...mapRow(r, ctx),
            fullText: r.full_text || '',
            transcript: r.transcript || '',
            summary: r.summary || '',
            audioPath: r.audio_path || '',
            segments: parseJsonArray(r.segments),
            speakers: parseJsonArray(r.speakers),
            sharedWith: parseJsonArray(r.shared_with),
            sharedGroups: parseJsonArray(r.shared_groups),
            isPublished: !!r.is_published,
            organizationId: r.organization_id || null,
            actionItems: parseJsonArray(r.action_items),
            decisions: parseJsonArray(r.decisions),
            questions: parseJsonArray(r.questions),
            // The moment of THIS read, from the database clock — the starting
            // point for a writer that takes minutes. null when the query did not
            // select it, and the caller then falls back to `updatedAt` (same clock).
            readAt: r.read_at || null,
            tags: parseJsonArray(r.tags),
            attendees: parseJsonArray(r.attendees),
            chapters: parseJsonArray(r.chapters),
            numSpeakers: r.num_speakers != null ? Number(r.num_speakers) : null,
            audioStorageKey: r.audio_storage_key || null,
            voiceprintMatches: parseJsonArray(r.voiceprint_matches),
            source: r.source || 'upload',
            sourceUri: r.source_uri || null,
            talkRoomToken: r.talk_room_token || null,
            // Which template (and which version of it) wrote this summary. null
            // stays null — the screen then says nothing rather than naming a
            // version it does not know.
            summaryTemplateId: r.summary_template_id || null,
            summaryTemplateVersion: Number.isInteger(Number(r.summary_template_version)) && Number(r.summary_template_version) > 0
                ? Number(r.summary_template_version)
                : null,
            isOwner: r.user_id === userId,
            ownerId: r.user_id,
        };
    }

    /**
     * Shape a row for a LIST payload.
     *
     * The list never selects `full_text`, so nothing large is decrypted here: only
     * the stored preview and the summary, both small. `ctx` decides how to open
     * them, never whether they are open — a plaintext row and an encrypted one
     * shape identically.
     */
    function mapRow(r, ctx = transcriptCrypto.PLAINTEXT_CONTEXT) {
        // Present only on list payloads, where the query aliases the whole summary
        // column. On a detail payload the summary already came through shapeRow.
        const summarySnippet = r.summary_snippet !== undefined
            ? transcriptCrypto.readSummarySnippet(r, ctx)
            : undefined;
        return {
            id: r.id,
            title: r.title,
            fileName: r.file_name,
            language: r.language,
            durationSeconds: r.duration_seconds,
            speakerCount: r.speaker_count,
            segmentCount: r.segment_count,
            status: r.status || 'completed',
            provider: r.provider || 'voxtral',
            source: r.source || 'upload',
            talkRoomToken: r.talk_room_token || null,
            meetMeetingCode: r.meet_meeting_code || null,
            isPublished: !!r.is_published,
            sharedGroups: parseJsonArray(r.shared_groups),
            // Tags travel on list payloads too — the library filter chips and
            // auto-generated topic tags render straight from the list query.
            ...(r.tags !== undefined ? { tags: parseJsonArray(r.tags) } : {}),
            organizationId: r.organization_id || null,
            // The project this note is filed into, where the query selected it.
            ...(r.project_id !== undefined ? { projectId: r.project_id || null } : {}),
            createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
            updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
            // Short transcript prefix surfaced for client-side search; only present
            // on list payloads (full text comes through getTranscription).
            ...(r.full_text_snippet !== undefined
                ? { transcriptSnippet: transcriptCrypto.readSnippet(r, ctx) }
                : {}),
            // Likewise a prefix of the generated summary, so a list row can say
            // what the meeting was ABOUT without shipping the whole summary of
            // every recording. Used by the sidebar's recently-edited panel.
            ...(summarySnippet !== undefined ? { summarySnippet } : {}),
            // List-only aggregates (LIST_AGGREGATES): action counts for the rail's
            // meta line, and the failure reason under its own name. Absent on
            // payloads that did not select them, never 0-by-default.
            ...(r.actions_total !== undefined ? { actionsTotal: Number(r.actions_total) || 0 } : {}),
            ...(r.actions_open !== undefined ? { actionsOpen: Number(r.actions_open) || 0 } : {}),
            // Derived here rather than in SQL: the reason lives in `summary`, and
            // LEFT() over an envelope is not something a person can read.
            ...(summarySnippet !== undefined
                ? { failureReason: r.status === 'failed' ? (summarySnippet || null) : null }
                : {}),
        };
    }

    return { shapeRow, mapRow };
}

module.exports = { createRowShape };
