/**
 * Knowledge Bases — sources (K1).
 *
 * A source is *where* a KB's documents come from. This router is the whole
 * public surface of the model:
 *
 *   GET    /:id/sources                       — the KB's sources + counters
 *   POST   /:id/sources                       — create one (text | upload | webpage)
 *   POST   /:id/sources/:sid/files            — add files to an upload source (202)
 *   PATCH  /:id/sources/:sid                  — rename / change the refresh rule
 *   DELETE /:id/sources/:sid                  — remove it, its documents and their chunks
 *   POST   /:id/sources/:sid/refresh          — ask for a refresh now
 *   GET    /:id/sources/:sid/documents        — the source's documents (projected)
 *   GET    /:id/sources/:sid/documents/:docId — one document (projected)
 *
 * Mounted BEFORE routes/knowledgeBases/detail.js — order is semantics.
 *
 * Authorization: reads go through `canAccessKB`, writes through
 * `requirePermission('manage_knowledge')` + `canManageKB` + `blockIfSystemKB`.
 * Never the notebook owner-check: a KB is shared, a notebook is not.
 *
 * Two things this file deliberately does NOT do, because they belong to K3
 * (the refresh engine): it never walks a crawl, and it never runs a scheduled
 * refresh. `POST /refresh` only sets `next_refresh_at = now()`.
 */

const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');
const router = express.Router();
const multer = require('multer');

const kbStore = require('../../stores/knowledgeBases');
const kbSourcesStore = require('../../stores/kbSources');
const { requireAuth, requirePermission } = require('../../auth');
const {
    getUserId,
    canAccessKB,
    canManageKB,
    blockIfSystemKB,
    guardedFetch,
} = require('./shared');
const { statusFilter, piiFilter } = require('./docFilters');

// ── Policy ──────────────────────────────────────────────────────────

/** Kinds a client may create today. K7–K10 open the rest. */
const CREATABLE_KINDS = Object.freeze(['text', 'upload', 'webpage', 'meeting_tag', 'datatable']);

/**
 * Which refresh modes make sense per kind. A `legacy` source has nothing to
 * re-read, a meeting tag cannot follow a cron, and neither may be talked into
 * one through PATCH.
 */
const REFRESH_MODES_BY_KIND = Object.freeze({
    upload: ['manual'],
    text: ['manual'],
    webpage: ['manual', 'schedule'],
    nextcloud_folder: ['manual', 'schedule', 'on_change'],
    datatable: ['manual', 'schedule', 'live'],
    meeting_tag: ['manual', 'after_meeting'],
    automation: ['manual'],
    legacy: ['manual'],
});

/** i18n keys for the refresh rule — the client renders them with t(). */
const REFRESH_LABEL_KEYS = Object.freeze({
    manual: 'knowledge.sources.refresh.manual',
    schedule: 'knowledge.sources.refresh.schedule',
    on_change: 'knowledge.sources.refresh.onChange',
    after_meeting: 'knowledge.sources.refresh.afterMeeting',
    live: 'knowledge.sources.refresh.live',
});

const MAX_UPLOAD_FILES = 20;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20 MB per file
const MAX_TEXT_CHARS = 500000;
const MAX_CRAWL_PAGES = 500;
const DEFAULT_DOC_PAGE = 50;
const MAX_DOC_PAGE = 200;
/** Reason parked on a row between "accepted" and "processed". */
const QUEUED_REASON = 'Queued for processing';

/**
 * ── WHERE A TEXT SNIPPET CAME FROM (M4) ─────────────────────────────
 * The transcript tab files one line of a meeting as a `text` source, and the
 * meeting has to be able to find those again afterwards ("2 knowledge lines →
 * <KB>"), so the source carries two facts: which transcription, and which
 * line of it.
 *
 * Built from an EXPLICIT ALLOW-LIST, never by copying `config.metadata`
 * through. This object is written by a client and read back by another
 * screen; a spread would carry whatever a caller invents — including, the day
 * somebody adds one, a field holding a person's name into a knowledge base a
 * whole organisation can query. Same habit BFSF-441 demands of outbound
 * payloads, applied to what comes in.
 *
 * Unknown → NARROWER: anything that is not a usable pair answers `null` and
 * the source is stored without an origin at all. A half-filled origin (a
 * transcription id with no line) would make "this line is already filed" true
 * for every line of that meeting.
 */
function shapeTextOrigin(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const transcriptionId = typeof raw.transcriptionId === 'string' ? raw.transcriptionId.trim().slice(0, 100) : '';
    if (!transcriptionId) return null;
    const out = { transcriptionId };
    // Number(null) === 0 would anchor the snippet to the first line of the
    // meeting, so only a real integer counts.
    if (typeof raw.segmentIndex === 'number' || typeof raw.segmentIndex === 'string') {
        const seg = Number(raw.segmentIndex);
        if (Number.isInteger(seg) && seg >= 0) out.segmentIndex = seg;
    }
    return out;
}

// ── What a caller may send ──────────────────────────────────────────
//
// Every schema is `.strict()`. A config key this router does not read is a
// client bug, and answering 201 to it means the source is created without the
// setting the person typed, with nothing on screen to say so.

const { FIELDS: MEETING_FIELDS, DEFAULT_FIELDS: MEETING_DEFAULT_FIELDS } = require('../../core/kb/sources/meetingTag');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

const NAME_TEXT = 'A source name must be text.';
const SourceName = worded(NAME_TEXT).trim().max(200, 'A source name is at most 200 characters.');

/** Every mode any kind admits; WHICH kind admits which is policy, not shape. */
const REFRESH_MODES = Object.freeze([...new Set(Object.values(REFRESH_MODES_BY_KIND).flat())]);
const MODE_TEXT = `A refresh mode is one of: ${REFRESH_MODES.join(', ')}.`;
const CRON_TEXT = 'A refresh schedule is a cron expression of 5 or 6 fields, like "0 7 * * *".';

const knownTimeZone = (tz) => {
    if (!tz) return true;
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; }
    catch (_) { return false; }
};

