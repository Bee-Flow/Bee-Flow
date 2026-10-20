// @typecheck
/**
 * The content reads of the transcription store: the library list, the tag
 * listing for knowledge sources, and the detail read. Each applies the read
 * rule from ./acl.js.
 *
 * stores/transcriptCrypto.js (and through it the row shapes) sits in the server's big import
 * cycle, so this module does not require it: the barrel
 * (stores/transcriptionStore.js) hands it in, and the cycle does not grow by
 * the files the store was split into.
 */

const { getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const { parseJsonArray } = require('./jsonArrays');
const { DB_CLOCK_ISO } = require('./artifactWindow');
const { buildReadAcl, readAclClauses } = require('./acl');

/**
 * The per-row aggregates the LIBRARY rail needs (Meeting Notes artboard 1a:
 * "27 jul · 1:01 · 14 acties open"), computed in Postgres so a list row never
 * ships the action_items array itself:
 *   actions_total   — how many action items the note carries
 *   actions_open    — how many of those are not done (`done` is a client-set
 *                     flag; compared as text, so a stray "yes" cannot throw
 *                     the way a ::boolean cast on it would — and one bad row
 *                     must never take the whole list down)
 *   failure_reason  — a failed note stores WHY in `summary` (upload.js /
 *                     reprocess.js write `Transcription failed: …` there);
 *                     surfaced under its own name so the client stops
 *                     reading a summary that is not one
 * A non-array `action_items` (a JSON scalar from an unvalidated PATCH) counts
 * as empty, matching parseJsonArray on the read side.
 */
// action_items stays plaintext (see stores/transcriptCrypto.js — it is merged
// in SQL on write), so these two expressions keep working unchanged. The
// failure reason does NOT: it lives in `summary`, which is encrypted, and
// LEFT() over an envelope returns the head of a ciphertext. It is derived in
// Node instead, from the summary the list already carries.
const LIST_AGGREGATES = `
                    COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(action_items) = 'array' THEN action_items ELSE '[]'::jsonb END), 0)::int AS actions_total,
                    (SELECT COUNT(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(action_items) = 'array' THEN action_items ELSE '[]'::jsonb END) AS ai
                      WHERE COALESCE(ai->>'done', 'false') <> 'true')::int AS actions_open`;

/**
 * @param {{ transcriptCrypto: any, shapeRow: Function, mapRow: Function, readableThroughProject: Function }} deps
 */
function createReads({ transcriptCrypto, shapeRow, mapRow, readableThroughProject }) {
    async function getTranscriptions(userId, { limit = 50, offset = 0, orgIds = [], userGroupIds = [], isSuperAdmin = false } = {}) {
        await initDB();
        // Super admins (resolveUserOrgIds === null) see every transcription
        // unconditionally — mirrors the bypass that exists in agents/KBs.
        if (isSuperAdmin) {
            const rows = await getAll(
                `SELECT id, user_id, organization_id, title, file_name, language, duration_seconds, speaker_count, segment_count,
                        shared_with, is_published, shared_groups, created_at, updated_at, provider, status, source, talk_room_token, meet_meeting_code, tags, project_id,
                        LEFT(COALESCE(full_text, ''), 2000) AS full_text_snippet,
                        full_text_snippet_enc,
                        LEFT(COALESCE(summary, ''), 400) AS summary_snippet,
                        summary_snippet_enc,${LIST_AGGREGATES}
                 FROM transcriptions
                 ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
                [limit, offset]
            );
            const byOrg = await transcriptCrypto.resolveForRows(rows);
            return rows.map(r => ({
                ...mapRow(r, transcriptCrypto.ctxForRow(byOrg, r)),
                isOwner: r.user_id === userId, ownerId: r.user_id,
            }));
        }
        // Normal user: own rows + legacy per-user shares + published-to-my-org rows.
        // We build the WHERE clause incrementally so an empty orgIds / userGroupIds
        // never reaches Postgres as ANY('{}'::text[]) / ?| ARRAY[]::text[] — both
        // of which the `pg` driver mishandles in some versions.
        const params = [userId, limit, offset, JSON.stringify([userId])];
        const clauses = [`user_id = $1`, `shared_with @> $4::jsonb`];
        if (Array.isArray(orgIds) && orgIds.length > 0) {
            params.push(orgIds);
            const orgParamIdx = params.length;
            if (Array.isArray(userGroupIds) && userGroupIds.length > 0) {
                params.push(userGroupIds);
                const groupParamIdx = params.length;
                clauses.push(
                    `(is_published = true AND organization_id = ANY($${orgParamIdx}::text[]) AND (shared_groups = '[]'::jsonb OR shared_groups ?| $${groupParamIdx}::text[]))`
                );
            } else {
                clauses.push(
                    `(is_published = true AND organization_id = ANY($${orgParamIdx}::text[]) AND shared_groups = '[]'::jsonb)`
                );
            }
        }
        const rows = await getAll(
            `SELECT id, user_id, organization_id, title, file_name, language, duration_seconds, speaker_count, segment_count,
                    shared_with, is_published, shared_groups, created_at, updated_at, provider, status, source, talk_room_token, meet_meeting_code, tags, project_id,
                    LEFT(COALESCE(full_text, ''), 2000) AS full_text_snippet,
                    full_text_snippet_enc,
                    LEFT(COALESCE(summary, ''), 400) AS summary_snippet,
                    summary_snippet_enc,${LIST_AGGREGATES}
             FROM transcriptions
             WHERE ${clauses.join(' OR ')}
             ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
            params
        );
        const byOrg = await transcriptCrypto.resolveForRows(rows);
        return rows.map(r => ({
            ...mapRow(r, transcriptCrypto.ctxForRow(byOrg, r)),
            isOwner: r.user_id === userId, ownerId: r.user_id,
        }));
    }

    /**
     * Meetings carrying a tag, that this reader may actually open.
     *
     * ── THE READER IS THE KNOWLEDGE BASE'S OWNER, AND THAT IS THE POINT ─
     * A `meeting_tag` knowledge source (K7) turns "every meeting tagged sales"
     * into documents somebody else can search. That WIDENS who can read those
     * summaries — which is exactly why this applies the same read ACL a person
     * opening one note gets, with the KB owner as the reader, rather than
     * enumerating the tag and trusting the caller. A source in a knowledge base
     * shared with the whole organisation can only ever contain meetings its owner
     * could already open.
     *
     * @param {string} tag
     * @param {string} readerId
     * @param {any} [ctx]  `{ orgIds, userGroupIds, since, limit }`
     */
    async function listByTag(tag, readerId, { orgIds = [], userGroupIds = [], since = null, limit = 200 } = {}) {
        await initDB();
        if (!tag || !readerId) return [];
        /** @type {any[]} */
        const params = [JSON.stringify([tag])];
        const where = [`tags @> $1::jsonb`, `status = 'completed'`];
        if (since) {
            params.push(since);
            where.push(`updated_at > $${params.length}`);
        }
        const acl = readAclClauses(readerId, { orgIds, userGroupIds }, params.length);
        params.push(...acl.params);
        where.push(`(${acl.clauses.join(' OR ')})`);
        params.push(Math.min(Math.max(Number(limit) || 200, 1), 1000));

        const rows = await getAll(
            `SELECT id, title, summary, decisions, questions, action_items, tags,
                    created_at, updated_at, organization_id, user_id
               FROM transcriptions
              WHERE ${where.join(' AND ')}
              ORDER BY updated_at DESC
              LIMIT $${params.length}`,
            params,
        );
        // This feeds knowledge-base ingestion, so it carries real content columns
        // and has to open them. One context per organisation in the result set.
        const byOrg = await transcriptCrypto.resolveForRows(rows);
        return (rows || []).map((raw) => {
            const r = transcriptCrypto.decryptRow(raw, transcriptCrypto.ctxForRow(byOrg, raw));
            return {
                id: r.id,
                title: r.title || '',
                summary: r.summary || '',
                decisions: parseJsonArray(r.decisions),
                questions: parseJsonArray(r.questions),
                actionItems: parseJsonArray(r.action_items),
                tags: parseJsonArray(r.tags),
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                organizationId: r.organization_id || null,
                userId: r.user_id,
            };
        });
    }

    /**
     * `read_at` travels along: the moment THIS read happened, from the
     * database's own clock. A reader that then computes for minutes (the
     * regeneration makes four LLM calls before it writes) needs that moment as
     * its starting point — see artifactColumnSql. It is in the same SELECT as
     * the row because it is about that row, and it comes from the same source
     * as the stamps it will later be compared against.
     */
    async function getTranscription(id, userId, ctx = {}) {
        await initDB();
        if (ctx.isSuperAdmin) {
            const r = await getOne(`SELECT *, ${DB_CLOCK_ISO} AS read_at FROM transcriptions WHERE id = $1`, [id]);
            if (!r) return null;
            return shapeRow(r, userId, await transcriptCrypto.resolveTranscriptCrypto(r.organization_id || null));
        }
        const { clauses, params } = buildReadAcl(id, userId, ctx);
        const r = await getOne(
            `SELECT *, ${DB_CLOCK_ISO} AS read_at FROM transcriptions WHERE id = $1 AND (${clauses.join(' OR ')})`,
            params
        );
        if (r) return shapeRow(r, userId, await transcriptCrypto.resolveTranscriptCrypto(r.organization_id || null));
        // Not readable by the ACL above; it may still be a meeting note filed into
        // a project the caller is a member of. A second read, taken only on a miss,
        // so the common owner path stays one query.
        const filed = await readableThroughProject(id, userId, `*, ${DB_CLOCK_ISO} AS read_at`);
        if (!filed) return null;
        const note = shapeRow(filed.row, userId, await transcriptCrypto.resolveTranscriptCrypto(filed.row.organization_id || null));
        return { ...note, projectRole: filed.role };
    }

    return { getTranscriptions, listByTag, getTranscription };
}

module.exports = { LIST_AGGREGATES, createReads };
