/**
 * Transcriptions — the tag vocabulary with counts.
 *
 * GET /tags  →  [{ tag, count }]   (count DESC, tag ASC; at most TAG_LIMIT rows)
 *
 * Feeds the library's filter chips ("dataweging 4 · spelersmonitor 3 · +9
 * tags", Meeting Notes artboard 1a). The client used to derive the vocabulary
 * from the rows it had loaded, which is a PAGE of 50: a tag on the 51st note
 * did not exist. This counts over every note the caller may READ — the same
 * predicate as the list (transcriptionStore.getTranscriptions: own rows,
 * legacy per-user shares, published-to-my-org rows filtered by group), so a
 * chip can never name a tag on a note the caller could not open. Super admins
 * count over everything, as they list everything.
 *
 * MOUNT ORDER MATTERS: this router must be mounted BEFORE ./notes in
 * routes/transcriptions.js, whose `GET /:id` would otherwise capture the
 * literal "tags" as a note id and answer 404.
 *
 * The K chain adds a GIN index on `tags` in transcriptionStore; this query is
 * correct without it and merely faster with it.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const { getAll } = require('../../db');
const { requireAuth } = require('../../auth/permissions');
const { resolveAccessContext } = require('./shared');
const { validate } = require('../../core/http/validate');
const { NO_QUERY } = require('./schemas');

const TAG_LIMIT = 200;

/**
 * The list read-ACL as `{ where, params }`. Deliberately the same shape as the
 * store's list predicate and the COUNT in routes/studio/counts.js: an empty
 * orgIds / userGroupIds never reaches Postgres as ANY('{}'::text[]) /
 * ?| ARRAY[]::text[], which some `pg` versions mishandle.
 */
function buildListAcl(userId, { orgIds = [], userGroupIds = [] } = {}) {
    const params = [userId, JSON.stringify([userId])];
    const clauses = ['user_id = $1', 'shared_with @> $2::jsonb'];
    if (Array.isArray(orgIds) && orgIds.length > 0) {
        params.push(orgIds);
        const orgIdx = params.length;
        if (Array.isArray(userGroupIds) && userGroupIds.length > 0) {
            params.push(userGroupIds);
            const groupIdx = params.length;
            clauses.push(`(is_published = true AND organization_id = ANY($${orgIdx}::text[]) AND (shared_groups = '[]'::jsonb OR shared_groups ?| $${groupIdx}::text[]))`);
        } else {
            clauses.push(`(is_published = true AND organization_id = ANY($${orgIdx}::text[]) AND shared_groups = '[]'::jsonb)`);
        }
    }
    return { where: clauses.join(' OR '), params };
}

/**
 * `tags` is a JSONB array written straight through by `PATCH /:id`
 * (noteActions.js does not validate it) and by the auto topic-tagger, so this
 * query defends itself twice:
 *   - a non-array value — a scalar from an unvalidated PATCH — counts as NO
 *     tags, the same rule parseJsonArray applies on the read side, so one bad
 *     row can never take the chips down for everyone;
 *   - only STRING elements become chips. A number or an object in the array
 *     would otherwise render a chip that no note can ever match: the client
 *     filters with `tags.includes(tag)` on the string.
 * `#>> '{}'` is the scalar-to-text extraction (a jsonb string without its
 * quotes).
 */
const TAG_SOURCE = `LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END) AS tag_of(value)`;
const TAG_TEXT = `(tag_of.value #>> '{}')`;
/**
 * A chip counts NOTES, not tag occurrences — that is what the chip promises
 * ("dataweging 4" = four meetings), and it is what the rail's own filter
 * shows when you click it. COUNT(*) would say 5 for a note whose array holds
 * the same tag twice, which nothing stops today.
 */
const TAG_COUNT = `COUNT(DISTINCT transcriptions.id)::int AS count`;
const TAG_FILTER = `jsonb_typeof(tag_of.value) = 'string' AND ${TAG_TEXT} <> ''`;

router.get('/tags', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        let sql;
        let params;
        if (isSuperAdmin) {
            sql = `SELECT ${TAG_TEXT} AS tag, ${TAG_COUNT}
                     FROM transcriptions, ${TAG_SOURCE}
                    WHERE ${TAG_FILTER}
                    GROUP BY ${TAG_TEXT}
                    ORDER BY count DESC, tag ASC
                    LIMIT ${TAG_LIMIT}`;
            params = [];
        } else {
            const acl = buildListAcl(userId, { orgIds, userGroupIds });
            sql = `SELECT ${TAG_TEXT} AS tag, ${TAG_COUNT}
                     FROM transcriptions, ${TAG_SOURCE}
                    WHERE (${acl.where}) AND ${TAG_FILTER}
                    GROUP BY ${TAG_TEXT}
                    ORDER BY count DESC, tag ASC
                    LIMIT ${TAG_LIMIT}`;
            params = acl.params;
        }
        const rows = await getAll(sql, params);
        res.json((rows || []).map((r) => ({ tag: String(r.tag), count: Number(r.count) || 0 })));
    } catch (err) {
        log.error('[Transcriptions] Tags error:', err.message);
        res.status(500).json({ error: 'Failed to list tags' });
    }
});

module.exports = router;
module.exports.buildListAcl = buildListAcl;