/** `null` and `''` both mean "no schedule" — what switching back to manual sends. */
const RefreshRule = z.object({
    mode: z.enum(REFRESH_MODES, { errorMap: () => ({ message: MODE_TEXT }) }).optional(),
    cron: worded(CRON_TEXT).trim().max(200, CRON_TEXT)
        .refine((v) => !v || /^\S+(\s+\S+){4,5}$/.test(v), CRON_TEXT)
        .nullish(),
    tz: worded('A time zone must be text.').trim().max(64, 'A time zone is at most 64 characters.')
        .refine(knownTimeZone, (v) => ({ message: `Unknown time zone: ${v}` }))
        .nullish(),
}, { invalid_type_error: 'A refresh rule is an object like { mode, cron, tz }.' }).strict();

const TEXT_TEXT = 'A text source needs at least three characters of text.';
const URL_TEXT = 'A web source needs an address.';
const TAG_TEXT = 'A meeting source needs a tag.';
const TABLE_TEXT = 'A table source needs a table.';
const CONFIG_TEXT = 'config is an object describing the source.';

/** The `config` each CREATABLE kind accepts; a kind absent here has no shape yet. */
const CONFIG_BY_KIND = Object.freeze({
    text: z.object({
        // Refined rather than trimmed: the snippet is stored and counted as it
        // was typed, so trimming it here would change what got saved.
        text: worded(TEXT_TEXT).refine((v) => v.trim().length >= 3, TEXT_TEXT),
        title: worded('A source title must be text.').trim().max(200).optional(),
        // shapeTextOrigin holds the allow-list, and it is the SAME one applied
        // on the way out, so the two directions cannot drift apart.
        metadata: z.unknown().optional(),
    }, { invalid_type_error: CONFIG_TEXT }).strict(),
    upload: z.object({}, { invalid_type_error: CONFIG_TEXT }).strict(),
    webpage: z.object({
        url: worded(URL_TEXT).trim().min(1, URL_TEXT),
        crawl: z.object({
            // Clamped rather than refused: a client asking for "everything"
            // sends a big number and means it.
            maxPages: z.coerce.number().catch(1)
                .transform((n) => Math.min(Math.max(Math.trunc(n) || 1, 1), MAX_CRAWL_PAGES)),
        }, { invalid_type_error: 'crawl is an object like { maxPages }.' }).strict().nullish(),
    }, { invalid_type_error: CONFIG_TEXT }).strict(),
    meeting_tag: z.object({
        tag: worded(TAG_TEXT).trim().min(1, TAG_TEXT),
        fields: z.array(
            z.enum(MEETING_FIELDS, { errorMap: () => ({ message: `A meeting field is one of: ${MEETING_FIELDS.join(', ')}.` }) }),
            { invalid_type_error: 'fields is a list of meeting fields.' },
        ).optional(),
    }, { invalid_type_error: CONFIG_TEXT }).strict(),
    datatable: z.object({
        datatableId: worded(TABLE_TEXT).trim().min(1, TABLE_TEXT),
        columns: z.array(worded('A column name must be text.'), { invalid_type_error: 'columns is a list of column names.' }).optional(),
        titleColumn: worded('titleColumn must be the name of a column.').trim().min(1, 'titleColumn must be the name of a column.').optional(),
    }, { invalid_type_error: CONFIG_TEXT }).strict(),
});

/**
 * A source's `config` is whatever its KIND says it is, so it is parsed once
 * the kind is known and its issues are reported under `config.<field>`.
 *
 * A kind with no schema is handed on untouched: "that kind is not available
 * yet" is a feature-flag answer carrying the list a client may offer
 * (`kind_not_available`, which the Studio renders), not a malformed request.
 */
function withKindConfig(body, ctx) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_BY_KIND, body.kind)) return body;
    const parsed = CONFIG_BY_KIND[body.kind].safeParse(body.config === undefined ? {} : body.config);
    if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ['config', ...issue.path] });
        return z.NEVER;
    }
    return { ...body, config: parsed.data };
}

const KIND_TEXT = `A source needs a kind — one of: ${CREATABLE_KINDS.join(', ')}.`;
const BODY_TEXT = 'A source is described by an object.';

const CreateSourceBody = z.object({
    kind: worded(KIND_TEXT).trim().min(1, KIND_TEXT),
    name: SourceName.optional(),
    config: z.unknown().optional(),
    refresh: RefreshRule.optional(),
}, { required_error: BODY_TEXT, invalid_type_error: BODY_TEXT }).strict().transform(withKindConfig);

const NAME_BLANK = 'A source name cannot be blank.';
const PatchSourceBody = z.object({
    name: SourceName.min(1, NAME_BLANK).optional(),
    refresh: RefreshRule.optional(),
}, { required_error: BODY_TEXT, invalid_type_error: BODY_TEXT }).strict();

/**
 * Paging is clamped, not refused: a page size out of range is still a page.
 *
 * `status`/`pii` are checked against the store's own vocabulary, not just
 * "is text" — buildDocumentFilters() (stores/knowledgeBases.js) drops any
 * status it does not recognise from its filter list, and with none left it
 * adds no status clause at all. `?status=eror` used to pass a bare-text
 * check and come back with the WHOLE source's documents under a 200, the
 * same failure routes/knowledgeBases/documents.js closed for the KB-wide
 * list. Comma-separated, like the store reads it: every entry must be a
 * real status, because an empty list after filtering is no filter at all.
 */
const DocumentsQuery = z.object({
    limit: z.coerce.number().catch(DEFAULT_DOC_PAGE)
        .transform((n) => Math.min(Math.max(Math.trunc(n) || DEFAULT_DOC_PAGE, 1), MAX_DOC_PAGE))
        .default(DEFAULT_DOC_PAGE),
    offset: z.coerce.number().catch(0)
        .transform((n) => Math.max(Math.trunc(n) || 0, 0))
        .default(0),
    // Shared with routes/knowledgeBases/documents.js — see ./docFilters.
    status: statusFilter().optional(),
    pii: piiFilter().optional(),
    q: worded('The search term must be text.').trim().max(200).optional(),
}).strict();

// ── Upload plumbing ─────────────────────────────────────────────────

const uploadFiles = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_UPLOAD_FILES },
}).any();

/**
 * Multer as middleware with its errors turned into JSON. `.any()` so the
 * client may post `files` (the new multi-file form) or `file` (one file, the
 * shape the old upload modal used) without a second endpoint.
 */
