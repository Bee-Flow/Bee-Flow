/**
 * Release notes routes.
 *
 *   POST /ingest              → CI ships raw git material; the server drafts   (token)
 *   GET  /public              → published entries for the marketing block      (open)
 *   GET  /admin               → the review queue                              (admin)
 *   PUT  /admin/:id           → editorial changes                             (admin)
 *   POST /admin/:id/publish   → THE human gate                                (admin)
 *   POST /admin/:id/unpublish → pull an entry back out of public view         (admin)
 *   DELETE /admin/:id         → discard                                       (admin)
 *
 * `/ingest` is called by GitHub Actions, not by a logged-in human, so it carries
 * a shared secret rather than a session. With RELEASE_NOTES_TOKEN unset the
 * route is disabled outright (503) rather than left open — an unauthenticated
 * writer into the public changelog is a defacement vector.
 *
 * Nothing written by `/ingest` is publicly visible. Entries land as `draft` and
 * only `/admin/:id/publish` moves them, so machine-written copy always passes a
 * human before it faces a customer.
 *
 * ── What a caller may send ─────────────────────────────────────────────
 *
 * Both bodies are `.strict()`. They were destructured with defaults, and the
 * defaults filed things in the wrong place without a word:
 *
 *   - `/ingest {"chanel": "prod", "version": "prod-…"}` — one letter short —
 *     became channel 'dev' and REWROTE the rolling Unreleased entry instead of
 *     freezing the release, answered `{ success: true }`.
 *   - `PUT /admin/:id {"titel": "…"}` (or `{}`) changed nothing and answered
 *     `{ success: true, entry }` — the panel's "saved" over an untouched row.
 *   - `PUT /admin/:id` stored `items` verbatim, where /ingest re-coerces
 *     them: an item of kind "Feature" vanished from this panel (it groups by
 *     the three kinds) and went public under "Fixed" (the block files unknown
 *     kinds last).
 *   - `PUT /admin/:id {"version": ""}` (or null, or spaces) went through the
 *     store's `v || null`: the release LOST its version and became the rolling
 *     Unreleased entry, which the next dev build rewrites — or, with an
 *     Unreleased entry already there, hit the one-unreleased index as a 500.
 *     A version can be renamed, not emptied.
 *
 * `entry` stays OPEN on purpose: it is re-coerced through coerceDraft — the
 * same rules model output goes through — and that, not a schema, is the gate
 * for its shape, as the comment on /ingest says.
 */

const crypto = require('crypto');
const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const store = require('../stores/releaseNotesStore');
const { draftReleaseNotes } = require('../core/releaseNotesDrafter');
const { coerceDraft, KIND_HEADINGS, MAX_TITLE_LEN, MAX_ITEMS } = require('../core/releaseNotesFormat');
const { requireAdmin } = require('./cmsShared');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

const text = (message) => z.string({ invalid_type_error: message });
/** git lines: one text the CI joins with newlines, or a list. normaliseLines reads both. */
const lines = (name) => z.union([z.string(), z.array(z.string())],
    { errorMap: () => ({ message: `${name} is the git lines, as one text or a list of texts.` }) }).nullish();

const IngestBody = z.object({
    channel: z.enum(['dev', 'prod'], { errorMap: () => ({ message: 'channel must be "dev" or "prod"' }) }).default('dev'),
    // Required for prod — answered below, in the words this route always used.
    version: text('version is text, e.g. "prod-2026.09.22-1".').trim().nullish(),
    commitSubjects: lines('commitSubjects'),
    prTitles: lines('prTitles'),
    diffstat: text('diffstat is the text of git diff --stat.').nullish(),
    services: text('services is the built services, as one comma-separated text.').nullish(),
    fromSha: text('fromSha is a commit sha.').nullish(),
    toSha: text('toSha is a commit sha.').nullish(),
    entry: z.record(z.unknown(), { invalid_type_error: 'entry is a drafted { title, lead, items } object.' }).nullish(),
}).strict();

const KINDS = Object.keys(KIND_HEADINGS);
const KIND_TEXT = `Each item's kind is one of: ${KINDS.join(', ')}.`;
const Item = z.object({
    kind: z.enum(KINDS, { errorMap: () => ({ message: KIND_TEXT }) }),
    title: text('An item title must be text.').max(MAX_TITLE_LEN, `An item title is at most ${MAX_TITLE_LEN} characters.`).default(''),
    body: text('An item body must be text.').default(''),
}, { invalid_type_error: 'Each item is { kind, title, body }.' }).strict()
    .refine((it) => it.title.trim() || it.body.trim(), 'An item needs a title or a body.');

