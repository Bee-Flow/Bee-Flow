// @typecheck
/**
 * KbSourcesStore — the source entity of a knowledge base (K1).
 *
 * A source is *where* a knowledge base's documents come from: an upload
 * bucket, a pasted text, a crawled webpage, a Nextcloud folder, a datatable,
 * a meeting-notes tag, an automation step, or a `legacy` wrapper for rows
 * that predate the model. Documents hang off a source through
 * `documents.source_id` (FK, ON DELETE CASCADE — see stores/knowledgeBases.js).
 *
 * Naming: the SQL table is `kb_sources`; `kb_sources` is ALSO the name of an
 * SSE event (core/agentRuntime/knowledgeSearch.js) that carries citation
 * chips to the chat UI. In code this store is therefore always called
 * `KbSourcesStore` / `kbSourcesStore` — never rename the event, never call
 * the store "kbSources" in a place where the event name is in scope.
 *
 * Refresh engine contract (K3 consumes it):
 *   claimDue(limit)              — atomic claim (FOR UPDATE SKIP LOCKED); a
 *                                  claimed row flips to status 'refreshing'
 *                                  and is invisible to other replicas until
 *                                  finish() or the stale window elapses.
 *   finish(id, {ok,error,nextRefreshAt})
 *   timeoutStuck(minutes)        — the reaper for crashed workers.
 *
 * Schema ordering: `kb_sources` references `knowledge_bases`, and `documents`
 * references `kb_sources`. stores/knowledgeBases.initDB() therefore calls
 * `ensureSchema()` from this module right after `knowledge_bases` exists and
 * BEFORE it adds `documents.source_id`. The public methods here wait for the
 * parent store (`whenReady()`), so using this store standalone is safe too.
 */

const { run, getOne, getAll, exec } = require('../db');
const { runDdl } = require('./lib/_ddl');
const { buildUpdate } = require('./lib/sqlBuilder');

const SOURCE_KINDS = Object.freeze([
    'upload', 'text', 'webpage', 'nextcloud_folder', 'datatable', 'meeting_tag', 'automation', 'legacy',
]);
const REFRESH_MODES = Object.freeze(['manual', 'schedule', 'on_change', 'after_meeting', 'live']);
const SOURCE_STATUSES = Object.freeze(['idle', 'refreshing', 'error']);

/** Refresh modes that count as "auto-refreshing" in the KB overview pill. */
const AUTO_REFRESH_MODES = Object.freeze(['schedule', 'on_change', 'after_meeting', 'live']);

const DEFAULT_STALE_MINUTES = 15;
const MAX_ERROR_LEN = 500;

let schemaPromise = null;