function acceptUploads(req, res, next) {
    uploadFiles(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ error: `Each file must be 20 MB or smaller`, code: 'file_too_large' });
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
            return res.status(400).json({ error: `At most ${MAX_UPLOAD_FILES} files per upload`, code: 'too_many_files' });
        }
        return res.status(400).json({ error: err.message, code: 'upload_failed' });
    });
}

/**
 * In-flight detached upload jobs. The route answers 202 and processes after
 * the response, so tests (and, later, a graceful shutdown) need a way to wait
 * for the work instead of racing it.
 */
const pendingUploads = new Set();

function trackUpload(promise) {
    const job = Promise.resolve(promise).catch((e) => {
        log.error('[KB] Upload processing failed:', e && e.message ? e.message : e);
    });
    pendingUploads.add(job);
    job.then(() => pendingUploads.delete(job), () => pendingUploads.delete(job));
    return job;
}

/** Await every detached upload job. Test/shutdown helper — not a route. */
async function settleUploads() {
    while (pendingUploads.size > 0) {
        await Promise.all(Array.from(pendingUploads));
    }
}

// ── Helpers ─────────────────────────────────────────────────────────

function helpers() {
    return require('../../core/kb/kbIngestionHelpers');
}

/**
 * Load the KB and apply the access policy. Sends the response and returns null
 * when the request must stop.
 * @param {boolean} manage — true for every mutating route
 */
async function resolveKb(req, res, { manage = false } = {}) {
    const kb = await kbStore.getKB(req.params.id);
    if (!kb) {
        res.status(404).json({ error: 'KB not found', code: 'kb_not_found' });
        return null;
    }
    if (manage) {
        if (!(await canManageKB(req, kb))) {
            res.status(403).json({ error: 'Access denied', code: 'forbidden' });
            return null;
        }
        // System-managed KBs are owned by Bee Flow: read-only for everyone,
        // including the super admin canManageKB just let through.
        if (blockIfSystemKB(kb, res)) return null;
        return kb;
    }
    if (!(await canAccessKB(req, kb))) {
        res.status(403).json({ error: 'Access denied', code: 'forbidden' });
        return null;
    }
    return kb;
}

/** Load a source and prove it belongs to this KB (never trust the URL pair). */
async function resolveSource(kb, req, res) {
    const source = await kbSourcesStore.get(req.params.sid);
    if (!source || String(source.knowledgeBaseId) !== String(kb.id)) {
        res.status(404).json({ error: 'Source not found', code: 'source_not_found' });
        return null;
    }
    return source;
}

/**
 * The part of a source's config a client may see, per kind — an explicit
 * allow-list, never "the row minus a few keys": a column added next year would
 * otherwise start leaking on its own. The pasted text itself never leaves;
 * only its size does.
 */
function publicSourceConfig(kind, config) {
    const c = config && typeof config === 'object' ? config : {};
    switch (kind) {
        case 'text': {
            // The origin M4 files alongside a transcript line, shaped by the
            // SAME allow-list on the way out as on the way in, so the two
            // directions cannot drift apart. The pasted text itself still
            // never leaves; only its size, and where it came from.
            const metadata = shapeTextOrigin(c.metadata);
            return {
                title: c.title || null,
                charCount: Number(c.charCount || 0),
                ...(metadata ? { metadata } : {}),
            };
        }
        case 'upload':
            return {};
        case 'webpage':
            return {
                url: c.url || null,
                crawl: c.crawl && typeof c.crawl === 'object' ? { maxPages: Number(c.crawl.maxPages || 1) } : null,
            };
        case 'nextcloud_folder':
            return { path: c.path || null, folderName: c.folderName || null };
        case 'datatable':
            return { tableId: c.tableId || null, tableName: c.tableName || null };
        case 'meeting_tag':
            return { tag: c.tag || null, mode: c.mode || null };
        case 'automation':
            return { automationId: c.automationId || null, provider: c.provider || null, workflowId: c.workflowId || null };
        case 'legacy':
            return { sourceType: c.sourceType || null };
        default:
            return {};
    }
}

const ZERO_COUNTS = Object.freeze({
    documentCount: 0, processedCount: 0, redactedCount: 0, skippedCount: 0,
    errorCount: 0, duplicateCount: 0, piiFoundCount: 0, totalChunks: 0,
});

/** Resolve `created_by` ids to `{ id, name }` — best-effort, never fatal. */
async function resolveCreators(ids) {
    const out = {};
    const unique = Array.from(new Set((ids || []).filter(Boolean)));
    if (unique.length === 0) return out;
    let userStore = null;
    try { userStore = require('../../stores/userStore'); } catch (_) { return out; }
    for (const id of unique) {
        try {
            const u = await userStore.getUser(id);
            out[id] = { id, name: u ? (u.name || u.email || null) : null };
        } catch (_) {
            out[id] = { id, name: null };
        }
    }
    return out;
}

/** camelCase + Number() wire shape, like routes/knowledgeBases/system.js. */
function mapSourceForApi(source, counts, creators) {
    const c = counts || ZERO_COUNTS;
    return {
        id: source.id,
        kind: source.kind,
        name: source.name || '',
        config: publicSourceConfig(source.kind, source.config),
        refreshMode: source.refreshMode || 'manual',
        // An i18n KEY, not a sentence: the client renders it with t(key, fallback).
        refreshLabelKey: REFRESH_LABEL_KEYS[source.refreshMode] || REFRESH_LABEL_KEYS.manual,
        refreshCron: source.refreshCron || null,
        refreshTz: source.refreshTz || null,
        // The modes THIS kind actually has. Sent rather than hard-coded in
        // the client, so the schedule menu cannot offer something the PATCH
        // would 400 — a page has no "live", a table has no "after every
        // meeting", and a rejected choice teaches that the product is broken.
        supportsModes: REFRESH_MODES_BY_KIND[source.kind] || ['manual'],
        nextRefreshAt: source.nextRefreshAt || null,
        lastRefreshAt: source.lastRefreshAt || null,
        status: source.status || 'idle',
        error: source.lastRefreshError || null,
        consecutiveErrors: Number(source.consecutiveErrors || 0),
        documentCount: Number(c.documentCount || 0),
        processedCount: Number(c.processedCount || 0),
        redactedCount: Number(c.redactedCount || 0),
        skippedCount: Number(c.skippedCount || 0),
        errorCount: Number(c.errorCount || 0),
        duplicateCount: Number(c.duplicateCount || 0),
        piiFoundCount: Number(c.piiFoundCount || 0),
        totalChunks: Number(c.totalChunks || 0),
        createdBy: (creators && creators[source.createdBy]) || (source.createdBy ? { id: source.createdBy, name: null } : null),
        createdAt: source.createdAt || null,
        updatedAt: source.updatedAt || null,
    };
}