const RENAME_TEXT = 'A version can be renamed, not emptied — the entry without one is the rolling draft the next dev build rewrites.';
const EntryPatch = z.object({
    title: text('A title must be text.').optional(),
    lead: text('A lead must be text.').optional(),
    items: z.array(Item, { invalid_type_error: 'items must be an array' })
        .max(MAX_ITEMS, `An entry has at most ${MAX_ITEMS} items.`).optional(),
    version: text(RENAME_TEXT).trim().min(1, RENAME_TEXT).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, 'Say what to change: title, lead, items or version.');

// ── CI auth ────────────────────────────────────────────────────────────

/**
 * Constant-time bearer check. Lengths are compared first because
 * timingSafeEqual THROWS on a length mismatch — the same shape as the
 * storageProxy and maintenance token gates.
 */
function _authorized(req) {
    const expected = process.env.RELEASE_NOTES_TOKEN || '';
    if (!expected) return false;
    const header = req.get('authorization') || '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function _requireIngestToken(req, res, next) {
    if (!process.env.RELEASE_NOTES_TOKEN) {
        return res.status(503).json({ error: 'release_notes_ingest_disabled' });
    }
    if (!_authorized(req)) return res.status(401).json({ error: 'unauthorized' });
    next();
}

// ── Public read cache ──────────────────────────────────────────────────
// Marketing pages are anonymous and cacheable; a changelog changes a few times
// a week at most. Mirrors publicGithubStats.js: a short TTL, a separate (short)
// failure TTL so a broken DB cannot turn every pageview into a fresh query, and
// an in-flight promise so a cold cache does not stampede.

const PUBLIC_TTL_MS = 5 * 60 * 1000;
const PUBLIC_FAILURE_TTL_MS = 60 * 1000;
let _cache = { at: 0, data: null };
let _failedAt = 0;
let _inFlight = null;

function invalidatePublicCache() {
    _cache = { at: 0, data: null };
    _failedAt = 0;
}

async function _loadPublished() {
    const entries = await store.listPublished({ limit: 20 });
    // Only fields the public is meant to see. from_sha/to_sha/services are
    // build metadata, not customer content, and never leave the admin surface.
    return entries.map(e => ({
        id: e.id,
        version: e.version,
        title: e.title,
        lead: e.lead,
        items: e.items,
        publishedAt: e.publishedAt,
    }));
}

// ── Routes ─────────────────────────────────────────────────────────────

/**
 * POST /ingest
 * Body: { channel: 'dev'|'prod', version?, commitSubjects?, prTitles?, diffstat?,
 *         services?, fromSha?, toSha?, entry? }
 *
 * `entry` is an already-drafted { title, lead, items } — CI drafts it when the
 * workflow has model credentials, because the GitHub Release body has to be
 * written in that same run (see scripts/release-notes/draft.js). Supplying it
 * skips the model call here; omitting it keeps the original behaviour, where
 * this server drafts from the raw material.
 *
 * A supplied entry is NOT trusted as-is: it is re-coerced through the same
 * rules the model output goes through, so a caller holding the ingest token
 * cannot write arbitrary shapes — or unbounded text — into the changelog.
 */
router.post('/ingest', _requireIngestToken, validate({ body: IngestBody }), async (req, res) => {
    const {
        channel, version = null,
        commitSubjects, prTitles, diffstat,
        services = null, fromSha = null, toSha = null,
        entry: preDrafted = null,
    } = req.body;

    if (channel === 'prod' && !version) {
        return res.status(400).json({ error: 'version is required for channel "prod"' });
    }

    const draft = preDrafted
        ? coerceDraft(preDrafted)
        : await draftReleaseNotes({
            commitSubjects, prTitles, diffstat, services, version,
        });

    const payload = { ...draft, fromSha, toSha, services };
    const entry = channel === 'prod'
        ? await store.finaliseRelease({ ...payload, version })
        : await store.upsertUnreleased({ ...payload, channel });

    invalidatePublicCache();
    res.json({
        success: true,
        entry,
        itemCount: draft.items.length,
        draftedBy: preDrafted ? 'ci' : 'server',
    });
});

/** GET /public — published entries only. */
router.get('/public', async (req, res) => {
    try {
        const now = Date.now();
        if (_cache.data && now - _cache.at < PUBLIC_TTL_MS) {
            return res.json({ entries: _cache.data });
        }
        if (!_cache.data && now - _failedAt < PUBLIC_FAILURE_TTL_MS) {
            return res.status(503).json({ error: 'unavailable' });
        }
        if (!_inFlight) {
            _inFlight = _loadPublished()
                .then((data) => { _cache = { at: Date.now(), data }; return data; })
                .catch((e) => { _failedAt = Date.now(); throw e; })
                .finally(() => { _inFlight = null; });
        }
        const entries = await _inFlight;
        res.json({ entries });
    } catch (err) {
        // A stale cache still beats an empty changelog.
        if (_cache.data) return res.json({ entries: _cache.data });
        log.warn('[ReleaseNotes] public read failed:', err.message);
        res.status(503).json({ error: 'unavailable' });
    }
});

// ── Admin ──────────────────────────────────────────────────────────────

router.get('/admin', requireAdmin, async (req, res) => {
    res.json({ entries: await store.listAll({ limit: 100 }) });
});

router.put('/admin/:id', requireAdmin, validate({ body: EntryPatch }), async (req, res) => {
    const { title, lead, items, version } = req.body;
    const entry = await store.updateEntry(req.params.id, { title, lead, items, version });
    if (!entry) return res.status(404).json({ error: 'Not found' });
    invalidatePublicCache();
    res.json({ success: true, entry });
});

router.post('/admin/:id/publish', requireAdmin, async (req, res) => {
    const entry = await store.publishEntry(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    invalidatePublicCache();
    res.json({ success: true, entry });
});

router.post('/admin/:id/unpublish', requireAdmin, async (req, res) => {
    const entry = await store.unpublishEntry(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not found' });
    invalidatePublicCache();
    res.json({ success: true, entry });
});

router.delete('/admin/:id', requireAdmin, async (req, res) => {
    const ok = await store.deleteEntry(req.params.id);
    invalidatePublicCache();
    res.json({ success: ok });
});

module.exports = router;
module.exports.invalidatePublicCache = invalidatePublicCache;
