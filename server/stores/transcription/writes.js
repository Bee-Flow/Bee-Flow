// @typecheck
/**
 * The content writes of the transcription store: the INSERT and the generic
 * UPDATE, both sealing content columns through transcriptCrypto.encryptRow,
 * and the claim/finish pair a (re)processing run writes through.
 *
 * stores/transcriptCrypto.js sits in the server's big import
 * cycle, so this module does not require it: the barrel
 * (stores/transcriptionStore.js) hands it in, and the cycle does not grow by
 * the files the store was split into.
 */

const crypto = require('crypto');
const { run, getOne } = require('../../db');
const { buildUpdate } = require('../lib/sqlBuilder');
// Request-scoped, via AsyncLocalStorage — so a store this deep does not need
// every caller to thread the client down to it. Returns 'unknown' outside a
// request, which is what a background ingest should record.
const { currentClient } = require('../../telemetry/requestClient');
const log = require('../../telemetry/log');
const { initDB } = require('./schema');
const { parseJsonArray, toArray } = require('./jsonArrays');
const { artifactColumnSql } = require('./artifactWindow');

/**
 * @param {{ transcriptCrypto: any }} deps  the module stores/transcriptCrypto.js
 */
function createWrites({ transcriptCrypto }) {
    // ── CRUD ─────────────────────────────────────────────────

    // NOTE: this destructure IS the write contract. A caller can pass anything, but
    // only the keys named here reach the INSERT — `sharedWith` was missing for a
    // long time, so Google Meet's "share the note with the attendees" feature
    // silently discarded its share list on every single import, with no error.
    // Adding a column means adding it in THREE places: here, the column list, and
    // the values array. A column holding CONTENT means a fourth: the list in
    // stores/transcriptCrypto.js, or it goes to disk in plaintext.
    async function createTranscription({ userId, organizationId, title, fileName, language, durationSeconds, speakerCount, segmentCount, fullText, transcript, segments, speakers, summary, status, audioPath, provider, actionItems, source, sourceUri, talkRoomToken, meetMeetingCode, attendees, chapters, numSpeakers, audioStorageKey, decisions, questions, tags, sharedWith, client, summaryTemplateId, summaryTemplateVersion, projectId }) {
        await initDB();
        const id = crypto.randomUUID();
        // Content columns are sealed here, before anything reaches the driver. The
        // counters and the preview are computed from the PLAINTEXT first — after
        // encryption there is nothing left to count or truncate.
        const ctx = await transcriptCrypto.resolveTranscriptCrypto(organizationId || null);
        const snippet = transcriptCrypto.buildSnippet(id, fullText || '', ctx);
        const summarySnippet = transcriptCrypto.buildSummarySnippet(id, summary || '', ctx);
        const sealed = transcriptCrypto.encryptRow(id, {
            full_text: fullText || '',
            transcript: transcript || '',
            summary: summary || '',
            segments: JSON.stringify(toArray(segments)),
            speakers: JSON.stringify(toArray(speakers)),
            attendees: JSON.stringify(toArray(attendees)),
            chapters: JSON.stringify(toArray(chapters)),
        }, ctx);
        const { rowCount } = await run(
            `INSERT INTO transcriptions (id, user_id, organization_id, title, file_name, language, duration_seconds, speaker_count, segment_count, full_text, transcript, segments, speakers, summary, status, audio_path, provider, action_items, source, source_uri, talk_room_token, meet_meeting_code, attendees, chapters, num_speakers, audio_storage_key, decisions, questions, tags, shared_with, client, summary_template_id, summary_template_version, full_text_snippet_enc, summary_snippet_enc, project_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36)
             ON CONFLICT (source_uri) WHERE source_uri IS NOT NULL DO NOTHING`,
            [id, userId, organizationId || null, title || fileName || 'Untitled', fileName, language || 'nl', durationSeconds || 0, speakerCount || 0, segmentCount || 0, sealed.full_text, sealed.transcript, sealed.segments, sealed.speakers, sealed.summary, status || 'completed', audioPath || '', provider || 'voxtral', JSON.stringify(toArray(actionItems)), source || 'upload', sourceUri || null, talkRoomToken || null, meetMeetingCode || null, sealed.attendees, sealed.chapters, Number.isFinite(numSpeakers) && numSpeakers >= 1 ? Math.round(numSpeakers) : null, audioStorageKey || null, JSON.stringify(toArray(decisions)), JSON.stringify(toArray(questions)), JSON.stringify(toArray(tags)), JSON.stringify(toArray(sharedWith)), client || currentClient(), summaryTemplateId || null, Number.isInteger(summaryTemplateVersion) ? summaryTemplateVersion : null, snippet, summarySnippet, projectId || null]
        );
        // Lost the race (same source_uri already ingested concurrently) — return the winner.
        if (rowCount === 0 && sourceUri) {
            const existing = await getOne('SELECT id, user_id, organization_id FROM transcriptions WHERE source_uri = $1', [sourceUri]);
            if (existing) {
                log.info(`[TranscriptionStore] Dedup hit for ${sourceUri} → existing ${existing.id}`);
                return { id: existing.id, userId: existing.user_id, organizationId: existing.organization_id || null, dedup: true };
            }
        }
        log.info(`[TranscriptionStore] Created transcription "${title}" (${status || 'completed'}) via ${provider || 'voxtral'} for user ${userId}`);
        return { id, userId, organizationId: organizationId || null, title, fileName, language, durationSeconds, speakerCount, segmentCount, status: status || 'completed', provider: provider || 'voxtral', source: source || 'upload', sourceUri: sourceUri || null, talkRoomToken: talkRoomToken || null, meetMeetingCode: meetMeetingCode || null, projectId: projectId || null, createdAt: new Date().toISOString() };
    }

    /**
     * Take exclusive ownership of a note for a (re)processing run.
     *
     * Reprocess used to read the status, then blind-write `processing`, so two
     * concurrent runs both believed they owned the note — a double-click on Retry
     * was enough. Whichever finished LAST won, and a loser that merely errored
     * (e.g. a 429 caused by the other run) wrote `status:'failed'` over the
     * winner's completed note, destroying the generated summary. Both runs were
     * billed in full.
     *
     * The claim is a single conditional UPDATE, so exactly one caller can win even
     * across replicas.
     *
     * @returns {Promise<boolean>} true when this caller now owns the run.
     */
    async function claimForProcessing(id, userId) {
        await initDB();
        const { rowCount } = await run(
            `UPDATE transcriptions SET status = 'processing', updated_at = NOW()
              WHERE id = $1 AND user_id = $2 AND status IS DISTINCT FROM 'processing'`,
            [id, userId]
        );
        return rowCount > 0;
    }

    /**
     * Write the outcome of a run ONLY while this caller still owns it.
     *
     * Guards the mirror image of the race above: a slow failing run must not stamp
     * its error over a note that has since been completed (or re-claimed) by
     * someone else. `status` is part of the predicate, not just the payload.
     *
     * @returns {Promise<boolean>} false when the claim was lost and nothing was written.
     */
    async function finishProcessing(id, userId, updates) {
        await initDB();
        const owned = await getOne(
            `SELECT id FROM transcriptions WHERE id = $1 AND user_id = $2 AND status = 'processing'`,
            [id, userId]
        );
        if (!owned) return false;
        await updateTranscription(id, userId, updates);
        return true;
    }

    /**
     * The plain assignments of a note: one value in, one column out, one
     * parameter. A factory rather than a constant, because the content columns
     * go through the envelope and that key belongs to the row and its
     * organisation.
     */
    function plainColumns(id, cryptoCtx) {
        /**
         * Seal one content column's value on its way into `params`.
         * @param {string} column
         * @param {string} value
         */
        const seal = (column, value) => transcriptCrypto.encryptRow(id, { [column]: value }, cryptoCtx)[column];
        return {
            title: 'title',
            tags: { col: 'tags', transform: v => JSON.stringify(toArray(v)) },
            summary: { col: 'summary', transform: v => seal('summary', v) },
            // The stored preview is derived from this column and has to move with
            // it, or the list keeps showing the previous summary indefinitely.
            summarySnippet: { col: 'summary_snippet_enc', transform: v => transcriptCrypto.buildSummarySnippet(id, v || '', cryptoCtx) },
            speakers: { col: 'speakers', transform: v => seal('speakers', JSON.stringify(toArray(v))) },
            segments: { col: 'segments', transform: v => seal('segments', JSON.stringify(toArray(v))) },
            speakerCount: { col: 'speaker_count', transform: v => new Set((v || []).map(s => s.speaker || s.speakerId)).size },
            segmentCount: { col: 'segment_count', transform: v => (v || []).length },
            transcript: { col: 'transcript', transform: v => seal('transcript', v) },
            chapters: { col: 'chapters', transform: v => seal('chapters', JSON.stringify(toArray(v))) },
            attendees: { col: 'attendees', transform: v => seal('attendees', JSON.stringify(toArray(v))) },
            // Fields the async upload pipeline fills in when a 'processing' note completes.
            status: 'status',
            fullText: { col: 'full_text', transform: v => seal('full_text', v) },
            // The stored preview is derived from this column, so it has to move
            // with it. Leaving it behind would show the previous transcript's
            // opening lines against the new one, indefinitely.
            fullTextSnippet: { col: 'full_text_snippet_enc', transform: v => transcriptCrypto.buildSnippet(id, v || '', cryptoCtx) },
            audioPath: 'audio_path',
            // The durable object-storage key. It used to be writable ONLY by the INSERT,
            // so a note created while object storage happened to be unreachable carried
            // a NULL key forever — and on a deployment with no persistent volume (which
            // is ours) that made the recording permanently unrecoverable the moment the
            // pod holding the local copy went away.
            audioStorageKey: { col: 'audio_storage_key', transform: v => v || null },
            durationSeconds: 'duration_seconds',
            provider: 'provider',
            voiceprintMatches: { col: 'voiceprint_matches', transform: v => JSON.stringify(toArray(v)) },
            // The template stamp. Both columns are explicitly OVERWRITABLE with
            // null: whoever has the summary rewritten with a one-off prompt
            // should lose the old stamp, since it would then describe text that
            // template never made. Hence `|| null` instead of "only write when
            // there is a value".
            summaryTemplateId: { col: 'summary_template_id', transform: v => v || null },
            summaryTemplateVersion: { col: 'summary_template_version', transform: v => (Number.isInteger(v) ? v : null) },
        };
    }

    async function updateTranscription(id, userId, updates) {
        await initDB();
        // The org owns the key, and the caller does not pass it — so look it up
        // once, here, rather than threading it through every call site. A row that
        // no longer exists resolves to a plaintext context and the UPDATE below
        // matches nothing anyway.
        const owner = await getOne('SELECT organization_id FROM transcriptions WHERE id = $1', [id]);
        const cryptoCtx = await transcriptCrypto.resolveTranscriptCrypto(owner?.organization_id || null);
        // Two kinds of write sit in this one statement, and only one of them is
        // a plain assignment. Those go through the builder; the CONDITIONAL
        // writes further down — write-if-unchanged, write-if-empty, and the
        // merge window of the artifact columns — each build their own CASE or
        // subselect OVER the stored value, and that is not a `column = value`
        // a column map can describe.
        //
        // This table says WHICH caller value feeds which column; three keys
        // feed more than one. `undefined` means "leave alone" everywhere, so a
        // field that was not sent simply drops out.
        const write = {
            title: updates.title,
            tags: updates.tags,
            summary: updates.summary,
            summarySnippet: updates.summary,
            speakers: updates.speakers,
            segments: updates.segments,
            speakerCount: updates.segments,
            segmentCount: updates.segments,
            transcript: updates.transcript,
            chapters: updates.chapters,
            attendees: updates.attendees,
            status: updates.status,
            fullText: updates.fullText,
            fullTextSnippet: updates.fullText,
            audioPath: updates.audioPath,
            audioStorageKey: updates.audioStorageKey,
            durationSeconds: updates.durationSeconds,
            provider: updates.provider,
            voiceprintMatches: updates.voiceprintMatches,
            summaryTemplateId: updates.summaryTemplateId,
            summaryTemplateVersion: updates.summaryTemplateVersion,
        };
        const built = buildUpdate({
            table: 'transcriptions',
            updates: write,
            columnMap: plainColumns(id, cryptoCtx),
        });

        const params = built ? built.params : [];
        /** @type {string[]} */
        const setClauses = [];
        let idx = params.length + 1;

        // The AI title lands minutes after the note row was created, by which time
        // the user may already have renamed it — the note is visible and editable
        // the whole time it is 'processing'. Same shape as `tagsIfEmpty`: write
        // only while the column still holds the placeholder we put there.
        if (updates.titleIfUnchanged !== undefined) {
            setClauses.push(`title = CASE WHEN title = $${idx + 1} THEN $${idx}::text ELSE title END`);
            params.push(updates.titleIfUnchanged.title, updates.titleIfUnchanged.expected);
            idx += 2;
        }
        // ── The starting point of a running run (see artifactColumnSql) ─────
        // One parameter for all three artifact columns: the same moment, from
        // the same read. Without it the three columns write as always (with a
        // stamp, without a window) — the path of every other writer, which has
        // no minutes between reading and writing.
        /** @type {string | null} */
        let sincePh = null;
        const writesArtifacts = updates.actionItems !== undefined
            || updates.decisions !== undefined || updates.questions !== undefined;
        if (writesArtifacts && typeof updates.artifactsSince === 'string' && updates.artifactsSince) {
            sincePh = `$${idx++}`;
            params.push(updates.artifactsSince);
        }
        if (updates.actionItems !== undefined) {
            setClauses.push(`action_items = ${artifactColumnSql('action_items', `$${idx++}`, sincePh)}`);
            params.push(JSON.stringify(toArray(updates.actionItems)));
        }
        if (updates.decisions !== undefined) {
            setClauses.push(`decisions = ${artifactColumnSql('decisions', `$${idx++}`, sincePh)}`);
            params.push(JSON.stringify(toArray(updates.decisions)));
        }
        if (updates.questions !== undefined) {
            setClauses.push(`questions = ${artifactColumnSql('questions', `$${idx++}`, sincePh)}`);
            params.push(JSON.stringify(toArray(updates.questions)));
        }
        // Auto-generated topic tags must never clobber tags a user typed: this
        // variant only fills the column while it is still empty.
        if (updates.tagsIfEmpty !== undefined) {
            setClauses.push(`tags = CASE WHEN tags IS NULL OR tags = '[]'::jsonb THEN $${idx++}::jsonb ELSE tags END`);
            params.push(JSON.stringify(toArray(updates.tagsIfEmpty)));
        }
        // Repair variant: fill the key only while it is still missing. Two replicas
        // can both notice the same unstored file and race; whoever lands second must
        // not overwrite a key that is already good. Same shape as `tagsIfEmpty`.
        if (updates.audioStorageKeyIfMissing !== undefined) {
            setClauses.push(`audio_storage_key = CASE WHEN audio_storage_key IS NULL THEN $${idx++}::text ELSE audio_storage_key END`);
            params.push(updates.audioStorageKeyIfMissing);
        }

        if (!built && setClauses.length === 0) return false;
        const setSql = (built ? `${built.sql}, ` : 'UPDATE transcriptions SET ')
            + [...setClauses, 'updated_at = NOW()'].join(', ');
        params.push(id, userId);
        // RETURNING the three artifact columns — only when this write touches
        // one of them. What LANDS may then differ from what the caller sent (a
        // row created during the run stays), and the caller must be able to
        // answer the client with that: otherwise the row disappears from the
        // screen while it sits safely in the database — to the person watching,
        // indistinguishable from losing it. An update that does not touch the
        // columns (an audio-key repair, say) does not drag them back either.
        // The return value stays falsy when nothing was written, so
        // `if (!updated) 404` at the callers does not change.
        const { rowCount, rows } = await run(
            `${setSql} WHERE id = $${params.length - 1} AND user_id = $${params.length}`
            + (writesArtifacts ? ` RETURNING action_items, decisions, questions` : ''),
            params
        );
        if (!(rowCount > 0)) return false;
        const written = rows && rows[0];
        return written
            ? {
                ok: true,
                actionItems: parseJsonArray(written.action_items),
                decisions: parseJsonArray(written.decisions),
                questions: parseJsonArray(written.questions),
            }
            : true;
    }

    return { createTranscription, claimForProcessing, finishProcessing, updateTranscription };
}

module.exports = { createWrites };

/**
 * @typedef {{
 *   title?: unknown, tags?: unknown, summary?: unknown, speakers?: unknown, segments?: unknown,
 *   transcript?: unknown, chapters?: unknown, attendees?: unknown, status?: unknown, fullText?: unknown,
 *   audioPath?: unknown, audioStorageKey?: unknown, durationSeconds?: unknown, provider?: unknown,
 *   voiceprintMatches?: unknown, summaryTemplateId?: unknown, summaryTemplateVersion?: unknown,
 *   titleIfUnchanged?: { title: unknown, expected: unknown }, actionItems?: unknown, decisions?: unknown,
 *   questions?: unknown, artifactsSince?: unknown, tagsIfEmpty?: unknown, audioStorageKeyIfMissing?: unknown,
 * }} TranscriptionUpdates
 */