/**
 * The per-install cap on sources. Read from the licence tier; a failure to
 * resolve falls back to the COMMUNITY limit rather than to "unlimited", so a
 * transient licence-store error can never widen an entitlement.
 * @returns {Promise<number>} -1 (or any negative) = uncapped
 */
async function maxSourcesFor(kb, userId) {
    const license = require('../../license');
    try {
        const tier = await license.resolveTier({ organizationId: kb.organization_id || null, userId: userId || null });
        const limits = license.tiers.getLimitsForTier(tier) || {};
        const max = Number(limits.max_kb_sources);
        return Number.isFinite(max) ? max : -1;
    } catch (e) {
        log.warn('[KB] Source limit unresolved, applying the community cap:', e.message);
        try {
            const max = Number((license.tiers.getLimitsForTier('community') || {}).max_kb_sources);
            return Number.isFinite(max) ? max : -1;
        } catch (_) {
            return -1;
        }
    }
}

function parseDocFilters(req, sourceId) {
    return {
        sourceId,
        status: req.query.status || undefined,
        pii: req.query.pii || undefined,
        q: req.query.q || undefined,
    };
}

/**
 * A validated `{mode, cron, tz}` → a store patch.
 *
 * The SHAPE is RefreshRule's answer. What is left here is the one rule a body
 * schema cannot state: which modes a KIND admits — and on PATCH that is the
 * kind of the STORED row, which the body never carries.
 */
function refreshPatchFor(refresh, kind) {
    if (!refresh) return {};
    const patch = {};
    if (refresh.mode !== undefined) {
        const allowed = Object.prototype.hasOwnProperty.call(REFRESH_MODES_BY_KIND, kind)
            ? REFRESH_MODES_BY_KIND[kind]
            : ['manual'];
        if (!allowed.includes(refresh.mode)) {
            throw new HttpError(400, 'refresh_mode_not_available',
                `Refresh mode '${refresh.mode}' is not available for a ${kind} source`);
        }
        patch.refreshMode = refresh.mode;
    }
    if (refresh.cron !== undefined) patch.refreshCron = refresh.cron || null;
    if (refresh.tz !== undefined) patch.refreshTz = refresh.tz || null;
    return patch;
}

// ── Web page fetching ───────────────────────────────────────────────

/**
 * Fetch a page for a webpage source.
 *
 * guardedFetch first — that is the layer that screens the host AND every
 * address it resolves to, honours the operator's KB_ALLOW_PRIVATE_HOSTS
 * escape hatch and re-screens the redirect target. Only when that yields too
 * little text do we fall back to the headless browser path in
 * fetchUrlContent (which runs its own screening again), so a JS-rendered page
 * still works without giving up the guard on the normal path.
 */
async function fetchPageForSource(url) {
    const { htmlToMarkdown } = require('../../utils/htmlToMarkdown');
    let content = '';
    let title = '';
    let resolvedUrl = url;
    try {
        const response = await guardedFetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BeeFlow/1.0)' },
            redirect: 'follow',
            signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status}`);
        resolvedUrl = response.url || url;
        const body = await response.text();
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('text/html')) {
            const md = htmlToMarkdown(body, resolvedUrl, { includeLinks: true, includeImages: false });
            content = md.markdown || '';
            title = md.title || '';
            if (title && !content.startsWith(`# ${title}`)) content = `# ${title}\n\n${content}`;
        } else if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
            content = body;
        } else {
            throw new Error(`Unsupported content type: ${contentType}`);
        }
    } catch (e) {
        // Keep the reason: if the fallback also fails, this is the message worth showing.
        content = '';
        if (/private\/loopback|metadata endpoint|Only HTTP|Invalid URL/i.test(e.message)) throw e;
    }

    if (!content || content.trim().length < 20) {
        const r = await helpers().fetchUrlContent(url);
        content = r.content;
        title = r.title || title;
        resolvedUrl = r.resolvedUrl || resolvedUrl;
    }

    let hostname = url;
    try { hostname = new URL(resolvedUrl).hostname; } catch (_) { /* keep the raw url */ }
    return { content, title: title || hostname, resolvedUrl };
}

// ── GET /:id/sources ────────────────────────────────────────────────

router.get('/:id/sources', requireAuth, async (req, res) => {
    const kb = await resolveKb(req, res);
    if (!kb) return;

    const sources = await kbSourcesStore.listByKb(kb.id);
    const counts = sources.length > 0
        ? await kbStore.countsBySource(sources.map(s => s.id))
        : {};
    const creators = await resolveCreators(sources.map(s => s.createdBy));
    const items = sources.map(s => mapSourceForApi(s, counts[s.id], creators));

    const totals = items.reduce((acc, s) => ({
        sourceCount: acc.sourceCount + 1,
        autoRefreshCount: acc.autoRefreshCount + (s.refreshMode !== 'manual' ? 1 : 0),
        errorSourceCount: acc.errorSourceCount + (s.status === 'error' ? 1 : 0),
        documentCount: acc.documentCount + s.documentCount,
        processedCount: acc.processedCount + s.processedCount,
        redactedCount: acc.redactedCount + s.redactedCount,
        skippedCount: acc.skippedCount + s.skippedCount,
        errorCount: acc.errorCount + s.errorCount,
        duplicateCount: acc.duplicateCount + s.duplicateCount,
        piiFoundCount: acc.piiFoundCount + s.piiFoundCount,
        totalChunks: acc.totalChunks + s.totalChunks,
    }), {
        sourceCount: 0, autoRefreshCount: 0, errorSourceCount: 0, documentCount: 0,
        processedCount: 0, redactedCount: 0, skippedCount: 0, errorCount: 0,
        duplicateCount: 0, piiFoundCount: 0, totalChunks: 0,
    });

    res.json({ sources: items, totals });
});

// ── POST /:id/sources ───────────────────────────────────────────────

