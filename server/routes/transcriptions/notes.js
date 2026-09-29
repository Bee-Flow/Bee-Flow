/**
 * Transcriptions — listing & retrieval.
 *
 * GET /                     — list the user's transcriptions
 * GET /:id                  — full transcription with segments
 * GET /:id/series-previous  — previous note in the same recurring series
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const transcriptionStore = require('../../stores/transcriptionStore');
const { resolveAccessContext, withInsightsPolicy } = require('./shared');

// Auth middleware
// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const { whole, NO_QUERY } = require('./schemas');

// De bladwijzer van de lijst, en niets anders. `.strict()`, want elke andere
// parameter die iemand hier verwacht — een filter op tag, op status, op
// periode — kwam terug als "de laatste 50 van alles", en dat is een ANDER
// antwoord dan de vraag.
const ListQuery = z.object({ limit: whole('limit'), offset: whole('offset') }).strict();

// ── List transcriptions ──────────────────────────────────

router.get('/', requireAuth, validate({ query: ListQuery }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const limit = Math.min(req.query.limit ?? 50, 100);
        const offset = Math.max(req.query.offset ?? 0, 0);
        // Reap async jobs stuck in 'processing' (e.g. server restarted mid-run) so
        // the list stops spinning on them. Best-effort; never block the listing.
        transcriptionStore.timeoutStuckTranscriptions().catch(() => {});
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const transcriptions = await transcriptionStore.getTranscriptions(userId, { limit, offset, orgIds, userGroupIds, isSuperAdmin });
        res.json({ transcriptions });
    } catch (err) {
        log.error('[Transcriptions] List error:', err.message);
        res.status(500).json({ error: 'Failed to list transcriptions' });
    }
});

// ── Get single transcription ─────────────────────────────

// Static GET routes below (e.g. /nextcloud-talk-recordings, /talk-meetings) are
// registered after this param route, so let their literal names fall through
// instead of being captured as an :id and 404'ing.
const RESERVED_GET_PATHS = new Set(['nextcloud-audio-files', 'nextcloud-talk-recordings', 'talk-meetings', 'gmeet-meetings', 'gmeet-imports', 'gmeet-recordings']);

// The fall-through check comes BEFORE the query schema, and it has to.
// `/nextcloud-talk-recordings?folder=/Custom` is captured by THIS route first
// — that is what RESERVED_GET_PATHS exists for — and a strict query schema in
// front of the fall-through would refuse `folder` on behalf of a route that
// reads it perfectly well. `next('route')` leaves the route entirely, so the
// literal name reaches the sub-router that owns it, schema and all.
router.get('/:id', requireAuth,
    (req, res, next) => (RESERVED_GET_PATHS.has(req.params.id) ? next('route') : next()),
    validate({ query: NO_QUERY }),
    async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { orgIds, userGroupIds, isSuperAdmin } = await resolveAccessContext(req);
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId, { orgIds, userGroupIds, isSuperAdmin });
        if (!transcription) return res.status(404).json({ error: 'Transcription not found' });
        res.json(await withInsightsPolicy(transcription));
    } catch (err) {
        log.error('[Transcriptions] Get error:', err.message);
        res.status(500).json({ error: 'Failed to get transcription' });
    }
});

// ── Previous note in the same recurring series ───────────

// "Previously in this series": the most recent earlier note recorded from the
// same Google Meet code / Talk room, ACL-checked twice (this note + the
// previous one). Notes without a series link answer { previous: null }.
router.get('/:id/series-previous', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const ctx = await resolveAccessContext(req);
        const transcription = await transcriptionStore.getTranscription(req.params.id, userId, ctx);
        if (!transcription) return res.status(404).json({ error: 'Not found' });
        if (!transcription.meetMeetingCode && !transcription.talkRoomToken) {
            return res.json({ previous: null });
        }
        const previous = await transcriptionStore.getSeriesPrevious({
            meetMeetingCode: transcription.meetMeetingCode || null,
            talkRoomToken: transcription.meetMeetingCode ? null : transcription.talkRoomToken,
            beforeCreatedAt: transcription.createdAt,
            excludeId: transcription.id,
            userId,
            ...ctx,
        });
        // The card needs a preview, not the whole summary.
        res.json({
            previous: previous
                ? { ...previous, summary: (previous.summary || '').slice(0, 1200) }
                : null,
        });
    } catch (err) {
        log.error('[Transcriptions] Series-previous error:', err.message);
        res.status(500).json({ error: 'Failed to load series context' });
    }
});

module.exports = router;