async function createSchema() {
    await exec(`
        CREATE TABLE IF NOT EXISTS kb_sources (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            knowledge_base_id UUID NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN ('upload','text','webpage','nextcloud_folder','datatable','meeting_tag','automation','legacy')),
            name TEXT NOT NULL DEFAULT '',
            config JSONB NOT NULL DEFAULT '{}'::jsonb,
            refresh_mode TEXT NOT NULL DEFAULT 'manual' CHECK (refresh_mode IN ('manual','schedule','on_change','after_meeting','live')),
            refresh_cron TEXT,
            refresh_tz TEXT,
            next_refresh_at TIMESTAMPTZ,
            last_refresh_started_at TIMESTAMPTZ,
            last_refresh_at TIMESTAMPTZ,
            last_refresh_error TEXT,
            consecutive_errors INT NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','refreshing','error')),
            created_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
    /**
     * Cooperative cancellation (K3). A refresh that is walking 400 pages
     * cannot be stopped by deleting its row — the FK cascade would fire under
     * a worker mid-write — and it must not be stopped by killing the process
     * either. So "stop" is a FLAG the running worker reads between documents,
     * which is the only place it can safely stop: everything before it is
     * committed, everything after it has not started.
     *
     * ADD COLUMN IF NOT EXISTS, added after the table shipped, so a rolling
     * deploy where one replica has the column and the other does not is
     * simply a replica that never sees a cancel — not an error.
     */
    // Via runDdl (stores/lib/_ddl.js): fouten per statement luid verzameld
    // i.p.v. stil ingeslikt als "already there".
    await runDdl('kbSources', [
        `ALTER TABLE kb_sources ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT false`,
        `CREATE INDEX IF NOT EXISTS idx_kb_sources_kb ON kb_sources(knowledge_base_id)`,
        // Partial index: the refresh tick only ever asks "what is due", and most
        // sources (manual/live) never carry a next_refresh_at at all.
        `CREATE INDEX IF NOT EXISTS idx_kb_sources_due ON kb_sources(next_refresh_at) WHERE next_refresh_at IS NOT NULL`,
        // `listByAutomation` filters on `config @> {automationId}` and runs on EVERY
        // routine save, from five different paths. GIN over the config, narrowed to
        // the one kind that carries an automationId so the index stays small.
        `CREATE INDEX IF NOT EXISTS idx_kb_sources_automation ON kb_sources USING GIN (config jsonb_path_ops) WHERE kind = 'automation'`,
    ]);
}

/**
 * Create the kb_sources table. Idempotent, memoised. Requires
 * `knowledge_bases` to exist — call from knowledgeBases.initDB(), or rely on
 * initDB() below which waits for the parent first.
 */
function ensureSchema() {
    if (!schemaPromise) {
        schemaPromise = createSchema().catch((e) => { schemaPromise = null; throw e; });
    }
    return schemaPromise;
}

async function initDB() {
    // The parent store creates knowledge_bases + documents and calls
    // ensureSchema() at the right point in its own init; waiting on it here
    // makes standalone use (jobs, tests) order-safe without a require cycle
    // at load time (the require is lazy and knowledgeBases never waits on us).
    const parent = require('./knowledgeBases');
    if (typeof parent.whenReady === 'function') await parent.whenReady();
    await ensureSchema();
}

function toIso(v) {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString();
    return v;
}

/** Map a kb_sources row to the camelCase shape routes and jobs consume. */
function mapRow(r) {
    if (!r) return null;
    let config = r.config;
    if (typeof config === 'string') { try { config = JSON.parse(config); } catch (_) { config = {}; } }
    return {
        id: r.id,
        knowledgeBaseId: r.knowledge_base_id,
        kind: r.kind,
        name: r.name || '',
        config: config && typeof config === 'object' ? config : {},
        refreshMode: r.refresh_mode || 'manual',
        refreshCron: r.refresh_cron || null,
        refreshTz: r.refresh_tz || null,
        nextRefreshAt: toIso(r.next_refresh_at),
        lastRefreshStartedAt: toIso(r.last_refresh_started_at),
        lastRefreshAt: toIso(r.last_refresh_at),
        lastRefreshError: r.last_refresh_error || null,
        consecutiveErrors: Number(r.consecutive_errors) || 0,
        status: r.status || 'idle',
        cancelRequested: !!r.cancel_requested,
        createdBy: r.created_by || null,
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
    };
}

function invalid(code, message) {
    return Object.assign(new Error(message), { code, status: 400 });
}

function assertKind(kind) {
    if (!SOURCE_KINDS.includes(kind)) throw invalid('invalid_kind', `Unknown source kind: ${kind}`);
}
function assertRefreshMode(mode) {
    if (!REFRESH_MODES.includes(mode)) throw invalid('invalid_refresh_mode', `Unknown refresh mode: ${mode}`);
}
function assertStatus(status) {
    if (!SOURCE_STATUSES.includes(status)) throw invalid('invalid_status', `Unknown source status: ${status}`);
}

function toJsonb(config) {
    return JSON.stringify(config && typeof config === 'object' ? config : {});
}

/**
 * The writable columns of a source. `kind` and `knowledge_base_id` are absent
 * on purpose: neither may move once the source exists.
 */
const SOURCE_COLUMNS = {
    name: { col: 'name', transform: v => String(v || '').slice(0, 200) },
    config: { col: 'config', cast: 'jsonb', transform: toJsonb },
    refreshMode: 'refresh_mode',
    refreshCron: { col: 'refresh_cron', transform: v => v || null },
    refreshTz: { col: 'refresh_tz', transform: v => v || null },
    nextRefreshAt: { col: 'next_refresh_at', transform: v => v || null },
    status: 'status',
    lastRefreshError: { col: 'last_refresh_error', transform: v => (v ? String(v).slice(0, MAX_ERROR_LEN) : null) },
    consecutiveErrors: { col: 'consecutive_errors', transform: v => Math.max(0, parseInt(v, 10) || 0) },
};

const KbSourcesStore = {
    SOURCE_KINDS,
    REFRESH_MODES,
    SOURCE_STATUSES,
    AUTO_REFRESH_MODES,
    initDB,
    ensureSchema,
    mapRow,

    /**
     * @param {object} p
     * @param {string} p.knowledgeBaseId
     * @param {string} p.kind - one of SOURCE_KINDS
     * @param {string} [p.name='']
     * @param {object} [p.config={}] - kind-specific; the route layer decides which part is public
     * @param {string} [p.refreshMode='manual']
     * @param {string|null} [p.refreshCron]
     * @param {string|null} [p.refreshTz]
     * @param {Date|string|null} [p.nextRefreshAt]
     * @param {string|null} [p.createdBy] - user id
     */
    create: async ({ knowledgeBaseId, kind, name = '', config = {}, refreshMode = 'manual', refreshCron = null, refreshTz = null, nextRefreshAt = null, createdBy = null }) => {
        await initDB();
        if (!knowledgeBaseId) throw invalid('kb_required', 'knowledgeBaseId is required');
        assertKind(kind);
        assertRefreshMode(refreshMode);
        const row = await getOne(
            `INSERT INTO kb_sources
                (knowledge_base_id, kind, name, config, refresh_mode, refresh_cron, refresh_tz, next_refresh_at, created_by)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
             RETURNING *`,
            [knowledgeBaseId, kind, String(name || '').slice(0, 200), toJsonb(config), refreshMode,
             refreshCron || null, refreshTz || null, nextRefreshAt || null, createdBy || null],
        );
        return mapRow(row);
    },

    get: async (id) => {
        await initDB();
        if (!id) return null;
        return mapRow(await getOne(`SELECT * FROM kb_sources WHERE id = $1`, [id]));
    },

    /**
     * How many sources are in ERROR, for a whole set of knowledge bases.
     *
     * The first cross-KB read in this store, and it exists because Studio Home
     * asks about every base a person can see at once: `listByKb` in a loop is
     * one query per base, and the only other multi-row reader here is
     * `claimDue`, which is the worker's atomic claim and not a read at all.
     *
     * IT AUTHORISES NOTHING. The ids ARE the authorisation — the caller resolves
     * which bases this reader may see (listKBs + filterByGroupAccess) and hands
     * those in, exactly as automationStore.getRunCountsForProjects takes project
     * ids that were checked before it was called. Passing an id nobody checked
     * would count a stranger's sources.
     *
     * A base with no failing source is ABSENT from the map rather than 0: the
     * caller turns a missing key into "none" and a rejected promise into
     * "unknown", and those must not be the same value. So this REJECTS rather
     * than returning an empty map — a screen that reads a failure as "nothing is
     * wrong" is the bug this shape exists to prevent.
     *
     * @param {string[]} kbIds
     * @returns {Promise<Map<string, number>>} kb id → failing source count (> 0)
     */
    countErrorSourcesByKb: async (kbIds) => {
        await initDB();
        const ids = (Array.isArray(kbIds) ? kbIds : []).filter(id => typeof id === 'string' && id);
        if (ids.length === 0) return new Map();
        const rows = await getAll(
            `SELECT knowledge_base_id, COUNT(*)::int AS n
               FROM kb_sources
              WHERE knowledge_base_id = ANY($1::uuid[]) AND status = 'error'
              GROUP BY knowledge_base_id`,
            [ids],
        );
        return new Map((rows || []).map(r => [String(r.knowledge_base_id), Number(r.n) || 0]));
    },

    listByKb: async (kbId) => {
        await initDB();
        if (!kbId) return [];
        const rows = await getAll(
            `SELECT * FROM kb_sources WHERE knowledge_base_id = $1 ORDER BY created_at ASC, id ASC`,
            [kbId],
        );
        return (rows || []).map(mapRow);
    },

    /**
     * Find one source of a kind in a KB, optionally narrowed by a config
     * subset (jsonb containment of `match` in `config`) — the wrapper routes use this to reuse "the"
     * upload source of a KB or "the" webpage source for a URL.
     * @param {string} kbId
     * @param {string} kind
     * @param {object} [opts]
     * @param {object} [opts.configMatch] - JSON subset the config must contain
     */
    findOne: async (kbId, kind, { configMatch = null } = {}) => {
        await initDB();
        if (!kbId) return null;
        assertKind(kind);
        const params = [kbId, kind];
        let where = `knowledge_base_id = $1 AND kind = $2`;
        if (configMatch && typeof configMatch === 'object') {
            params.push(JSON.stringify(configMatch));
            where += ` AND config @> $3::jsonb`;
        }
        return mapRow(await getOne(`SELECT * FROM kb_sources WHERE ${where} ORDER BY created_at ASC LIMIT 1`, params));
    },

    /**
     * Every `automation` source a routine owns, across knowledge bases.
     *
     * The reverse of `findOne(kbId, 'automation', {automationId})`: that
     * answers "does THIS base have a source for this routine", and cannot
     * answer "which bases does this routine still claim to feed" — which is
     * what `core/kb/kbSourceSync` needs to find the ones a definition dropped.
     */
    listByAutomation: async (automationId) => {
        await initDB();
        if (!automationId) return [];
        const rows = await getAll(
            `SELECT * FROM kb_sources
              WHERE kind = 'automation' AND config @> $1::jsonb
              ORDER BY created_at ASC, id ASC`,
            [JSON.stringify({ automationId })],
        );
        return (rows || []).map(mapRow);
    },

    /**
     * Partial update. Only the listed keys are writable; anything else is
     * ignored (never `kind`, never `knowledge_base_id`). `undefined` keeps the
     * stored value, `null` clears it where the column is nullable.
     */
    update: async (id, patch = {}) => {
        await initDB();
        if (!id) return null;
        // Both validators reject before anything is written, rather than from
        // inside a column transform where a throw would read as a builder bug.
        if (patch.refreshMode !== undefined) assertRefreshMode(patch.refreshMode);
        if (patch.status !== undefined) assertStatus(patch.status);

        const built = buildUpdate({
            table: 'kb_sources',
            updates: patch,
            columnMap: SOURCE_COLUMNS,
            extraSet: ['updated_at = now()'],
            where: [{ col: 'id', value: id }],
            returning: '*',
        });
        if (!built) return KbSourcesStore.get(id);
        const row = await getOne(built.sql, built.params);
        return mapRow(row);
    },

    /** Delete a source. Documents (and, via the store, their chunks) cascade at the DB level. */
    remove: async (id) => {
        await initDB();
        if (!id) return false;
        const r = await run(`DELETE FROM kb_sources WHERE id = $1`, [id]);
        return (r && r.rowCount > 0) || false;
    },

    /**
     * Ask for a refresh "now": sets next_refresh_at = now() so the next tick
     * claims it. A source mid-refresh is left alone (the running pass will
     * pick up the change on its own; re-queueing would double-run it).
     * Returns the row, or null when unknown.
     */
    requestRefresh: async (id) => {
        await initDB();
        if (!id) return null;
        const row = await getOne(
            `UPDATE kb_sources
                SET next_refresh_at = LEAST(COALESCE(next_refresh_at, now()), now()),
                    updated_at = now()
              WHERE id = $1
              RETURNING *`,
            [id],
        );
        return mapRow(row);
    },

    /**
     * Atomically claim up to `limit` due sources for this process/replica.
     *
     * A row is due when next_refresh_at <= now() and it is not being refreshed
     * by a live worker — "live" meaning status 'refreshing' with a
     * last_refresh_started_at inside the stale window. FOR UPDATE SKIP LOCKED
     * on the candidate set means two replicas ticking at the same instant
     * split the backlog instead of both taking the same rows.
     *
     * @param {number} [limit=10]
     * @param {object} [opts]
     * @param {number} [opts.staleMinutes=15] - a claim older than this is reclaimable
     * @returns {Promise<object[]>} mapped rows, now in status 'refreshing'
     */
    claimDue: async (limit = 10, { staleMinutes = DEFAULT_STALE_MINUTES } = {}) => {
        await initDB();
        const n = Math.max(1, Math.min(500, parseInt(limit, 10) || 10));
        const staleMs = Math.max(1, Number(staleMinutes) || DEFAULT_STALE_MINUTES) * 60 * 1000;
        const staleBefore = new Date(Date.now() - staleMs).toISOString();
        const rows = await getAll(
            `UPDATE kb_sources s
                SET status = 'refreshing',
                    last_refresh_started_at = now(),
                    -- A claim starts a NEW pass, so a cancel left over from
                    -- the previous one must not stop it before it begins.
                    cancel_requested = false,
                    updated_at = now()
              WHERE s.id IN (
                    SELECT id FROM kb_sources
                     WHERE next_refresh_at IS NOT NULL
                       AND next_refresh_at <= now()
                       AND (status <> 'refreshing'
                            OR last_refresh_started_at IS NULL
                            OR last_refresh_started_at < $2)
                     ORDER BY next_refresh_at ASC
                     LIMIT $1
                     FOR UPDATE SKIP LOCKED)
              RETURNING s.*`,
            [n, staleBefore],
        );
        return (rows || []).map(mapRow);
    },

    /**
     * Release a claim, recording the outcome.
     *
     * @param {string} id
     * @param {object} [p]
     * @param {boolean} [p.ok] - true → status 'idle', streak reset, last_refresh_at = now()
     * @param {string|Error|null} [p.error] - stored (truncated) when !ok
     * @param {Date|string|null} [p.nextRefreshAt] - when the next pass is due; null for manual/live
     */
    finish: async (id, { ok, error = null, nextRefreshAt = null } = {}) => {
        await initDB();
        if (!id) return null;
        const success = !!ok;
        const errText = success
            ? null
            : String((error && /** @type {any} */ (error).message) || error || 'Refresh failed').slice(0, MAX_ERROR_LEN);
        const row = await getOne(
            `UPDATE kb_sources
                SET status = $2,
                    last_refresh_started_at = NULL,
                    last_refresh_at = CASE WHEN $3 THEN now() ELSE last_refresh_at END,
                    last_refresh_error = $4,
                    consecutive_errors = CASE WHEN $3 THEN 0 ELSE consecutive_errors + 1 END,
                    next_refresh_at = $5,
                    updated_at = now()
              WHERE id = $1
              RETURNING *`,
            [id, success ? 'idle' : 'error', success, errText, nextRefreshAt || null],
        );
        return mapRow(row);
    },

    /**
     * Per-KB aggregates for the overview: number of sources, how many refresh
     * on their own, and the most recent successful refresh.
     * @param {string[]} kbIds
     * @returns {Promise<Record<string, {sourceCount:number, autoRefreshCount:number, lastRefreshAt:string|null}>>}
     */
    countsByKb: async (kbIds) => {
        await initDB();
        const ids = Array.from(new Set((kbIds || []).filter(Boolean)));
        /** @type {Record<string, {sourceCount:number, autoRefreshCount:number, lastRefreshAt:string|null}>} */
        const out = {};
        if (ids.length === 0) return out;
        const rows = await getAll(
            `SELECT knowledge_base_id,
                    COUNT(*)::int AS source_count,
                    COUNT(*) FILTER (WHERE refresh_mode = ANY($2))::int AS auto_refresh_count,
                    MAX(last_refresh_at) AS last_refresh_at
               FROM kb_sources
              WHERE knowledge_base_id = ANY($1::uuid[])
              GROUP BY knowledge_base_id`,
            [ids, AUTO_REFRESH_MODES],
        );
        for (const r of rows || []) {
            out[r.knowledge_base_id] = {
                sourceCount: Number(r.source_count) || 0,
                autoRefreshCount: Number(r.auto_refresh_count) || 0,
                lastRefreshAt: toIso(r.last_refresh_at),
            };
        }
        return out;
    },

    /**
     * Ask a running refresh to stop at its next document boundary.
     *
     * Cooperative, and deliberately so: a worker is mid-way through writing
     * chunks for one document, and the only safe place to stop is between
     * documents — everything before it is committed, everything after it has
     * not started. A hard stop would leave a half-embedded document that
     * looks processed.
     *
     * Returns false when the source is not actually refreshing, so a caller
     * can tell "asked" from "there was nothing to ask".
     */
    /**
     * Arm every `meeting_tag` source watching one of these tags.
     *
     * Sets `next_refresh_at = now()` so the refresh job picks them up on its
     * next tick — rather than refreshing inline. A meeting finishing must not
     * make the ingest that saved it wait on an embedding pass, and the job
     * already has the lock, the concurrency limit and the time budget that
     * keep a burst of meetings from becoming a burst of embedding calls.
     *
     * Only sources in `after_meeting` mode. A source somebody deliberately set
     * to `manual` said "I will press the button", and `schedule` said "nightly
     * is fine" — overriding either because a meeting happened would ignore
     * what they asked for.
     *
     * @param {string[]} tags
     * @returns {Promise<number>} how many sources were armed
     */
    armMeetingSources: async (tags) => {
        await initDB();
        const list = Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.trim()) : [];
        if (list.length === 0) return 0;
        // `config->>'tag'` rather than a containment operator: a meeting_tag
        // source watches exactly one tag, stored as a scalar.
        const r = await run(
            `UPDATE kb_sources
                SET next_refresh_at = now(), updated_at = now()
              WHERE kind = 'meeting_tag'
                AND refresh_mode = 'after_meeting'
                AND config->>'tag' = ANY($1::text[])
                AND status <> 'refreshing'`,
            [list],
        );
        return r?.rowCount || 0;
    },

    /**
     * Arm every `live` datatable source watching one table (K8).
     *
     * Same posture as `armMeetingSources`: `next_refresh_at = now()` and let
     * the 60-second tick do the work under the lock and the time budget it
     * already has. Refreshing inline would put an embedding pass inside a
     * datatable write.
     *
     * Only `live` sources. A source set to `schedule` said "nightly is fine"
     * and one set to `manual` said "I will press the button"; a row changing
     * is not a reason to override either.
     *
     * Watching includes POINTING AT: a source whose relation columns resolve
     * their labels from this table (`config.relatedTableIds`, recorded by the
     * pass) is armed too. A supplier renamed or erased in its own table has to
     * change every order document that names it, and none of those rows moved.
     *
     * @returns {Promise<number>} how many sources were armed
     */
    armDatatableSources: async (datatableId) => {
        await initDB();
        if (!datatableId) return 0;
        const r = await run(
            `UPDATE kb_sources
                SET next_refresh_at = now(), updated_at = now()
              WHERE kind = 'datatable'
                AND refresh_mode = 'live'
                AND (config->>'datatableId' = $1
                     OR (jsonb_typeof(config->'relatedTableIds') = 'array' AND config->'relatedTableIds' ? $1))
                AND status <> 'refreshing'`,
            [String(datatableId)],
        );
        return r?.rowCount || 0;
    },

    /**
     * Every `live` datatable source, with the table it watches and the version
     * it last saw — the backstop the refresh tick reads.
     *
     * The write-path hook is in-process: it does not survive a restart, it
     * does not cross a replica, and a write from a job on another pod fires
     * nobody's timer. So the tick compares versions as well, and this is the
     * one query that lets it.
     */
    listLiveDatatableSources: async () => {
        await initDB();
        const rows = await getAll(
            `SELECT id, knowledge_base_id, config, next_refresh_at
               FROM kb_sources
              WHERE kind = 'datatable' AND refresh_mode = 'live' AND status <> 'refreshing'`,
        );
        return (rows || []).map(r => {
            let config = r.config;
            if (typeof config === 'string') { try { config = JSON.parse(config); } catch (_) { config = {}; } }
            const relatedVersions = config?.relatedVersions && typeof config.relatedVersions === 'object'
                ? config.relatedVersions : {};
            return {
                id: r.id,
                knowledgeBaseId: r.knowledge_base_id,
                datatableId: config?.datatableId || null,
                seenDataVersion: Number(config?.dataVersion) || 0,
                // The tables its relation columns point at, and the version
                // each was at when this source last read their labels.
                relatedTableIds: Array.isArray(config?.relatedTableIds) ? config.relatedTableIds.map(String) : [],
                seenRelatedVersions: Object.fromEntries(
                    Object.entries(relatedVersions).map(([k, v]) => [String(k), Number(v) || 0])),
                nextRefreshAt: toIso(r.next_refresh_at),
            };
        });
    },

    /**
     * Record the table version a pass just covered, so the backstop can tell
     * "nothing has changed" from "we have never looked".
     *
     * Merged into `config` rather than given its own column: it is a fact
     * about THIS kind of source, and a column would be NULL on every other.
     *
     * `related` — `{ <tableId>: <dataVersion> }` for the tables the pass
     * resolved relation labels from — is recorded the same way, as
     * `relatedTableIds` (what `armDatatableSources` matches) and
     * `relatedVersions` (what the backstop compares). Passed as null, both are
     * left as they were; passed as `{}`, a source that stopped pointing
     * anywhere stops being armed for tables it no longer reads.
     */
    setSeenDataVersion: async (id, dataVersion, related = null) => {
        await initDB();
        if (!id) return null;
        const patch = { dataVersion: Math.max(0, Number(dataVersion) || 0) };
        if (related && typeof related === 'object') {
            const versions = {};
            for (const [k, v] of Object.entries(related)) {
                if (!k) continue;
                versions[String(k)] = Math.max(0, Number(v) || 0);
            }
            patch.relatedTableIds = Object.keys(versions);
            patch.relatedVersions = versions;
        }
        return mapRow(await getOne(
            `UPDATE kb_sources
                SET config = COALESCE(config, '{}'::jsonb) || $2::jsonb,
                    updated_at = now()
              WHERE id = $1
              RETURNING *`,
            [id, JSON.stringify(patch)],
        ));
    },

    requestCancel: async (id) => {
        await initDB();
        if (!id) return false;
        const r = await run(
            `UPDATE kb_sources SET cancel_requested = true, updated_at = now()
              WHERE id = $1 AND status = 'refreshing'`,
            [id],
        );
        return ((r && r.rowCount) || 0) > 0;
    },

    /**
     * Is a stop pending? Read fresh from the row on purpose — the worker
     * holds a snapshot from when it claimed, and the whole point is to see a
     * decision somebody made after that.
     */
    isCancelRequested: async (id) => {
        await initDB();
        if (!id) return false;
        const row = await getOne(`SELECT cancel_requested FROM kb_sources WHERE id = $1`, [id]);
        return !!row?.cancel_requested;
    },

    /**
     * Reaper: a source stuck in 'refreshing' longer than `minutes` belongs to a
     * worker that died. Flip it to 'error' with a streak bump; next_refresh_at
     * is left as-is so a scheduled source is simply retried on the next tick.
     * @returns {Promise<number>} rows reset
     */
    timeoutStuck: async (minutes = DEFAULT_STALE_MINUTES) => {
        await initDB();
        const ms = Math.max(1, Number(minutes) || DEFAULT_STALE_MINUTES) * 60 * 1000;
        const staleBefore = new Date(Date.now() - ms).toISOString();
        const r = await run(
            `UPDATE kb_sources
                SET status = 'error',
                    last_refresh_error = 'Refresh timed out',
                    consecutive_errors = consecutive_errors + 1,
                    last_refresh_started_at = NULL,
                    updated_at = now()
              WHERE status = 'refreshing'
                AND (last_refresh_started_at IS NULL OR last_refresh_started_at < $1)`,
            [staleBefore],
        );
        return (r && r.rowCount) || 0;
    },
};

module.exports = KbSourcesStore;

// Awaitbare init-ingang voor migrateDb.
module.exports.initDB = initDB;