router.post('/:id/sources', requireAuth, requirePermission('manage_knowledge'), validate({ body: CreateSourceBody }), async (req, res, next) => {
    try {
        const kb = await resolveKb(req, res, { manage: true });
        if (!kb) return;

        const { kind, name, config, refresh } = req.body;
        if (!CREATABLE_KINDS.includes(kind)) {
            const known = kbSourcesStore.SOURCE_KINDS.includes(kind);
            return res.status(400).json({
                error: known
                    ? `Sources of kind '${kind}' cannot be created yet`
                    : `Unknown source kind '${kind}'`,
                code: 'kind_not_available',
                availableKinds: CREATABLE_KINDS,
            });
        }

        // Entitlement — checked against the live count, never a stored number.
        const max = await maxSourcesFor(kb, getUserId(req));
        if (max >= 0) {
            const current = (await kbSourcesStore.listByKb(kb.id)).length;
            if (current >= max) {
                return res.status(403).json({
                    error: `This plan allows ${max} knowledge sources per knowledge base.`,
                    code: 'source_limit_reached',
                    limit: max,
                });
            }
        }

        const cfg = config;
        const refreshPatch = refreshPatchFor(refresh, kind);

        const userId = getUserId(req);
        const { ingestDocument } = helpers();

        // ── text: the source and its one document are created together ──
        if (kind === 'text') {
            const text = cfg.text;
            if (text.length > MAX_TEXT_CHARS) {
                return res.status(400).json({ error: `Text may be at most ${MAX_TEXT_CHARS} characters`, code: 'text_too_long' });
            }
            const title = String(name || cfg.title || 'Text snippet').slice(0, 200);
            const origin = shapeTextOrigin(cfg.metadata);

            /**
             * ── HET ID IS EEN BEWERING OVER EEN VERGADERING (M4) ──────
             *
             * `metadata.transcriptionId` laat deze regel LANDEN op de tijdlijn
             * van die vergadering: de balk onder de tagrij, het
             * Gebruikt-door-tabblad en "Uit dit transcript gehaald" lezen hem
             * alle drie terug, en de verwijderpoort van de notitie telt hem mee
             * (core/meetingNotes/meetingUsage.js `scanKb`).
             *
             * `manage: true` hierboven gaat over de KENNISBANK, en op je eigen
             * kennisbank ben je altijd beheerder (stores/knowledgeBases.js
             * `canUserManageKB`). Zonder de controle hieronder kon dus iedereen
             * een id VERZINNEN en een onware, niet te weerleggen en niet te
             * verwijderen regel op de vergadering van een ander plakken.
             *
             * Dezelfde bewaking als de `meeting_tag`-tak verderop, en om
             * dezelfde reden: hij draait als de MAKER (`askerContext`, niet de
             * eigenaar van de kennisbank), en onbekend VERSMALT. Een
             * vergadering die de schrijver niet mag zien geeft exact hetzelfde
             * antwoord als een vergadering die niet bestaat — anders is deze
             * route een orakel voor welke vergadering-ids bestaan.
             *
             * De controle staat hier, in de schrijfpoort zelf, vóór de
             * `create` — niet in `shapeTextOrigin`, want dat is een vormfilter
             * dat een volgende aanroeper kan hergebruiken zonder de vraag te
             * stellen, en niet in de UI, want die zit niet op dit pad.
             */
            if (origin) {
                // Eén poort, gedeeld met het duplicaat-pad — zie
                // core/kb/transcriptOrigin.js voor de context waarmee hij
                // draait en waarom `isSuperAdmin` er bewust niet in zit.
                const { checkTranscriptOriginVisible } = require('../../core/kb/transcriptOrigin');
                const verdict = await checkTranscriptOriginVisible(origin.transcriptionId, userId);
                if (!verdict.ok) {
                    // Niet kunnen kijken is geen toestemming. Niets landt.
                    return res.status(verdict.status).json({ error: verdict.error, code: verdict.code });
                }
            }

            const source = await kbSourcesStore.create({
                knowledgeBaseId: kb.id, kind: 'text', name: title,
                config: { title, charCount: text.length, ...(origin ? { metadata: origin } : {}) },
                createdBy: userId,
                ...refreshPatch,
            });
            const result = await ingestDocument(
                kb.tenant_id, kb.id, text, title, 'text', null,
                { sourceId: source.id, createdBy: userId, onFailure: 'record' },
            );
            const counts = await kbStore.countsBySource([source.id]);
            return res.status(201).json({
                source: mapSourceForApi(source, counts[source.id], await resolveCreators([source.createdBy])),
                document: result.document || null,
                chunks: result.chunks || 0,
                status: result.status,
            });
        }

        /**
         * ── meeting_tag: every meeting carrying a tag ─────────────────
         *
         * This source WIDENS who can read a meeting summary. A note has its
         * own audience — its owner, whoever it was shared with, maybe an
         * organisation or a group. Putting it in a knowledge base moves it
         * into THAT thing's audience, which may be larger.
         *
         * Two things hold the line, and neither is in the UI:
         *
         *   • `manage: true` above, so only somebody who may manage this
         *     knowledge base can point it at meetings at all.
         *   • The adapter enumerates as the KB's OWNER through the store's own
         *     read ACL, so the source can only ever contain meetings its owner
         *     could already open. It cannot become a way to read past a note's
         *     own sharing.
         *
         * And the creator has to be able to see the tag themselves. Without
         * that check, somebody with manage_knowledge on a knowledge base could
         * point it at a tag they have never been able to read, and have the
         * OWNER's reach fill it in for them. The tag would still be filtered
         * by the owner's ACL — but the choice of which meetings to expose
         * would have been made by somebody who could not see them.
         */
        if (kind === 'meeting_tag') {
            const tag = cfg.tag;
            const fields = cfg.fields || [];

            // `core/kb/askerContext`, not the transcriptions routes' own
            // resolver: this is a probe, and that one hands a super admin an
            // empty org list with an `isSuperAdmin` flag the store then reads
            // as "everything". Narrowing on failure is the right direction for
            // an access check.
            const { askerContext } = require('../../core/kb/askerContext');
            const asker = await askerContext(userId);
            let visible = [];
            try {
                visible = await require('../../stores/transcriptionStore')
                    .listByTag(tag, userId, { orgIds: [...asker.orgIds], userGroupIds: asker.userGroups, limit: 1 });
            } catch (e) {
                log.warn('[KB] meeting tag probe failed:', e.message);
                return res.status(502).json({ error: 'Could not check that tag right now.', code: 'tag_probe_failed' });
            }
            if (visible.length === 0) {
                // Deliberately the same answer for "no such tag" and "not
                // yours to see": distinguishing them would let somebody probe
                // for which tags exist in the organisation.
                return res.status(400).json({
                    error: 'No meetings you can open carry that tag.',
                    code: 'tag_not_visible',
                });
            }

            const source = await kbSourcesStore.create({
                knowledgeBaseId: kb.id, kind: 'meeting_tag',
                name: String(name || `Meetings tagged “${tag}”`).slice(0, 200),
                config: { tag, fields: fields.length ? fields : [...MEETING_DEFAULT_FIELDS] },
                createdBy: userId,
                ...refreshPatch,
            });
            return res.status(201).json({
                source: mapSourceForApi(source, null, await resolveCreators([source.createdBy])),
            });
        }

        /**
         * ── datatable: a table, live ──────────────────────────────────
         *
         * Same shape of risk as `meeting_tag`, and the same three defences:
         * `manage: true` above; the adapter reads as the KB's OWNER through
         * the table's own row-level access filter; and the creator must be
         * able to read the table themselves, resolved here as THEM.
         *
         * That last one is not redundant. Without it, somebody with
         * manage_knowledge could point a base at a table they have never been
         * able to open and have the owner's grade fill it in — the rows would
         * still be filtered by the owner's access, but the choice of which
         * table to expose would have been made by somebody who cannot see it.
         */
        if (kind === 'datatable') {
            const datatableId = cfg.datatableId;

            const { askerContext } = require('../../core/kb/askerContext');
            const asker = await askerContext(userId);
            let resolved;
            try {
                const { resolveDatatableForStep } = require('../../core/automationRunner/datatableResolve');
                resolved = await resolveDatatableForStep(datatableId, {
                    userId,
                    orgId: [...asker.orgIds][0] || null,
                    userGroupIds: asker.userGroups,
                }, { needed: 'viewer' });
            } catch (e) {
                // The same answer whether the table does not exist or is not
                // theirs: telling them apart would let somebody probe for the
                // ids of tables in the organisation.
                return res.status(400).json({
                    error: 'That table is not available to you.',
                    code: 'datatable_not_available',
                });
            }

            const { pickColumns } = require('../../core/kb/sources/datatable');
            const columns = pickColumns({ columns: cfg.columns }, resolved.tableMeta);
            // A column the table does not have is no title at all — the name
            // is only meaningful against the live table, so the check is here.
            const titleColumn = columns.includes(cfg.titleColumn) ? cfg.titleColumn : null;

            const source = await kbSourcesStore.create({
                knowledgeBaseId: kb.id, kind: 'datatable',
                name: String(name || resolved.table?.name || 'Table').slice(0, 200),
                config: {
                    datatableId,
                    tableName: resolved.table?.name || null,
                    columns,
                    ...(titleColumn ? { titleColumn } : {}),
                },
                createdBy: userId,
                ...refreshPatch,
            });
            // So the table's own "Used by" names this knowledge base, and
            // deleting the table asks first. Best-effort by design.
            await require('../../core/kb/sources/datatable')
                .reconcileUsage(kb.id, resolved.scope);
            return res.status(201).json({
                source: mapSourceForApi(source, null, await resolveCreators([source.createdBy])),
            });
        }

        // ── upload: an empty bucket; files arrive on the next route ──
        if (kind === 'upload') {
            const source = await kbSourcesStore.create({
                knowledgeBaseId: kb.id, kind: 'upload',
                name: String(name || 'Uploaded files').slice(0, 200),
                config: {}, createdBy: userId, ...refreshPatch,
            });
            return res.status(201).json({
                source: mapSourceForApi(source, null, await resolveCreators([source.createdBy])),
            });
        }

        // ── webpage: screened fetch, then one document for the entry page ──
        const url = cfg.url;
        const crawl = cfg.crawl || null;

        let page;
        try {
            page = await fetchPageForSource(url);
        } catch (e) {
            if (/Invalid URL|Only HTTP|private\/loopback|metadata endpoint/i.test(e.message)) {
                return res.status(400).json({ error: e.message, code: 'url_rejected' });
            }
            return next(new HttpError(502, 'fetch_failed', e.message));
        }

        const source = await kbSourcesStore.create({
            knowledgeBaseId: kb.id, kind: 'webpage',
            name: String(name || page.title || url).slice(0, 200),
            config: { url: page.resolvedUrl || url, ...(crawl ? { crawl } : {}) },
            createdBy: userId,
            ...refreshPatch,
        });
        const result = await ingestDocument(
            kb.tenant_id, kb.id, page.content, page.title, 'web', page.resolvedUrl,
            {
                sourceId: source.id, externalId: page.resolvedUrl, createdBy: userId,
                mime: 'text/html', onFailure: 'record',
            },
        );
        const counts = await kbStore.countsBySource([source.id]);
        return res.status(201).json({
            source: mapSourceForApi(source, counts[source.id], await resolveCreators([source.createdBy])),
            document: result.document || null,
            chunks: result.chunks || 0,
            status: result.status,
            // A crawl is stored, not walked: K3's refresh engine follows it.
            crawlPending: !!crawl,
        });
    } catch (e) {
        if (e instanceof HttpError) return next(e);
        if (e.code === 'invalid_kind' || e.code === 'invalid_refresh_mode' || e.code === 'kb_required') {
            return res.status(400).json({ error: e.message, code: e.code });
        }
        log.error('[KB] Create source error:', e.message);
        next(e);
    }
});

