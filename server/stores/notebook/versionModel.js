// @typecheck
/**
 * stores/notebook/versionModel.js — the notebook version model: sources,
 * limits, normalisers and row mappers (no database access).
 * Split out of stores/notebookStore.js.
 */

const crypto = require('crypto');

// ── Version Control ─────────────────────────────────────────────────
//
// The uniform version model (shared with Studio documents): a version is the
// state AFTER a checkpoint, numbered per notebook (`seq`), tagged with why it
// exists (`source`) and who contributed to it. Content is kept as HTML and,
// when known, the Markdown mirror. Rows from before this model are "before"
// snapshots with source 'legacy'.

/** Why a version exists. */
const VERSION_SOURCES = Object.freeze([
    'created', 'checkpoint', 'autosave', 'named', 'ai', 'restore', 'pre_restore', 'conflict', 'import', 'legacy',
]);
/** Never pruned: they mark a moment somebody will look for. */
const PROTECTED_SOURCES = Object.freeze(['created', 'named', 'restore', 'pre_restore']);
/**
 * Snapshots that are skipped when nothing changed since the latest version
 * (the latest one is returned instead). A conflict copy identical to the
 * latest version loses nothing by pointing at it. Restores are explicit acts
 * and always get their own row; naming the state the newest version already
 * holds names that version (recordVersion).
 */
const DEDUPED_SOURCES = new Set(['checkpoint', 'autosave', 'ai', 'pre_restore', 'import', 'created', 'conflict']);

// Unprotected versions kept per notebook. Retention thinning (keep all for 48 h,
// then hourly, daily, weekly) runs separately; this cap is the backstop.
const MAX_VERSIONS_PER_NOTEBOOK = 200;
const AUTO_VERSION_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const VERSION_NAME_MAX = 80;
const MAX_CONTRIBUTORS = 50;
const MAX_STATS_JSON = 4000;

// The labels the old routes wrote into `summary`, read as a source.
const LEGACY_SUMMARY_SOURCES = {
    'Auto-save': 'autosave',
    'Before AI edit': 'checkpoint',
    'Before restore': 'pre_restore',
    'Manual snapshot': 'named',
};

/** sha256 of the stored HTML: identical snapshots are recognised by it. */
function contentHash(html) {
    return crypto.createHash('sha256').update(String(html || ''), 'utf8').digest('hex');
}

/**
 * Contributors as stored: `[{userId|null, kind:'user'|'ai', agentId?}]`, ids
 * only, deduplicated, capped. Anything else in an entry is dropped.
 */
function normalizeContributors(list) {
    const out = [];
    const seen = new Set();
    for (const c of Array.isArray(list) ? list : []) {
        if (!c || typeof c !== 'object') continue;
        const kind = c.kind === 'ai' ? 'ai' : 'user';
        const userId = typeof c.userId === 'string' && c.userId ? c.userId.slice(0, 200) : null;
        const agentId = typeof c.agentId === 'string' && c.agentId ? c.agentId.slice(0, 200) : undefined;
        if (kind === 'user' && !userId) continue;
        const key = `${kind}|${userId || ''}|${agentId || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(agentId ? { userId, kind, agentId } : { userId, kind });
        if (out.length >= MAX_CONTRIBUTORS) break;
    }
    return out;
}

/** Counts only (words added/removed, blocks changed); oversized or odd input is dropped. */
function normalizeStats(stats) {
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
    const out = {};
    for (const [k, v] of Object.entries(stats)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        else if (typeof v === 'boolean') out[k] = v;
    }
    const json = JSON.stringify(out);
    return json.length > MAX_STATS_JSON || json === '{}' ? null : out;
}

/** A version name: trimmed, one line, at most 80 characters; empty is none. */
function normalizeVersionName(name) {
    if (name == null) return null;
    const clean = String(name).replace(/\s+/g, ' ').trim().slice(0, VERSION_NAME_MAX);
    return clean || null;
}

const VERSION_META_COLUMNS = `id, notebook_id, seq, source, name, summary, created_by, contributors, stats,
    pinned, restored_from, content_hash, content_length, created_at`;

function mapVersionMeta(r) {
    return {
        id: r.id,
        notebookId: r.notebook_id,
        seq: r.seq == null ? null : (parseInt(r.seq, 10) || null),
        source: VERSION_SOURCES.includes(r.source) ? r.source : 'legacy',
        name: r.name || null,
        // The free-text label the old routes wrote; kept for the rows that have one.
        summary: r.summary || '',
        createdBy: r.created_by || null,
        contributors: normalizeContributors(parseJSONValue(r.contributors, [])),
        stats: parseJSONValue(r.stats, null),
        pinned: !!r.pinned,
        restoredFrom: r.restored_from || null,
        contentLength: parseInt(r.content_length) || 0,
        createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    };
}

function mapVersionRow(r) {
    return {
        ...mapVersionMeta(r),
        // `content` stays the HTML for the callers written before the uniform shape.
        content: r.content || '',
        html: r.content || '',
        markdown: r.content_md != null ? r.content_md : null,
    };
}

/** JSONB arrives parsed from pg and as text from some drivers. */
function parseJSONValue(v, fallback) {
    if (v == null) return fallback;
    if (typeof v === 'object') return v;
    try { return JSON.parse(v); } catch { return fallback; }
}

module.exports = {
    VERSION_SOURCES,
    PROTECTED_SOURCES,
    DEDUPED_SOURCES,
    MAX_VERSIONS_PER_NOTEBOOK,
    AUTO_VERSION_DEBOUNCE_MS,
    VERSION_NAME_MAX,
    LEGACY_SUMMARY_SOURCES,
    contentHash,
    normalizeContributors,
    normalizeStats,
    normalizeVersionName,
    VERSION_META_COLUMNS,
    mapVersionMeta,
    mapVersionRow,
};
