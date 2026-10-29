// @typecheck noImplicitAny
/**
 * Knowledge Bases — sources (K1): the policy and the shared helpers of the
 * sources router. Which kinds may be created and which refresh modes each
 * admits, the origin allow-list of a text snippet, what a client may see of
 * a source, the per-plan source cap, and the KB/source lookups with their
 * access checks. Split out of sources.js; behaviour unchanged.
 */

const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const kbStore = require('../../stores/knowledgeBases');
const kbSourcesStore = require('../../stores/kbSources');
const { canAccessKB, canManageKB, blockIfSystemKB } = require('./shared');

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

/** @typedef {NonNullable<Awaited<ReturnType<typeof kbSourcesStore.get>>>} KbSourceApiRow */
/** @typedef {Awaited<ReturnType<typeof kbStore.countsBySource>>[string]} SourceCounts */

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
 * @param {unknown} raw
 */
function shapeTextOrigin(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const transcriptionId = typeof /** @type {{ transcriptionId?: unknown }} */ (raw).transcriptionId === 'string' ? /** @type {{ transcriptionId: string }} */ (raw).transcriptionId.trim().slice(0, 100) : '';
    if (!transcriptionId) return null;
    /** @type {{ transcriptionId: string, segmentIndex?: number }} */
    const out = { transcriptionId };
    // Number(null) === 0 would anchor the snippet to the first line of the
    // meeting, so only a real integer counts.
    if (typeof /** @type {{ segmentIndex?: unknown }} */ (raw).segmentIndex === 'number' || typeof /** @type {{ segmentIndex?: unknown }} */ (raw).segmentIndex === 'string') {
        const seg = Number(/** @type {{ segmentIndex: number | string }} */ (raw).segmentIndex);
        if (Number.isInteger(seg) && seg >= 0) out.segmentIndex = seg;
    }
    return out;
}

function helpers() {
    return require('../../core/kb/kbIngestionHelpers');
}

/**
 * Load the KB and apply the access policy. Sends the response and returns null
 * when the request must stop.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ manage?: boolean }} [opts]  `manage`: true for every mutating route
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

/**
 * Load a source and prove it belongs to this KB (never trust the URL pair).
 * @param {Record<string, any>} kb
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
async function resolveSource(kb, req, res) {
    const source = await kbSourcesStore.get(/** @type {string} */ (req.params.sid));
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
 * @param {string} kind
 * @param {Record<string, any> | null | undefined} config
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

/**
 * Resolve `created_by` ids to `{ id, name }` — best-effort, never fatal.
 * @param {Array<string | null | undefined>} ids
 */
async function resolveCreators(ids) {
    /** @type {Record<string, { id: string, name: string | null }>} */
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

/**
 * camelCase + Number() wire shape, like routes/knowledgeBases/system.js.
 * @param {KbSourceApiRow} source
 * @param {SourceCounts | null | undefined} counts
 * @param {Record<string, { id: string, name: string | null }> | null | undefined} creators
 */
function mapSourceForApi(source, counts, creators) {
    const c = counts || ZERO_COUNTS;
    return {
        id: source.id,
        kind: source.kind,
        name: source.name || '',
        config: publicSourceConfig(source.kind, source.config),
        refreshMode: source.refreshMode || 'manual',
        // An i18n KEY, not a sentence: the client renders it with t(key, fallback).
        refreshLabelKey: /** @type {Readonly<Record<string, string>>} */ (REFRESH_LABEL_KEYS)[source.refreshMode] || REFRESH_LABEL_KEYS.manual,
        refreshCron: source.refreshCron || null,
        refreshTz: source.refreshTz || null,
        // The modes THIS kind actually has. Sent rather than hard-coded in
        // the client, so the schedule menu cannot offer something the PATCH
        // would 400 — a page has no "live", a table has no "after every
        // meeting", and a rejected choice teaches that the product is broken.
        supportsModes: /** @type {Readonly<Record<string, string[]>>} */ (REFRESH_MODES_BY_KIND)[source.kind] || ['manual'],
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
 * One source in its wire shape, with its own counts and creator.
 * @param {KbSourceApiRow} source
 * @param {{ withCounts?: boolean }} [opts]
 */
async function sourceForApi(source, { withCounts = false } = {}) {
    const counts = withCounts ? (await kbStore.countsBySource([source.id]))[source.id] : null;
    return mapSourceForApi(source, counts, await resolveCreators([source.createdBy]));
}

/**
 * The per-install cap on sources. Read from the licence tier; a failure to
 * resolve falls back to the COMMUNITY limit rather than to "unlimited", so a
 * transient licence-store error can never widen an entitlement.
 * @param {Record<string, any>} kb
 * @param {string | null | undefined} userId
 * @returns {Promise<number>} -1 (or any negative) = uncapped
 */
async function maxSourcesFor(kb, userId) {
    const license = require('../../license');
    try {
        const tier = await license.resolveTier({ organizationId: kb.organization_id || null, userId: userId || null });
        const limits = /** @type {{ max_kb_sources?: number }} */ (license.tiers.getLimitsForTier(tier) || {});
        const max = Number(limits.max_kb_sources);
        return Number.isFinite(max) ? max : -1;
    } catch (e) {
        log.warn('[KB] Source limit unresolved, applying the community cap:', /** @type {Error} */ (e).message);
        try {
            const max = Number((license.tiers.getLimitsForTier('community') || {}).max_kb_sources);
            return Number.isFinite(max) ? max : -1;
        } catch (_) {
            return -1;
        }
    }
}

/**
 * A validated `{mode, cron, tz}` → a store patch.
 *
 * The SHAPE is RefreshRule's answer. What is left here is the one rule a body
 * schema cannot state: which modes a KIND admits — and on PATCH that is the
 * kind of the STORED row, which the body never carries.
 * @param {{ mode?: string, cron?: string | null, tz?: string | null } | null | undefined} refresh
 * @param {string} kind
 */
function refreshPatchFor(refresh, kind) {
    if (!refresh) return {};
    /** @type {{ refreshMode?: string, refreshCron?: string | null, refreshTz?: string | null }} */
    const patch = {};
    if (refresh.mode !== undefined) {
        const allowed = Object.prototype.hasOwnProperty.call(REFRESH_MODES_BY_KIND, kind)
            ? /** @type {Readonly<Record<string, string[]>>} */ (REFRESH_MODES_BY_KIND)[kind]
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

module.exports = {
    CREATABLE_KINDS, REFRESH_MODES_BY_KIND, REFRESH_LABEL_KEYS,
    MAX_UPLOAD_FILES, MAX_FILE_BYTES, MAX_TEXT_CHARS, MAX_CRAWL_PAGES, DEFAULT_DOC_PAGE, MAX_DOC_PAGE, QUEUED_REASON,
    shapeTextOrigin, helpers, resolveKb, resolveSource, publicSourceConfig, resolveCreators, mapSourceForApi,
    sourceForApi, maxSourcesFor, refreshPatchFor,
};