// ── POST /:id/sources/:sid/files ────────────────────────────────────

/**
 * Turn one accepted upload into a processed document.
 *
 * The row already exists (created by the route so the 202 can hand back real
 * document ids); this fills it in under the SAME id — which is also what
 * "process again" will do later.
 */
async function processUploadedFile(kb, source, doc, file) {
    const { extractFileContentWithMeta, reingestDocument, friendlyError } = helpers();
    let text = '';
    let meta = {};
    try {
        const extracted = await extractFileContentWithMeta(file.buffer, file.mimetype, file.originalname);
        text = extracted.text || '';
        meta = extracted.meta || {};
    } catch (e) {
        log.warn(`[KB] Extraction failed for "${file.originalname}": ${e.message}`);
        await kbStore.updateDocumentStatus(doc.id, {
            status: 'error', statusReason: friendlyError(e), chunkCount: 0,
        }).catch(() => {});
        return;
    }

    // Dedup, in the same scope ingestDocument would apply: an identical file
    // already in THIS source is an alias, not a second embedding. (Rows in
    // another source stay separate — K4 annotates those as overlaps.)
    if (text && text.trim().length >= 3) {
        try {
            const existing = await kbStore.findDocumentByContentHash(kb.id, kbStore.hashContent(text));
            if (existing && String(existing.id) !== String(doc.id)
                && (!existing.source_id || String(existing.source_id) === String(source.id))) {
                await kbStore.updateDocumentStatus(doc.id, {
                    status: 'duplicate',
                    statusReason: 'Identical content already in this knowledge base',
                    chunkCount: 0,
                });
                return;
            }
        } catch (e) {
            log.warn('[KB] Duplicate probe failed, ingesting anyway:', e.message);
        }
    }

    await reingestDocument(kb.tenant_id, kb.id, doc.id, text, {
        title: file.originalname,
        sizeBytes: file.size != null ? file.size : (file.buffer ? file.buffer.length : null),
        mime: file.mimetype || null,
        pageCount: Number.isFinite(meta.pageCount) ? meta.pageCount : null,
        sheetCount: Array.isArray(meta.sheetNames) ? meta.sheetNames.length : null,
        // The pages themselves, so each chunk can carry the page it starts on
        // and a citation reads "Handboek · p. 12" rather than "Handboek".
        pages: Array.isArray(meta.pages) ? meta.pages : null,
        externalId: file.originalname,
        onFailure: 'record',
    });
}

router.post('/:id/sources/:sid/files', requireAuth, requirePermission('manage_knowledge'), acceptUploads, async (req, res, next) => {
    try {
        const kb = await resolveKb(req, res, { manage: true });
        if (!kb) return;
        const source = await resolveSource(kb, req, res);
        if (!source) return;
        if (source.kind !== 'upload') {
            return res.status(400).json({ error: 'Files can only be added to an upload source', code: 'not_an_upload_source' });
        }

        const files = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []);
        if (files.length === 0) return res.status(400).json({ error: 'No files uploaded', code: 'no_files' });

        const userId = getUserId(req);
        const accepted = [];
        for (const file of files) {
            // The row is created up front — parked as 'skipped' with a reason,
            // because 'processing' is not a documents.status value and inventing
            // one would mean a schema change on a rolling deploy. A crash between
            // accept and finish therefore leaves a visible "not processed yet"
            // row the user can retry, never a silently missing file.
            const doc = await kbStore.createDocument(
                kb.tenant_id, kb.id, file.originalname, 'upload', file.originalname,
                null, 0, null, null,
                {
                    sourceId: source.id, externalId: file.originalname, createdBy: userId,
                    sizeBytes: file.size != null ? file.size : (file.buffer ? file.buffer.length : null),
                    mime: file.mimetype || null,
                    status: 'skipped', statusReason: QUEUED_REASON,
                },
            );
            accepted.push({ doc, file });
        }

        // Answer first, process after: a 40 MB PDF batch must not hold the
        // request open. K3 replaces this with the refresh job.
        res.status(202).json({
            accepted: accepted.length,
            documents: accepted.map(({ doc, file }) => ({
                id: doc.id,
                name: file.originalname,
                status: 'processing',
            })),
        });

        trackUpload((async () => {
            for (const { doc, file } of accepted) {
                try {
                    await processUploadedFile(kb, source, doc, file);
                } catch (e) {
                    log.error(`[KB] Upload "${file.originalname}" failed:`, e.message);
                    await kbStore.updateDocumentStatus(doc.id, {
                        status: 'error', statusReason: helpers().friendlyError(e), chunkCount: 0,
                    }).catch(() => {});
                }
            }
        })());
    } catch (e) {
        log.error('[KB] Source upload error:', e.message);
        if (!res.headersSent) next(e);
    }
});

// ── PATCH /:id/sources/:sid ─────────────────────────────────────────

router.patch('/:id/sources/:sid', requireAuth, requirePermission('manage_knowledge'), validate({ body: PatchSourceBody }), async (req, res, next) => {
    try {
        const kb = await resolveKb(req, res, { manage: true });
        if (!kb) return;
        const source = await resolveSource(kb, req, res);
        if (!source) return;

        const { name, refresh } = req.body;
        const patch = refreshPatchFor(refresh, source.kind);
        if (name !== undefined) patch.name = name;
        // Switching back to manual clears the schedule so no stale cron fires.
        if (patch.refreshMode === 'manual') {
            if (patch.refreshCron === undefined) patch.refreshCron = null;
            patch.nextRefreshAt = null;
        }

        /**
         * Switching TO a schedule (or editing one) has to arm it.
         *
         * `next_refresh_at` is the ONLY thing `claimDue` looks at, so a
         * source saved with a perfectly good cron and a null next-run is a
         * source that silently never refreshes — and the UI would show its
         * schedule the whole time, which is worse than showing nothing. The
         * timestamp is computed from the row as it will be AFTER this patch,
         * not as it is now, or editing the cron of an already-scheduled
         * source would arm the old one.
         *
         * `live` is deliberately excluded: it is answered from its upstream
         * at query time (K8) and a due timestamp would put it in the tick's
         * way forever.
         */
        const nextMode = patch.refreshMode ?? source.refreshMode;
        if (nextMode !== 'manual' && nextMode !== 'live' && patch.nextRefreshAt === undefined) {
            const scheduleTouched = patch.refreshMode !== undefined
                || patch.refreshCron !== undefined
                || patch.refreshTz !== undefined;
            if (scheduleTouched) {
                const { nextRefreshFor } = require('../../core/kb/sources');
                patch.nextRefreshAt = nextRefreshFor({
                    refreshMode: nextMode,
                    refreshCron: patch.refreshCron !== undefined ? patch.refreshCron : source.refreshCron,
                    refreshTz: patch.refreshTz !== undefined ? patch.refreshTz : source.refreshTz,
                });
            }
        }

        const updated = await kbSourcesStore.update(source.id, patch);
        const counts = await kbStore.countsBySource([source.id]);
        res.json({ source: mapSourceForApi(updated, counts[source.id], await resolveCreators([updated.createdBy])) });
    } catch (e) {
        if (e instanceof HttpError) return next(e);
        if (e.code === 'invalid_refresh_mode' || e.code === 'invalid_status') {
            return res.status(400).json({ error: e.message, code: e.code });
        }
        log.error('[KB] Update source error:', e.message);
        next(e);
    }
});

// ── DELETE /:id/sources/:sid ────────────────────────────────────────

router.delete('/:id/sources/:sid', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    const kb = await resolveKb(req, res, { manage: true });
    if (!kb) return;
    const source = await resolveSource(kb, req, res);
    if (!source) return;

    // Chunks first. The FK cascades the documents rows when the source
    // goes, which would leave their embeddings searchable forever — in a
    // privacy product, deleted text that keeps answering questions is the
    // bug. The rounds loop that makes that true past the first page of 200
    // lives in core/kb/purgeSourceDocuments.js, shared with the meeting
    // notes unfile path (DELETE /api/transcriptions/:id/filed-lines) so the
    // two cannot drift apart again.
    const { purgeSourceDocuments } = require('../../core/kb/purgeSourceDocuments');
    const { deleted, errors, complete } = await purgeSourceDocuments({
        kbStore, deleteDocumentChunks: helpers().deleteDocumentChunks,
        kbId: kb.id, sourceId: source.id, tenantId: kb.tenant_id,
    });

    // DE BRON VALT PAS ALS DE OPRUIMING KLAAR IS. Deze route haalde de
    // bronrij ONVOORWAARDELIJK weg en meldde de mislukkingen erbij in
    // `errors` — met `success: true` erboven. Dat is fail-open op precies
    // het punt waar het pijn doet: de FK cascadeert dan juist de
    // documentrijen weg waar `deleteDocumentChunks` NIET langs is geweest,
    // en hun embeddings blijven doorzoekbaar zonder rij om ze aan te
    // wijzen. De prijs van de andere kant (een bron die blijft staan) is
    // een knop die je nog een keer indrukt; deze kant is onherstelbaar.
    // 409 en niet 500: er is niets stukgegaan aan onze kant, de toestand
    // laat het (nu) niet toe. Wat er wél af is staat in `deletedDocuments`.
    if (!complete) {
        log.warn('[KB] source kept, documents remain:', source.id, errors[0]?.error || 'documents remained after cleanup');
        return res.status(409).json({
            error: 'Some documents could not be removed, so the source was kept',
            code: 'purge_incomplete',
            deletedDocuments: deleted,
            errors,
        });
    }

    await kbSourcesStore.remove(source.id);

    // The datatable's "Used by" must stop naming this knowledge base, or
    // deleting the table would go on asking about a source that is gone.
    // Reconciled for the WHOLE knowledge base — `reconcileUsageFor` is
    // delete-then-insert per consumer, so handing it only what is left is
    // exactly right, and handing it one source would erase its siblings.
    if (source.kind === 'datatable') {
        try {
            const { resolveDatatableForStep } = require('../../core/automationRunner/datatableResolve');
            const { askerContext } = require('../../core/kb/askerContext');
            const asker = await askerContext(getUserId(req));
            const resolved = await resolveDatatableForStep(source.config?.datatableId, {
                userId: getUserId(req),
                orgId: [...asker.orgIds][0] || null,
                userGroupIds: asker.userGroups,
            }, { needed: 'viewer' });
            await require('../../core/kb/sources/datatable').reconcileUsage(kb.id, resolved.scope);
        } catch (e) {
            // The table may have been deleted first, which took its usage
            // rows with it. Nothing to reconcile, and nothing to report.
            log.warn('[KB] datatable usage not reconciled after source delete:', e.message);
        }
    }

    res.json({ success: true, deletedDocuments: deleted, errors });
});

// ── POST /:id/sources/:sid/refresh ──────────────────────────────────

router.post('/:id/sources/:sid/refresh', requireAuth, requirePermission('manage_knowledge'), async (req, res) => {
    const kb = await resolveKb(req, res, { manage: true });
    if (!kb) return;
    const source = await resolveSource(kb, req, res);
    if (!source) return;

    const updated = await kbSourcesStore.requestRefresh(source.id);
    res.status(202).json({
        queued: true,
        source: mapSourceForApi(updated || source, null, await resolveCreators([source.createdBy])),
    });
});

// ── GET /:id/sources/:sid/documents ─────────────────────────────────

router.get('/:id/sources/:sid/documents', requireAuth, validate({ query: DocumentsQuery }), async (req, res) => {
    const kb = await resolveKb(req, res);
    if (!kb) return;
    const source = await resolveSource(kb, req, res);
    if (!source) return;

    const { limit, offset } = req.query;
    const filters = parseDocFilters(req, source.id);

    // listDocuments/countDocuments read the projection — original_content
    // is not in DOCUMENT_COLUMNS and never reaches this response.
    const [documents, total] = await Promise.all([
        kbStore.listDocuments(kb.id, { limit, offset, filters }),
        kbStore.countDocuments(kb.id, filters),
    ]);
    res.json({ documents, total, limit, offset });
});

// ── GET /:id/sources/:sid/documents/:docId ──────────────────────────

router.get('/:id/sources/:sid/documents/:docId', requireAuth, async (req, res) => {
    const kb = await resolveKb(req, res);
    if (!kb) return;
    const source = await resolveSource(kb, req, res);
    if (!source) return;

    const doc = await kbStore.getDocument(req.params.docId);
    if (!doc || String(doc.knowledge_base_id) !== String(kb.id) || String(doc.source_id || '') !== String(source.id)) {
        return res.status(404).json({ error: 'Document not found', code: 'document_not_found' });
    }
    res.json({ document: doc });
});

module.exports = router;
module.exports.CREATABLE_KINDS = CREATABLE_KINDS;
module.exports.REFRESH_MODES_BY_KIND = REFRESH_MODES_BY_KIND;
module.exports.REFRESH_LABEL_KEYS = REFRESH_LABEL_KEYS;
module.exports.publicSourceConfig = publicSourceConfig;
module.exports.settleUploads = settleUploads;
